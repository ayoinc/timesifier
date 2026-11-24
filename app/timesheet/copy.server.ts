import { and, eq, gte, isNull, lte } from "drizzle-orm";

import { changes, recordStatement } from "~/activity/activity.server";
import { type OrganisationScope, uuidv7 } from "~/db";
import { daysOf } from "~/leave/leave.server";
import { refusalOf } from "~/leave/rules.server";
import { lockedDays } from "~/periods/locks.server";
import { type PeriodDays, periodAfter } from "~/periods/periods";
import { teamRules } from "~/projects/teams.server";
import { packageRules } from "~/projects/work-packages.server";
import { entryTagStatements, tagsOfEntries } from "~/tags/tags.server";
import { entryTaskOf } from "~/tasks/tasks.server";
import { addDays, type Day, dayOf, daysFrom } from "~/time/calendar";
import { formatDay } from "~/time/format";
import { gridEntryStart, placeOnDay } from "~/time/grid";
import { ENTRY_FIELDS, entriesOfDay, subject } from "~/time/manual.server";

import { formatDuration } from "./durations";

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
 *
 * Each copy is the kind its entry was, regular or overtime (decision 56),
 * within the rules of the day it lands on: where that day does not take the
 * overtime, the regular entries are copied and the overtime is left out, and
 * the copy says so (TR-18e). Copy week names each day it leaves, and why.
 *
 * A copy goes to its entry's work package (TS-115b, `packageRules`): an entry
 * whose work package has closed since, or one on no work package of a project
 * that now has an open one, is not copied, as new time it would be refused.
 *
 * Where only a project's team tracks to it (TS-115c, `teamRules`), an entry
 * is copied only onto a day the person is on its project's team; the others
 * are left out, and the copy says how many and why.
 */

/** How far back a copy looks: three weeks (Harvest's "Copy your last timesheet"). */
export const COPY_LOOKBACK_DAYS = 21;

/** One entry to copy: what it was, and the day it was on. */
export interface CopySource {
	id: string;
	day: Day;
	projectId: string;
	taskId: string | null;
	description: string | null;
	startedAt: number;
	lengthMs: number;
	/** Whether it is overtime (TS-095): its copy is too, where the day takes it. */
	overtime: boolean;
	/** Its work package (TS-115b): its copy goes to it, while it is open. */
	workPackageId: string | null;
}

/** The person's ended entries on active projects from `first` to `last`, earliest first. */
async function sourcesIn(
	scope: OrganisationScope,
	userId: string,
	first: Day,
	last: Day,
): Promise<CopySource[]> {
	const [rows, active] = await Promise.all([
		scope.timeEntries.select((e) =>
			and(eq(e.userId, userId), gte(e.spentOn, first), lte(e.spentOn, last)),
		),
		scope.projects.select((p) => isNull(p.archivedAt)),
	]);
	const live = new Set(active.map((p) => p.id));
	return rows
		.filter((row) => row.endedAt !== null && live.has(row.projectId))
		.map((row) => ({
			id: row.id,
			day: row.spentOn,
			projectId: row.projectId,
			taskId: row.taskId,
			description: row.description,
			startedAt: row.startedAt.getTime(),
			lengthMs: (row.endedAt as Date).getTime() - row.startedAt.getTime(),
			overtime: row.overtime,
			workPackageId: row.workPackageId,
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
): Promise<{ day: Day; entries: CopySource[] } | null> {
	const first = addDays(day, -COPY_LOOKBACK_DAYS);
	const last = addDays(day, -1);
	const [sources, statuses] = await Promise.all([
		sourcesIn(scope, userId, first, last),
		daysOf(scope, userId, first, last),
	]);
	const working = new Set(
		statuses
			.filter((s) => s.is.kind === "working" || (s.is.kind === "leave" && s.is.halves === 1))
			.map((s) => s.day),
	);
	for (const candidate of daysFrom(first, last).reverse()) {
		if (!working.has(candidate)) continue;
		const entries = sources.filter((s) => s.day === candidate);
		if (entries.length > 0) return { day: candidate, entries };
	}
	return null;
}

/** The week `period` copies from: the latest of the three before it with ended entries on active projects. */
export async function copySourceWeek(
	scope: OrganisationScope,
	userId: string,
	period: PeriodDays,
): Promise<{ period: PeriodDays; entries: CopySource[] } | null> {
	const oldest = periodAfter(period, -3);
	const sources = await sourcesIn(scope, userId, oldest.startsOn, addDays(period.startsOn, -1));
	for (const back of [1, 2, 3]) {
		const week = periodAfter(period, -back);
		const entries = sources.filter((s) => week.startsOn <= s.day && s.day <= week.endsOn);
		if (entries.length > 0) return { period: week, entries };
	}
	return null;
}

type Statement = Parameters<OrganisationScope["batch"]>[0][number];

/**
 * What a copy onto a day leaves out: its overtime, where the day does not
 * take it, with the sentence that says why.
 */
export interface LeftOut {
	day: Day;
	overtimeMs: number;
	why: string;
}

/** What a copy left out, as a sentence: "Its 1:00 of overtime was left out. This organisation does not allow overtime." */
export function leftOutSentence(left: LeftOut, { naming }: { naming: boolean }): string {
	const on = naming ? ` on ${formatDay(left.day, "short")}` : "";
	return `Its ${formatDuration(left.overtimeMs)} of overtime${on} was left out. ${left.why}`;
}

/** What a copy says of the entries it left out because their projects' teams do not have the person on the day. */
export function offTeamSentence(count: number, day: Day, { naming }: { naming: boolean }): string {
	const on = naming ? ` on ${formatDay(day, "short")}` : " on that day";
	return count === 1
		? `1 entry was left out: you are not on its project's team${on}.`
		: `${count} entries were left out: you are not on their projects' teams${on}.`;
}

/** Why a copy onto a day wrote nothing, where every entry's project's team is without the person. */
const NOT_ON_TEAMS =
	"You are not on those entries' projects' teams on that day, so nothing was copied onto it.";

/** Why `day` takes no copy, or the statements that write the copies onto it. */
async function copyOnto(
	scope: OrganisationScope,
	userId: string,
	day: Day,
	given: readonly CopySource[],
	zone: string,
	now: number,
): Promise<
	| {
			ok: true;
			statements: Statement[];
			ids: string[];
			leftOut: LeftOut | null;
			/** How many entries were left out as their projects' teams do not have the person on the day. */
			offTeam: number;
	  }
	| { ok: false; problem: string }
> {
	if ((await entriesOfDay(scope, userId, day)).length > 0) {
		return { ok: false, problem: "That day already has time: nothing was copied onto it." };
	}
	if ((await lockedDays(scope, userId, [day])).size > 0) {
		return { ok: false, problem: "That day is locked: nothing can be copied onto it." };
	}
	const projectIds = given.map((s) => s.projectId);
	const [rules, team] = await Promise.all([
		packageRules(scope, projectIds),
		teamRules(scope, projectIds),
	]);
	const open = given.filter((s) =>
		s.workPackageId === null
			? !rules.required(s.projectId)
			: rules.open(s.projectId, s.workPackageId) !== null,
	);
	if (open.length === 0) {
		return {
			ok: false,
			problem: "Those entries' work packages are closed, so nothing was copied onto that day.",
		};
	}
	const all = open.filter((s) => team.admits(userId, s.projectId, day));
	if (all.length === 0) return { ok: false, problem: NOT_ON_TEAMS };
	const offTeam = open.length - all.length;
	const lengthOf = (entries: readonly CopySource[]) =>
		entries.reduce((sum, s) => sum + s.lengthMs, 0);
	const regularMs = lengthOf(all.filter((s) => !s.overtime));
	const overtimeMs = lengthOf(all.filter((s) => s.overtime));
	// A copy is the kind its entry was (decision 56): regular time must fit,
	// and overtime the day does not take is left out, with why.
	const over =
		regularMs > 0
			? await refusalOf(scope, userId, now, {
					day,
					replaces: null,
					afterMs: regularMs,
					overtime: false,
				})
			: null;
	if (over) return { ok: false, problem: over };
	const overtimeRefused =
		overtimeMs > 0
			? await refusalOf(scope, userId, now, {
					day,
					replaces: null,
					afterMs: overtimeMs,
					overtime: true,
				})
			: null;
	if (overtimeRefused && regularMs === 0) return { ok: false, problem: overtimeRefused };
	const leftOut = overtimeRefused ? { day, overtimeMs, why: overtimeRefused } : null;
	const sources = leftOut ? all.filter((s) => !s.overtime) : all;
	const totalMs = lengthOf(sources);
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
			workPackageId: source.workPackageId,
			billable:
				task.billable && (rules.open(source.projectId, source.workPackageId)?.billable ?? true),
			description: source.description,
			startedAt: new Date(at),
			endedAt: new Date(at + source.lengthMs),
			spentOn: day,
			overtime: source.overtime,
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
	return { ok: true, statements, ids, leftOut, offTeam };
}

/** Copies the entries of the person's last working day with time onto the empty `day`. */
export async function copyDay(
	scope: OrganisationScope,
	userId: string,
	day: Day,
	zone: string,
	now: number,
): Promise<
	| { ok: true; from: Day; ids: string[]; leftOut: LeftOut | null; offTeam: number }
	| { ok: false; problem: string }
> {
	const source = await copySourceDay(scope, userId, day);
	if (!source) return { ok: false, problem: "No working day in the last three weeks has time." };
	const onto = await copyOnto(scope, userId, day, source.entries, zone, now);
	if (!onto.ok) return onto;
	if (onto.statements.length > 0) {
		await scope.batch(onto.statements as [Statement, ...Statement[]]);
	}
	return {
		ok: true,
		from: source.day,
		ids: onto.ids,
		leftOut: onto.leftOut,
		offTeam: onto.offTeam,
	};
}

/**
 * Copies the hours of the last week with time onto the week `period`, each
 * day onto the same day of this week. A day of this week with time, locked,
 * yet to come, or that does not take the time is left as it is; each day left
 * that had time to copy is named with why (TR-18e), and so is overtime a day
 * left out, and so are entries whose projects' teams do not have the person.
 */
export async function copyWeek(
	scope: OrganisationScope,
	userId: string,
	period: PeriodDays,
	zone: string,
	now: number,
): Promise<
	{ ok: true; days: number; ids: string[]; notes: string[] } | { ok: false; problem: string }
> {
	const source = await copySourceWeek(scope, userId, period);
	if (!source) return { ok: false, problem: "No week in the last three has time." };
	const today = dayOf(now, zone);
	const statements: Statement[] = [];
	const ids: string[] = [];
	const notes: string[] = [];
	let days = 0;
	for (const [index, day] of daysFrom(period.startsOn, period.endsOn).entries()) {
		if (day > today) continue;
		const from = addDays(source.period.startsOn, index);
		const ofDay = source.entries.filter((s) => s.day === from);
		if (ofDay.length === 0) continue;
		const onto = await copyOnto(scope, userId, day, ofDay, zone, now);
		if (!onto.ok) {
			notes.push(`${formatDay(day, "short")} was left out. ${onto.problem}`);
			continue;
		}
		if (onto.leftOut) notes.push(leftOutSentence(onto.leftOut, { naming: true }));
		if (onto.offTeam > 0) notes.push(offTeamSentence(onto.offTeam, day, { naming: true }));
		if (onto.ids.length === 0) continue;
		statements.push(...onto.statements);
		ids.push(...onto.ids);
		days++;
	}
	if (statements.length === 0) {
		return {
			ok: false,
			problem: [
				"Nothing was copied: every day with time last week has time, is locked or takes none.",
				...notes,
			].join(" "),
		};
	}
	await scope.batch(statements as [Statement, ...Statement[]]);
	return { ok: true, days, ids, notes };
}
