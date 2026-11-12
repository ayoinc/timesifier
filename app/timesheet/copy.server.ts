import { isNull } from "drizzle-orm";

import { changes, recordStatement } from "~/activity/activity.server";
import { type OrganisationScope, uuidv7 } from "~/db";
import { daysOf } from "~/leave/leave.server";
import { refusalOf } from "~/leave/rules.server";
import { lockedDays } from "~/periods/locks.server";
import { type PeriodDays, periodAfter, periodBounds } from "~/periods/periods";
import { entryTagStatements, tagsOfEntries } from "~/tags/tags.server";
import { entryTaskOf } from "~/tasks/tasks.server";
import { addDays, bounds, type Day, dayOf, daysFrom } from "~/time/calendar";
import { gridEntryStart, placeOnDay } from "~/time/grid";
import { ENTRY_FIELDS, entriesOfDay, subject } from "~/time/manual.server";

import { formatDuration } from "./durations";
import { startingIn } from "./timesheet.server";

/**
 * Copying time forward (taste HT-F): an empty day takes the entries of the
 * person's last working day with time, and a week takes the hours of the last
 * week with time, day by day. Both look back at most three weeks, read the
 * person's own ended entries on active projects only, and never touch a day
 * that already has time, is locked (a submitted or approved week, or on or
 * before the lock date), or does not take the time (leave, a public holiday, a
 * day's limit: TS-090). The copies keep each entry's project, task, tags,
 * description and length, and are laid end to end from 09:00 on their day, as
 * hours typed into the week's grid are (`gridEntryStart`); none ends past the
 * end of its day or past now.
 */

/** How far back a copy looks: three weeks (Harvest's "Copy your last timesheet"). */
export const COPY_LOOKBACK_DAYS = 21;

/** One entry to copy: what it was, without its day. */
export interface CopySource {
	id: string;
	projectId: string;
	taskId: string | null;
	description: string | null;
	startedAt: number;
	lengthMs: number;
}

/** The person's ended entries on active projects from `first` to `last`, earliest first. */
async function sourcesIn(
	scope: OrganisationScope,
	userId: string,
	span: { from: number; to: number },
): Promise<CopySource[]> {
	const [rows, active] = await Promise.all([
		scope.timeEntries.select(startingIn(userId, span)),
		scope.projects.select((p) => isNull(p.archivedAt)),
	]);
	const live = new Set(active.map((p) => p.id));
	return rows
		.filter((row) => row.endedAt !== null && live.has(row.projectId))
		.map((row) => ({
			id: row.id,
			projectId: row.projectId,
			taskId: row.taskId,
			description: row.description,
			startedAt: row.startedAt.getTime(),
			lengthMs: (row.endedAt as Date).getTime() - row.startedAt.getTime(),
		}))
		.sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * The day an empty `day` copies from: the latest of the 21 days before it that
 * is a working day of the person (a half day of leave counts; a day off, a
 * public holiday and a whole day of leave do not) and has ended entries on
 * active projects; null when there is none.
 */
export async function copySourceDay(
	scope: OrganisationScope,
	userId: string,
	day: Day,
	zone: string,
): Promise<{ day: Day; entries: CopySource[] } | null> {
	const first = addDays(day, -COPY_LOOKBACK_DAYS);
	const last = addDays(day, -1);
	const [sources, statuses] = await Promise.all([
		sourcesIn(scope, userId, bounds(first, last, zone)),
		daysOf(scope, userId, first, last),
	]);
	const working = new Set(
		statuses
			.filter((s) => s.is.kind === "working" || (s.is.kind === "leave" && s.is.halves === 1))
			.map((s) => s.day),
	);
	for (const candidate of daysFrom(first, last).reverse()) {
		if (!working.has(candidate)) continue;
		const entries = sources.filter((s) => dayOf(s.startedAt, zone) === candidate);
		if (entries.length > 0) return { day: candidate, entries };
	}
	return null;
}

/** The week `period` copies from: the latest of the three before it with ended entries on active projects. */
export async function copySourceWeek(
	scope: OrganisationScope,
	userId: string,
	period: PeriodDays,
	zone: string,
): Promise<{ period: PeriodDays; entries: CopySource[] } | null> {
	const oldest = periodAfter(period, -3);
	const sources = await sourcesIn(
		scope,
		userId,
		periodBounds({ startsOn: oldest.startsOn, endsOn: addDays(period.startsOn, -1) }, zone),
	);
	for (const back of [1, 2, 3]) {
		const week = periodAfter(period, -back);
		const entries = sources.filter((s) => {
			const day = dayOf(s.startedAt, zone);
			return week.startsOn <= day && day <= week.endsOn;
		});
		if (entries.length > 0) return { period: week, entries };
	}
	return null;
}

type Statement = Parameters<OrganisationScope["batch"]>[0][number];

/** Why `day` takes no copy, or the statements that write the copies onto it. */
async function copyOnto(
	scope: OrganisationScope,
	userId: string,
	day: Day,
	sources: readonly CopySource[],
	zone: string,
	now: number,
): Promise<{ ok: true; statements: Statement[]; ids: string[] } | { ok: false; problem: string }> {
	if ((await entriesOfDay(scope, userId, day, zone)).length > 0) {
		return { ok: false, problem: "That day already has time: nothing was copied onto it." };
	}
	if ((await lockedDays(scope, userId, [day])).size > 0) {
		return { ok: false, problem: "That day is locked: nothing can be copied onto it." };
	}
	const totalMs = sources.reduce((sum, s) => sum + s.lengthMs, 0);
	const over = await refusalOf(scope, userId, zone, now, {
		day,
		replaces: null,
		afterMs: totalMs,
	});
	if (over) return { ok: false, problem: over };
	const tags = await tagsOfEntries(
		scope,
		sources.map((s) => s.id),
	);
	// The copies go end to end from 09:00, earlier where they would end past now.
	const placed = placeOnDay(
		day,
		zone,
		gridEntryStart(day, zone, [], now),
		Math.ceil(totalMs / 60_000),
		now,
	);
	if (!placed.fits) {
		return {
			ok: false,
			problem: `Those entries take ${formatDuration(totalMs)}, more than that day has had so far.`,
		};
	}
	let at = placed.start;
	const statements: Statement[] = [];
	const ids: string[] = [];
	for (const source of sources) {
		const task = await entryTaskOf(scope, source.projectId, undefined, source.taskId);
		if (!task.ok) continue;
		const added = {
			id: uuidv7(),
			userId,
			projectId: source.projectId,
			taskId: task.taskId,
			billable: task.billable,
			description: source.description,
			startedAt: new Date(at),
			endedAt: new Date(at + source.lengthMs),
		};
		statements.push(
			scope.timeEntries.statements.insert(added),
			...entryTagStatements(scope, added.id, [], tags.get(source.id) ?? []),
			recordStatement(
				scope,
				userId,
				"time_entry.created",
				subject(userId, added.id),
				changes(null, added, ENTRY_FIELDS),
			),
		);
		ids.push(added.id);
		at += source.lengthMs;
	}
	return { ok: true, statements, ids };
}

/** Copies the entries of the person's last working day with time onto the empty `day`. */
export async function copyDay(
	scope: OrganisationScope,
	userId: string,
	day: Day,
	zone: string,
	now: number,
): Promise<{ ok: true; from: Day; ids: string[] } | { ok: false; problem: string }> {
	const source = await copySourceDay(scope, userId, day, zone);
	if (!source) return { ok: false, problem: "No working day in the last three weeks has time." };
	const onto = await copyOnto(scope, userId, day, source.entries, zone, now);
	if (!onto.ok) return onto;
	if (onto.statements.length > 0) {
		await scope.batch(onto.statements as [Statement, ...Statement[]]);
	}
	return { ok: true, from: source.day, ids: onto.ids };
}

/**
 * Copies the hours of the last week with time onto the week `period`, each
 * day onto the same day of this week. A day of this week with time, locked,
 * yet to come, or that does not take the time is left as it is.
 */
export async function copyWeek(
	scope: OrganisationScope,
	userId: string,
	period: PeriodDays,
	zone: string,
	now: number,
): Promise<{ ok: true; days: number; ids: string[] } | { ok: false; problem: string }> {
	const source = await copySourceWeek(scope, userId, period, zone);
	if (!source) return { ok: false, problem: "No week in the last three has time." };
	const today = dayOf(now, zone);
	const statements: Statement[] = [];
	const ids: string[] = [];
	let days = 0;
	for (const [index, day] of daysFrom(period.startsOn, period.endsOn).entries()) {
		if (day > today) continue;
		const from = addDays(source.period.startsOn, index);
		const ofDay = source.entries.filter((s) => dayOf(s.startedAt, zone) === from);
		if (ofDay.length === 0) continue;
		const onto = await copyOnto(scope, userId, day, ofDay, zone, now);
		if (!onto.ok || onto.ids.length === 0) continue;
		statements.push(...onto.statements);
		ids.push(...onto.ids);
		days++;
	}
	if (statements.length === 0) {
		return {
			ok: false,
			problem: "Nothing was copied: every day with time last week has time, is locked or takes none.",
		};
	}
	await scope.batch(statements as [Statement, ...Statement[]]);
	return { ok: true, days, ids };
}
