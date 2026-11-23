import { env } from "cloudflare:workers";
import { and, eq, gte, inArray, isNotNull, isNull, lte, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { changes, record, recordStatement } from "~/activity/activity.server";
import {
	among,
	type OrganisationScope,
	organisationScope,
	organisations,
	users,
	uuidv7,
} from "~/db";
import { dayStatus } from "~/leave/days";
import { calendarOf, leaveContext, someoneElseDecides } from "~/leave/leave.server";
import { locksEntries, PeriodStatus, periodContaining, periodOfDay } from "~/periods/periods";
import { approvedAlone } from "~/periods/submission.server";
import { addDays, type Day, dayOf, daysFrom, startOfDay } from "~/time/calendar";
import { stopBySystem } from "~/time/entries.server";

import { autoLock, type Deadline, deadlineOf } from "./deadline";
import { type LockNotice, type LockReason, lockOf, lockReachOf } from "./locks";

/**
 * The lock date and the deadline as the server reads and writes them
 * (TS-065), and the locks every writer asks about (`app/locks/locks.ts` says
 * why an item is locked). Each writer of entries, expenses and leave asks
 * `lockReasonsOn` (or `lockedDays` in `app/periods/locks.server.ts`, which
 * reads it) before it writes, and `invoicedIds` for an item that exists.
 */

/** The longest reason given for setting or moving back the lock date. */
export const LOCK_REASON_MAX_LENGTH = 200;

/** An organisation's lock and deadline, as Workspace settings shows them. */
export interface LockSettings {
	lockedThrough: Day | null;
	lockReason: string | null;
	deadline: Deadline;
	autoLockDays: number | null;
	autoSubmitAtLock: boolean;
	autoLockedThrough: Day | null;
}

const LOCK_COLUMNS = {
	lockedThrough: organisations.lockedThrough,
	lockReason: organisations.lockReason,
	deadlineKind: organisations.deadlineKind,
	deadlineDay: organisations.deadlineDay,
	deadlineTime: organisations.deadlineTime,
	autoLockDays: organisations.autoLockDays,
	autoSubmitAtLock: organisations.autoSubmitAtLock,
	autoLockedThrough: organisations.autoLockedThrough,
} as const;

type LockRow = {
	lockedThrough: string | null;
	lockReason: string | null;
	deadlineKind: string;
	deadlineDay: number | null;
	deadlineTime: string | null;
	autoLockDays: number | null;
	autoSubmitAtLock: boolean;
	autoLockedThrough: string | null;
};

function settingsOf(row: LockRow): LockSettings {
	return {
		lockedThrough: row.lockedThrough,
		lockReason: row.lockReason,
		deadline: deadlineOf(row),
		autoLockDays: row.autoLockDays,
		autoSubmitAtLock: row.autoSubmitAtLock,
		autoLockedThrough: row.autoLockedThrough,
	};
}

/** The lock and deadline of the organisation `organisationId`, read on this request. */
export async function lockSettingsOf(organisationId: string): Promise<LockSettings> {
	const [row] = await drizzle(env.DB)
		.select(LOCK_COLUMNS)
		.from(organisations)
		.where(eq(organisations.id, organisationId))
		.limit(1);
	if (!row) throw new Error("No organisation has that id.");
	return settingsOf(row);
}

/** The lock date of the organisation `organisationId`, or null when it has none. */
export async function lockDateOf(organisationId: string): Promise<Day | null> {
	const [row] = await drizzle(env.DB)
		.select({ lockedThrough: organisations.lockedThrough })
		.from(organisations)
		.where(eq(organisations.id, organisationId))
		.limit(1);
	return row?.lockedThrough ?? null;
}

/** The lock date of `organisationId` and its reason, or null when it has none. */
export async function lockNoticeOf(organisationId: string): Promise<LockNotice | null> {
	const { lockedThrough, lockReason } = await lockSettingsOf(organisationId);
	return lockedThrough === null ? null : { lockedThrough, reason: lockReason };
}

/** The statuses that lock a period's entries, for SQL. */
const LOCKING = PeriodStatus.options.filter(locksEntries);

/**
 * The lock date of `organisationId` as it reaches `userId`'s days at `now`
 * (D7, decision 49): never a day that has not yet ended in their zone.
 */
export async function lockReachFor(
	organisationId: string,
	userId: string,
	now: number,
): Promise<Day | null> {
	const [row] = await drizzle(env.DB)
		.select({
			lockedThrough: organisations.lockedThrough,
			organisationZone: organisations.timeZone,
			ownZone: users.timeZone,
		})
		.from(organisations)
		.leftJoin(users, eq(users.id, userId))
		.where(eq(organisations.id, organisationId))
		.limit(1);
	if (!row) return null;
	return lockReachOf(row.lockedThrough, row.ownZone ?? row.organisationZone, now);
}

/**
 * Why each of `days` is locked for `userId`'s entries and expenses, for the
 * days that are: on or before the organisation's lock date once the day has
 * ended in their zone (`lockReachFor`), or in a period of theirs that is
 * submitted or approved. A day that is not locked is not in the map. An
 * entry belongs to the day stored with it (decision 39), so a change is
 * refused when its day, before or after the change, is here.
 */
export async function lockReasonsOn(
	scope: OrganisationScope,
	userId: string,
	days: readonly Day[],
	now = Date.now(),
): Promise<Map<Day, LockReason>> {
	if (days.length === 0) return new Map();
	const sorted = [...days].sort();
	const first = sorted[0] as Day;
	const last = sorted.at(-1) as Day;
	const [lockedThrough, periods] = await Promise.all([
		lockReachFor(scope.organisationId, userId, now),
		scope.periods.select((p) =>
			and(
				eq(p.userId, userId),
				inArray(p.status, LOCKING),
				lte(p.startsOn, last),
				gte(p.endsOn, first),
			),
		),
	]);
	const reasons = new Map<Day, LockReason>();
	for (const day of days) {
		const period = periods.find(({ startsOn, endsOn }) => startsOn <= day && day <= endsOn);
		const reason = lockOf({
			day,
			lockedThrough,
			periodStatus: period ? PeriodStatus.parse(period.status) : null,
			invoiced: false,
		});
		if (reason !== null) reasons.set(day, reason);
	}
	return reasons;
}

/**
 * The ids among `ids` of the time entries or the expenses that are on an
 * invoice line (`invoice_line_sources`), and so locked until they are
 * released (TS-073).
 */
export async function invoicedIds(
	scope: OrganisationScope,
	kind: "time_entry" | "expense",
	ids: readonly string[],
): Promise<Set<string>> {
	if (ids.length === 0) return new Set();
	const sources = await scope.invoiceLineSources.select((s) =>
		kind === "time_entry" ? among(s.timeEntryId, ids) : among(s.expenseId, ids),
	);
	return new Set(
		sources.flatMap((s) => {
			const id = kind === "time_entry" ? s.timeEntryId : s.expenseId;
			return id === null ? [] : [id];
		}),
	);
}

/** Who sets the lock date: an owner or admin, or the system for auto-lock. */
interface Actor {
	userId: string | null;
}

/** An organisation as the lock's writers need it. */
export interface LockedOrganisation {
	id: string;
	timeZone: string;
	weekStartsOn: number;
}

/** Why the lock date was not set. */
export type NotLocked = "after-today" | "reason-needed" | "stale";

export interface LockChange {
	/** The new lock date, or null to remove it. */
	lockedThrough: Day | null;
	/** Why, in the person's words: needed when the date moves back or is removed. */
	reason: string | null;
	/** Whether every unsubmitted period up to the new date is submitted by the system. */
	autoSubmit: boolean;
}

/**
 * Sets, moves or removes the lock date of `organisation`, as `actor`, at
 * `now`. A date after today, in the organisation's zone, is refused; so is
 * moving the date back, or removing it, without a reason. The change and its
 * reason are recorded in the activity log in the same batch, and when
 * `autoSubmit` is set and the date moved forward, the unsubmitted periods up
 * to it are submitted by the system (`submitUnsubmitted`).
 */
export async function setLockDate(
	organisation: LockedOrganisation,
	actor: Actor,
	change: LockChange,
	now: number,
): Promise<{ ok: true; submitted: number } | { ok: false; reason: NotLocked }> {
	const today = dayOf(now, organisation.timeZone);
	if (change.lockedThrough !== null && change.lockedThrough > today) {
		return { ok: false, reason: "after-today" };
	}
	const before = await lockDateOf(organisation.id);
	const back = before !== null && (change.lockedThrough === null || change.lockedThrough < before);
	if (back && !change.reason) return { ok: false, reason: "reason-needed" };
	const moved = await writeLockDate(organisation, actor, before, now, {
		lockedThrough: change.lockedThrough,
		lockReason: change.reason,
		source: "web",
	});
	if (!moved) return { ok: false, reason: "stale" };
	const forward =
		change.lockedThrough !== null && (before === null || change.lockedThrough > before);
	const submitted =
		change.autoSubmit && forward && change.lockedThrough !== null
			? await submitUnsubmitted(organisation, before, change.lockedThrough, now)
			: 0;
	return { ok: true, submitted };
}

/**
 * Writes the lock date, only if it is still `before`, so a second change at
 * the same moment does not overwrite the first, and then records the change.
 * When the date moves forward, every timer of the organisation running on a
 * day it now reaches is stopped by the system at `now` (TR-02,
 * `stopTimersReached`). Returns whether it was written.
 */
async function writeLockDate(
	organisation: Pick<LockedOrganisation, "id" | "timeZone">,
	actor: Actor,
	before: Day | null,
	now: number,
	next: {
		lockedThrough: Day | null;
		lockReason: string | null;
		source: "web" | "system";
		autoLockedThrough?: Day;
	},
): Promise<boolean> {
	const updated = await drizzle(env.DB)
		.update(organisations)
		.set({
			lockedThrough: next.lockedThrough,
			lockReason: next.lockReason,
			...(next.autoLockedThrough === undefined
				? {}
				: { autoLockedThrough: next.autoLockedThrough }),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(organisations.id, organisation.id),
				before === null
					? isNull(organisations.lockedThrough)
					: eq(organisations.lockedThrough, before),
			),
		)
		.returning({ id: organisations.id });
	if (updated.length === 0) return false;
	// The reason is an owner's or admin's account of a decision about the
	// organisation, kept with it (docs/security.md, "The activity log").
	await record(
		organisationScope(env.DB, organisation.id),
		actor.userId,
		"lock_date.changed",
		{ type: "organisation", id: organisation.id, ownerId: null },
		{
			before: { lockedThrough: before },
			after: {
				lockedThrough: next.lockedThrough,
				...(next.lockReason ? { reason: next.lockReason } : {}),
			},
		},
		next.source,
	);
	if (next.lockedThrough !== null && (before === null || next.lockedThrough > before)) {
		await stopTimersReached(organisation, next.lockedThrough, now, now);
	}
	return true;
}

/** The zone each of `userIds` counts their days in: their own, else the organisation's. */
async function zonesOf(
	userIds: readonly string[],
	organisationZone: string,
): Promise<Map<string, string>> {
	const ids = [...new Set(userIds)];
	if (ids.length === 0) return new Map();
	const rows = await drizzle(env.DB)
		.select({ id: users.id, timeZone: users.timeZone })
		.from(users)
		.where(among(users.id, ids));
	return new Map(rows.map((row) => [row.id, row.timeZone ?? organisationZone]));
}

/**
 * Stops, as the system, every timer of `organisation` running on a day the
 * lock date `lockedThrough` reaches at `now` (TR-02): a day on or before it
 * that has ended where the timer's person is (D7, decision 49). Each is
 * stopped at `movedAt`, the instant the date moved over it; or, where its day
 * ended after the date moved (`movedAt` null), at the end of its day, when
 * the lock date reached it. It is cut at its day's limit as any timer is. A
 * timer on a day the date has not reached runs on. Returns how many stopped.
 */
async function stopTimersReached(
	organisation: Pick<LockedOrganisation, "id" | "timeZone">,
	lockedThrough: Day,
	now: number,
	movedAt: number | null,
): Promise<number> {
	const scope = organisationScope(env.DB, organisation.id);
	const running = await scope.timeEntries.select((e) =>
		and(isNull(e.endedAt), lte(e.spentOn, lockedThrough)),
	);
	if (running.length === 0) return 0;
	const zones = await zonesOf(
		running.map((e) => e.userId),
		organisation.timeZone,
	);
	let stopped = 0;
	for (const entry of running) {
		const zone = zones.get(entry.userId) ?? organisation.timeZone;
		const ended = startOfDay(addDays(entry.spentOn, 1), zone);
		if (ended > now) continue;
		const at = Math.max(movedAt ?? ended, entry.startedAt.getTime());
		if (await stopBySystem(scope, entry.userId, entry.id, at)) stopped++;
	}
	return stopped;
}

/** What Workspace settings sends for the deadline and auto-lock. */
export interface DeadlineChange {
	deadline: Deadline;
	autoLockDays: number | null;
	autoSubmitAtLock: boolean;
}

/** The deadline as the organisation's columns hold it. */
function deadlineColumns(deadline: Deadline) {
	return {
		deadlineKind: deadline.kind,
		deadlineDay:
			deadline.kind === "weekly"
				? deadline.weekday
				: deadline.kind === "monthly"
					? deadline.day
					: null,
		deadlineTime: deadline.kind === "none" ? null : deadline.time,
	};
}

const DEADLINE_FIELDS = [
	"deadlineKind",
	"deadlineDay",
	"deadlineTime",
	"autoLockDays",
	"autoSubmitAtLock",
] as const;

/** Sets the deadline, auto-lock and auto-submit of `organisationId`, and records the change. */
export async function setDeadline(
	organisationId: string,
	actor: Actor,
	change: DeadlineChange,
): Promise<void> {
	const columns = {
		...deadlineColumns(change.deadline),
		// Auto-lock waits on a deadline: with none, it is off, as Harvest has it.
		autoLockDays: change.deadline.kind === "none" ? null : change.autoLockDays,
		autoSubmitAtLock: change.autoSubmitAtLock,
	};
	const before = await lockSettingsOf(organisationId);
	const db = drizzle(env.DB);
	await db.batch([
		db
			.update(organisations)
			.set({ ...columns, updatedAt: new Date() })
			.where(eq(organisations.id, organisationId)),
		recordStatement(
			organisationScope(env.DB, organisationId),
			actor.userId,
			"deadline.changed",
			{ type: "organisation", id: organisationId, ownerId: null },
			changes(
				{
					...deadlineColumns(before.deadline),
					autoLockDays: before.autoLockDays,
					autoSubmitAtLock: before.autoSubmitAtLock,
				},
				columns,
				DEADLINE_FIELDS,
			),
		).query,
	]);
}

/**
 * Submits, as the system, every period of the organisation's members that
 * holds time and whose deadline has passed: one whose days with expected
 * hours are all on or before the lock date `through` as it reaches its
 * person at `now` (TR-15; D7, decision 49), and that is neither submitted nor
 * approved (TS-065). A returned week stays with its person, with its reason
 * (TR-07), and a week in which a timer of theirs still runs on a day the date
 * has not reached is left to them. Only weeks from the one holding the
 * earlier lock date, `since`, are looked at: those before it were locked
 * already. A period is found by range before one is drawn (TR-12). Each is
 * recorded as submitted by the system: no actor, source `system`; a week
 * nobody else may approve is approved by the system too (D5, decision 47).
 * Returns how many were submitted.
 */
export async function submitUnsubmitted(
	organisation: LockedOrganisation,
	since: Day | null,
	through: Day,
	now: number,
): Promise<number> {
	const scope = organisationScope(env.DB, organisation.id);
	const members = await scope.memberships.select();
	if (members.length === 0) return 0;
	const ids = members.map((m) => m.userId);
	const firstDay =
		since === null ? null : periodContaining(since, organisation.weekStartsOn).startsOn;
	const lastDay = periodContaining(through, organisation.weekStartsOn).endsOn;
	const entries = await scope.timeEntries.select((e) =>
		and(
			among(e.userId, ids),
			lte(e.spentOn, lastDay),
			firstDay === null ? undefined : gte(e.spentOn, firstDay),
		),
	);
	if (entries.length === 0) return 0;
	const people = [...new Set(entries.map((e) => e.userId))];
	const earliest = entries.map((e) => e.spentOn).sort()[0] as Day;
	const [zones, rows, context] = await Promise.all([
		zonesOf(people, organisation.timeZone),
		scope.periods.select((p) =>
			and(among(p.userId, people), lte(p.startsOn, lastDay), gte(p.endsOn, earliest)),
		),
		leaveContext(scope, people, earliest, lastDay),
	]);
	const at = new Date(now);
	let submitted = 0;
	for (const userId of people) {
		const reach = lockReachOf(through, zones.get(userId) ?? organisation.timeZone, now);
		if (reach === null) continue;
		const calendar = calendarOf(context, userId);
		const theirs = entries.filter((e) => e.userId === userId);
		const periods = rows
			.filter((r) => r.userId === userId)
			.map((r) => ({ id: r.id, startsOn: r.startsOn, endsOn: r.endsOn, status: r.status }));
		const seen = new Set<Day>();
		for (const day of [...new Set(theirs.map((e) => e.spentOn))].sort()) {
			const { period, row } = periodOfDay(periods, day, organisation.weekStartsOn);
			if (seen.has(period.startsOn)) continue;
			seen.add(period.startsOn);
			if (period.startsOn > reach) continue;
			const open = period.endsOn > reach ? daysFrom(addDays(reach, 1), period.endsOn) : [];
			if (open.some((d) => dayStatus(calendar, d).expectedMinutes > 0)) continue;
			const status = row ? PeriodStatus.parse(row.status) : null;
			if (locksEntries(status) || status === "returned") continue;
			const running = theirs.some(
				(e) => e.endedAt === null && e.spentOn > reach && e.spentOn <= period.endsOn,
			);
			if (running) continue;
			const id = row?.id ?? uuidv7();
			const write = row
				? scope.periods.statements.update(
						{
							status: "submitted",
							submittedAt: at,
							decidedBy: null,
							decidedAt: null,
							comment: null,
						},
						(p) => and(eq(p.id, id), eq(p.status, row.status)),
					)
				: scope.periods.statements.insert({
						id,
						userId,
						startsOn: period.startsOn,
						endsOn: period.endsOn,
						status: "submitted",
						submittedAt: at,
					});
			const alone = !(await someoneElseDecides(scope, userId));
			await scope.batch([
				write,
				scope.periodEvents.statements.insert({
					periodId: id,
					action: "submitted",
					actorId: null,
					comment: null,
				}),
				recordStatement(
					scope,
					null,
					"period.submitted",
					{ type: "period", id, ownerId: userId },
					changes({ status }, { status: "submitted" }, ["status"]),
					"system",
				),
				...(alone ? approvedAlone(scope, id, userId, at) : []),
			]);
			if (!row) periods.push({ ...period, id, status: "submitted" });
			submitted++;
		}
	}
	return submitted;
}

/**
 * Auto-lock for every organisation that has it on, at `now` (the scheduled
 * handler, `workers/scheduled.ts`). Returns how many lock dates moved.
 */
export async function runAutoLock(now: number): Promise<number> {
	const rows = await drizzle(env.DB)
		.select({
			id: organisations.id,
			timeZone: organisations.timeZone,
			weekStartsOn: organisations.weekStartsOn,
			...LOCK_COLUMNS,
		})
		.from(organisations)
		.where(and(ne(organisations.deadlineKind, "none"), isNotNull(organisations.autoLockDays)));
	let moved = 0;
	for (const row of rows) {
		const settings = settingsOf(row);
		const step = autoLock(settings, row.timeZone, now);
		if (step === null) continue;
		const forward = settings.lockedThrough === null || step.lockedThrough > settings.lockedThrough;
		if (!forward) {
			// The date is already past this deadline: only remember it was reached.
			await drizzle(env.DB)
				.update(organisations)
				.set({ autoLockedThrough: step.deadline })
				.where(eq(organisations.id, row.id));
			continue;
		}
		const written = await writeLockDate(row, { userId: null }, settings.lockedThrough, now, {
			lockedThrough: step.lockedThrough,
			lockReason: null,
			source: "system",
			autoLockedThrough: step.deadline,
		});
		if (!written) continue;
		moved++;
		if (settings.autoSubmitAtLock) {
			await submitUnsubmitted(row, settings.lockedThrough, step.lockedThrough, now);
		}
	}
	return moved;
}

/**
 * The lock date reaching days as they end (D7, decision 49), run every hour
 * by the scheduled handler after auto-lock. A lock date reaches a person's
 * day only once that day has ended where they are, so a date set to today,
 * or moved by auto-lock in the organisation's zone, reaches some people's
 * days after it moved. For every organisation whose lock date is recent
 * enough for that, this stops each timer on a day it has now reached, at the
 * end of that day (TR-02), and, where auto-submit is on, submits the weeks
 * whose deadline has now passed (TR-15).
 */
export async function runLockReach(now: number): Promise<void> {
	// No zone is more than a day behind UTC: a lock date two days old has reached everyone.
	const recent = addDays(dayOf(now, "UTC"), -2);
	const rows = await drizzle(env.DB)
		.select({
			id: organisations.id,
			timeZone: organisations.timeZone,
			weekStartsOn: organisations.weekStartsOn,
			lockedThrough: organisations.lockedThrough,
			autoSubmitAtLock: organisations.autoSubmitAtLock,
		})
		.from(organisations)
		.where(gte(organisations.lockedThrough, recent));
	for (const row of rows) {
		if (row.lockedThrough === null) continue;
		await stopTimersReached(row, row.lockedThrough, now, null);
		if (row.autoSubmitAtLock) {
			await submitUnsubmitted(row, addDays(row.lockedThrough, -2), row.lockedThrough, now);
		}
	}
}
