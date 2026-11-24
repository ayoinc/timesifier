import { and, eq, isNull } from "drizzle-orm";

import type { ActivitySource } from "~/activity/actions";
import { changes, recordStatement, recordStatementWhen } from "~/activity/activity.server";
import { type OrganisationScope, type ScopedStatement, uuidv7 } from "~/db";
import { stopSplitOf, timerStartOf } from "~/leave/rules.server";
import { lockedDays } from "~/periods/locks.server";
import { findActiveProject } from "~/projects/projects.server";
import { entryTeamOf } from "~/projects/teams.server";
import { entryPackageOf } from "~/projects/work-packages.server";
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
 * stop is recorded in the activity log, by the person whose entry it is, or
 * by nobody when the system stops it.
 *
 * An entry's day, `spentOn`, is written when it is tracked: the day it
 * starts on in the person's zone at that moment (TS-111, decision 39), and is
 * not worked out again when it stops.
 *
 * A timer of regular time that runs past its day's expected hours is cut
 * where they were used as it stops (TS-095): the rest becomes an entry of
 * overtime where the day takes overtime; where it takes none, the entry is
 * kept whole and the day is over. The overtime keeps the day the timer
 * started on, even past midnight. The cut is worked out before anything is
 * written, and the end, the remainder and their records go in one batch
 * (TR-09), so no entry is ever ended and left uncut, and nothing can put it on
 * an invoice in between.
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

/** A timer as it stopped: its entry as it ended, and the entry of overtime cut from it, if any. */
export interface StoppedTimer {
	ended: Entry;
	rest: Entry | null;
}

/** Who ends a timer, and through which door: the person, or nobody for the system (TS-064). */
export interface StoppedBy {
	/** Who the activity log names; null for the system. */
	actorId: string | null;
	source: ActivitySource;
}

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
	/** The work package chosen (TS-115b); required while the project has an open one. */
	workPackageId?: string | null;
	/** Through which door the start came (TS-064). */
	source?: ActivitySource;
}

/**
 * Starts a timer for `userId` on an active project of the organisation. A
 * running entry is stopped at the same instant in the same batch, cut at its
 * day's limit (`endingOf`). Refused when the project is archived or not the
 * organisation's, or when the day the new entry starts on or the day the
 * running one started on is in a submitted or approved period, and when
 * today takes no more time: a public holiday, whole-day leave, or nothing
 * left of its regular time and no overtime to be had (`timerStartOf`), and
 * when the task is not on the project's list or a tag is not active, and
 * when the project has an open work package and none open of it is named
 * (TS-115b), and, where tracking is by assignment, when the person is not
 * on the project's team today (TS-115c). The new entry is overtime when today has no regular time left.
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
	const wp = await entryPackageOf(scope, projectId, start.workPackageId ?? null);
	if (!wp.ok) return { ok: false as const, reason: wp.reason };
	// Where tracking is by assignment, only a person on the project's team today (TS-115c).
	const team = await entryTeamOf(scope, userId, projectId, dayOf(now, zone));
	if (!team.ok) return { ok: false as const, reason: team.reason };
	const billable = task.billable && wp.billable;
	if (start.tagIds && !(await tagsAllowed(scope, [], start.tagIds))) {
		return { ok: false as const, reason: "no-tag" as const };
	}
	const at = new Date(now);
	const id = uuidv7();
	const ending = running ? await endingOf(scope, running, now, { actorId: userId, source }) : null;
	// The running entry ends first: one entry of a person runs at a time.
	const before = ending?.statements ?? [];
	const [first, ...rest] = [
		...before,
		scope.timeEntries.statements.insert({
			id,
			userId,
			projectId,
			taskId: task.taskId,
			workPackageId: wp.workPackageId,
			billable,
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
			{ type: "time_entry", ownerId: userId, id },
			changes(
				null,
				{
					projectId,
					taskId: task.taskId,
					workPackageId: wp.workPackageId,
					billable,
					description,
					startedAt: at,
					overtime: verdict.overtime,
				},
				[
					"projectId",
					"taskId",
					"workPackageId",
					"billable",
					"description",
					"startedAt",
					"overtime",
				],
			),
			source,
		),
	] as ScopedStatement<unknown>[];
	if (!first) throw new Error("A start writes at least its entry.");
	const results = await scope.batch([first, ...rest]);
	const [started] = results[before.length] as Entry[];
	if (!started) throw new Error("The new entry was not returned.");
	const [stopped] = ending ? (results[ending.endsAt] as Entry[]) : [];
	return { ok: true as const, started, stopped: stopped ?? null };
}

/**
 * Stops the running entry of `userId` at `now`, cut at its day's limit
 * (`endingOf`), and returns it as it ends, with the entry of overtime cut from
 * it, if any; null when nothing was running. `by` names who stopped it: the
 * person, or nobody for a stop the system makes. Two stops at once end it
 * once: the second finds it ended, writes nothing and answers null.
 */
export async function stopTimer(
	scope: OrganisationScope,
	userId: string,
	now: number,
	by: StoppedBy = { actorId: userId, source: "web" },
): Promise<StoppedTimer | null> {
	const running = await runningEntry(scope, userId);
	if (!running) return null;
	const ending = await endingOf(scope, running, now, by);
	const [first, ...rest] = ending.statements;
	if (!first) return null;
	const results = await scope.batch([first, ...rest]);
	const [ended] = results[ending.endsAt] as Entry[];
	if (!ended) return null;
	return { ended, rest: ending.rest };
}

/**
 * Stops the running entry `entryId` of `userId` at `at`, as the system: the
 * lock date has reached its day (TR-02). It is recorded as stopped with no
 * actor and source `system`, and cut at its day's limit as any timer is
 * (`stopTimer`). Returns the timer as it stopped; null when that entry no
 * longer ran.
 */
export async function stopBySystem(
	scope: OrganisationScope,
	userId: string,
	entryId: string,
	at: number,
): Promise<StoppedTimer | null> {
	// A timer started since the lock date's run read this one runs on.
	const running = await runningEntry(scope, userId);
	if (running?.id !== entryId) return null;
	return stopTimer(scope, userId, at, { actorId: null, source: "system" });
}

/**
 * The statements that end `running` at `now`, cut at its day's limit (TS-095,
 * `stopSplitOf`), and record it, worked out before any is sent. Where the day
 * takes overtime, an entry of regular time that ran past what the day had
 * left ends where it was used, and an entry of overtime, of the same project,
 * task, description and tags, runs from there to `now`; one wholly past the
 * limit becomes overtime. Every statement holds only while `running` is still
 * running as the batch reaches it, and the end comes last, so two endings at
 * once write one end, one remainder and one set of records. `endsAt` is the
 * index of the statement that answers the entry as it ends.
 */
async function endingOf(
	scope: OrganisationScope,
	running: Entry,
	now: number,
	by: StoppedBy,
): Promise<{ statements: ScopedStatement<unknown>[]; endsAt: number; rest: Entry | null }> {
	const { id, userId } = running;
	const end = new Date(now);
	const cut = running.overtime
		? { overtime: true, overtimeFrom: null }
		: await stopSplitOf(scope, userId, {
				id,
				startedAt: running.startedAt.getTime(),
				endedAt: now,
				day: running.spentOn,
			});
	const stillRunning = scope.timeEntries.exists((e) =>
		and(eq(e.id, id), eq(e.userId, userId), isNull(e.endedAt)),
	);
	const subject = { type: "time_entry", id, ownerId: userId } as const;
	const statements: ScopedStatement<unknown>[] = [
		recordStatementWhen(
			scope,
			stillRunning,
			by.actorId,
			"time_entry.stopped",
			subject,
			changes({ endedAt: null }, { endedAt: end }, ["endedAt"]),
			by.source,
		),
	];
	// Wholly past the limit: the entry becomes overtime as it ends.
	const wholly = !running.overtime && cut.overtime && cut.overtimeFrom === null;
	if (wholly) {
		statements.push(
			recordStatementWhen(
				scope,
				stillRunning,
				by.actorId,
				"time_entry.split",
				subject,
				changes({ overtime: false }, { overtime: true }, ["overtime"]),
				by.source,
			),
		);
	}
	let rest: Entry | null = null;
	let endsAt = end;
	if (cut.overtimeFrom !== null) {
		endsAt = new Date(cut.overtimeFrom);
		const tags = (await tagsOfEntries(scope, [id])).get(id) ?? [];
		const remainder = {
			id: uuidv7(),
			userId,
			projectId: running.projectId,
			taskId: running.taskId,
			workPackageId: running.workPackageId,
			billable: running.billable,
			description: running.description,
			startedAt: endsAt,
			spentOn: running.spentOn,
			endedAt: end,
			overtime: true,
		};
		rest = { ...running, ...remainder };
		const written = scope.timeEntries.exists((e) => eq(e.id, remainder.id));
		statements.push(
			scope.timeEntries.statements.insertWhen(remainder, stillRunning),
			...tags.map((tagId) =>
				scope.entryTags.statements.insertWhen({ timeEntryId: remainder.id, tagId }, written),
			),
			recordStatementWhen(
				scope,
				stillRunning,
				by.actorId,
				"time_entry.split",
				subject,
				changes({ endedAt: end }, { endedAt: endsAt }, ["endedAt"]),
				by.source,
			),
			recordStatementWhen(
				scope,
				written,
				by.actorId,
				"time_entry.created",
				{ ...subject, id: remainder.id },
				changes(null, remainder, [
					"projectId",
					"taskId",
					"workPackageId",
					"billable",
					"description",
					"startedAt",
					"endedAt",
					"overtime",
				]),
				by.source,
			),
		);
	}
	// The end comes last: every statement before it still sees the entry running.
	statements.push(
		scope.timeEntries.statements.update(
			{ endedAt: endsAt, ...(wholly ? { overtime: true } : {}) },
			(e) => and(eq(e.id, id), eq(e.userId, userId), isNull(e.endedAt)),
		),
	);
	return { statements, endsAt: statements.length - 1, rest };
}
