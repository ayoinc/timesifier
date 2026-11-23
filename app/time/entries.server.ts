import { and, eq, isNull } from "drizzle-orm";

import type { ActivitySource } from "~/activity/actions";
import { changes, record, recordStatement } from "~/activity/activity.server";
import { type OrganisationScope, uuidv7 } from "~/db";
import { stopSplitOf, timerStartOf } from "~/leave/rules.server";
import { lockedDays } from "~/periods/locks.server";
import { findActiveProject } from "~/projects/projects.server";
import { entryTagStatements, tagsAllowed, tagsOfEntries } from "~/tags/tags.server";
import { entryTaskOf } from "~/tasks/tasks.server";

import { dayOf } from "./calendar";

/**
 * Time entries: the rules every writer of them shares (docs/decisions.md
 * entry 25). A person has at most one running entry in an organisation, which
 * the partial unique index on `time_entries` holds whatever the code does.
 * Starting while one runs stops it and starts the next in one D1 batch, so the
 * end of one is the start of the other and neither happens alone. Times are
 * the server's clock; a time the browser claims is never used. Each start and
 * stop is recorded in the activity log, by the person whose entry it is.
 *
 * An entry's day, `spentOn`, is written when it is tracked: the day it
 * starts on in the person's zone at that moment (TS-111, decision 39), and is
 * not worked out again when it stops.
 *
 * A timer of regular time that runs past its day's expected hours is cut
 * where they were used, once it stops (TS-095): the rest becomes an entry of
 * overtime, in a second batch with its row in the log, where the day takes
 * overtime; where it takes none, the entry is kept whole and the day is over.
 * The overtime keeps the day the timer started on, even past midnight.
 */

/** The entry of `userId` that is running in the organisation, or null. */
export async function runningEntry(scope: OrganisationScope, userId: string) {
	const [entry] = await scope.timeEntries.select(
		(e) => and(eq(e.userId, userId), isNull(e.endedAt)),
		{ limit: 1 },
	);
	return entry ?? null;
}

/** An entry as the timer reads and writes it. */
type Entry = NonNullable<Awaited<ReturnType<typeof runningEntry>>>;

export interface StartTimer {
	userId: string;
	projectId: string;
	description: string | null;
	/** The person's zone, which decides the day the entry belongs to. */
	zone: string;
	/** The server's clock. */
	now: number;
	/** The task chosen; left out, the project's first active task (TS-066). */
	taskId?: string;
	/** The entry's tags (TS-085). */
	tagIds?: readonly string[];
	/** Through which door the start came (TS-064). */
	source?: ActivitySource;
}

/**
 * Starts a timer for `userId` on an active project of the organisation. A
 * running entry is stopped at the same instant in the same batch, and cut at
 * its day's limit (`splitStopped`). Refused when the project is archived or
 * not the organisation's, or when the day the new entry starts on or the day
 * the running one started on is in a submitted or approved period, and when
 * today takes no more time: a public holiday, whole-day leave, or nothing
 * left of its regular time and no overtime to be had (`timerStartOf`), and
 * when the task is not on the project's list or a tag is not active. The new
 * entry is overtime when today has no regular time left.
 */
export async function startTimer(scope: OrganisationScope, start: StartTimer) {
	const { userId, projectId, description, zone, now } = start;
	if (!(await findActiveProject(scope, projectId))) {
		return { ok: false as const, reason: "no-project" as const };
	}
	const running = await runningEntry(scope, userId);
	const days = [dayOf(now, zone), ...(running ? [running.spentOn] : [])];
	if ((await lockedDays(scope, userId, days)).size > 0) {
		return { ok: false as const, reason: "locked" as const };
	}
	const verdict = await timerStartOf(scope, userId, zone, now);
	if (!verdict.ok)
		return { ok: false as const, reason: "limit" as const, message: verdict.message };
	const source = start.source ?? "web";
	const task = await entryTaskOf(scope, projectId, start.taskId);
	if (!task.ok) return { ok: false as const, reason: "no-task" as const };
	if (start.tagIds && !(await tagsAllowed(scope, [], start.tagIds))) {
		return { ok: false as const, reason: "no-tag" as const };
	}
	const at = new Date(now);
	const id = uuidv7();
	const entry = { type: "time_entry", ownerId: userId } as const;
	const [stopped, [started]] = await scope.batch([
		scope.timeEntries.statements.update({ endedAt: at }, (e) =>
			and(eq(e.userId, userId), isNull(e.endedAt)),
		),
		scope.timeEntries.statements.insert({
			id,
			userId,
			projectId,
			taskId: task.taskId,
			billable: task.billable,
			description,
			startedAt: at,
			spentOn: dayOf(now, zone),
			endedAt: null,
			overtime: verdict.overtime,
		}),
		...entryTagStatements(scope, id, [], start.tagIds ?? []),
		recordStatement(
			scope,
			userId,
			"time_entry.started",
			{ ...entry, id },
			changes(
				null,
				{
					projectId,
					taskId: task.taskId,
					billable: task.billable,
					description,
					startedAt: at,
					overtime: verdict.overtime,
				},
				["projectId", "taskId", "billable", "description", "startedAt", "overtime"],
			),
			source,
		),
		...(running
			? [
					recordStatement(
						scope,
						userId,
						"time_entry.stopped",
						{ ...entry, id: running.id },
						changes({ endedAt: null }, { endedAt: at }, ["endedAt"]),
						source,
					),
				]
			: []),
	]);
	if (!started) throw new Error("The new entry was not returned.");
	const [ended] = stopped;
	if (ended) await splitStopped(scope, ended, source);
	return { ok: true as const, started, stopped: ended ?? null };
}

/**
 * Stops the running entry of `userId` at `now`, cut at its day's limit
 * (`splitStopped`), and returns it as it ends; null when nothing was running.
 */
export async function stopTimer(
	scope: OrganisationScope,
	userId: string,
	now: number,
	source: ActivitySource = "web",
) {
	const [stopped] = await scope.timeEntries.update({ endedAt: new Date(now) }, (e) =>
		and(eq(e.userId, userId), isNull(e.endedAt)),
	);
	if (!stopped) return null;
	await record(
		scope,
		userId,
		"time_entry.stopped",
		{ type: "time_entry", id: stopped.id, ownerId: userId },
		changes({ endedAt: null }, { endedAt: stopped.endedAt }, ["endedAt"]),
		source,
	);
	return (await splitStopped(scope, stopped, source)) ?? stopped;
}

/**
 * Cuts an entry of regular time, just stopped, at its day's limit (TS-095,
 * `stopSplitOf`): it ends where the day's expected hours were used, and an
 * entry of overtime, of the same project, task, description and tags, runs
 * from there to its end. One wholly past the limit becomes overtime. Returns
 * the entry as it now is, or null when nothing changed.
 */
async function splitStopped(
	scope: OrganisationScope,
	stopped: Entry,
	source: ActivitySource,
): Promise<Entry | null> {
	if (stopped.overtime || stopped.endedAt === null) return null;
	const { userId, endedAt } = stopped;
	const cut = await stopSplitOf(scope, userId, {
		id: stopped.id,
		startedAt: stopped.startedAt.getTime(),
		endedAt: endedAt.getTime(),
		day: stopped.spentOn,
	});
	if (cut.overtimeFrom === null && !cut.overtime) return null;
	const subject = { type: "time_entry", id: stopped.id, ownerId: userId } as const;
	if (cut.overtimeFrom === null) {
		const [[changed]] = await scope.batch([
			scope.timeEntries.statements.update({ overtime: true }, (e) =>
				and(eq(e.id, stopped.id), eq(e.userId, userId)),
			),
			recordStatement(
				scope,
				userId,
				"time_entry.split",
				subject,
				changes({ overtime: false }, { overtime: true }, ["overtime"]),
				source,
			),
		]);
		return changed ?? null;
	}
	const from = new Date(cut.overtimeFrom);
	const tags = (await tagsOfEntries(scope, [stopped.id])).get(stopped.id) ?? [];
	const rest = {
		id: uuidv7(),
		userId,
		projectId: stopped.projectId,
		taskId: stopped.taskId,
		billable: stopped.billable,
		description: stopped.description,
		startedAt: from,
		spentOn: stopped.spentOn,
		endedAt,
		overtime: true,
	};
	const [[changed]] = await scope.batch([
		scope.timeEntries.statements.update({ endedAt: from }, (e) =>
			and(eq(e.id, stopped.id), eq(e.userId, userId)),
		),
		scope.timeEntries.statements.insert(rest),
		...entryTagStatements(scope, rest.id, [], tags),
		recordStatement(
			scope,
			userId,
			"time_entry.split",
			subject,
			changes({ endedAt }, { endedAt: from }, ["endedAt"]),
			source,
		),
		recordStatement(
			scope,
			userId,
			"time_entry.created",
			{ ...subject, id: rest.id },
			changes(null, rest, [
				"projectId",
				"taskId",
				"billable",
				"description",
				"startedAt",
				"endedAt",
				"overtime",
			]),
			source,
		),
	]);
	return changed ?? null;
}
