import { env } from "cloudflare:workers";
import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { changes, record, recordStatement } from "~/activity/activity.server";
import { type OrganisationScope, organisationScope, organisations, users, uuidv7 } from "~/db";
import { locksEntries, PeriodStatus, periodAfter, periodContaining } from "~/periods/periods";
import { addDays, bounds, type Day, dayOf } from "~/time/calendar";
import { zoneOf } from "~/time/zones";

import { autoLock, type Deadline, deadlineOf } from "./deadline";
import { type LockNotice, type LockReason, lockOf } from "./locks";

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
 * Why each of `days` is locked for `userId`'s entries and expenses, for the
 * days that are: on or before the organisation's lock date, or in a period of
 * theirs that is submitted or approved. A day that is not locked is not in
 * the map. An entry belongs to the local day it starts in, in its person's
 * zone, so a change is refused when the day it starts on, before or after the
 * change, is here.
 */
export async function lockReasonsOn(
	scope: OrganisationScope,
	userId: string,
	days: readonly Day[],
): Promise<Map<Day, LockReason>> {
	if (days.length === 0) return new Map();
	const sorted = [...days].sort();
	const first = sorted[0] as Day;
	const last = sorted.at(-1) as Day;
	const [lockedThrough, periods] = await Promise.all([
		lockDateOf(scope.organisationId),
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
		kind === "time_entry" ? inArray(s.timeEntryId, [...ids]) : inArray(s.expenseId, [...ids]),
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
	const moved = await writeLockDate(organisation.id, actor, before, {
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
 * Returns whether it was written.
 */
async function writeLockDate(
	organisationId: string,
	actor: Actor,
	before: Day | null,
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
				eq(organisations.id, organisationId),
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
		organisationScope(env.DB, organisationId),
		actor.userId,
		"lock_date.changed",
		{ type: "organisation", id: organisationId, ownerId: null },
		{
			before: { lockedThrough: before },
			after: {
				lockedThrough: next.lockedThrough,
				...(next.lockReason ? { reason: next.lockReason } : {}),
			},
		},
		next.source,
	);
	return true;
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
 * Submits, as the system, every period that ends on or before `through` and
 * holds time of one of the organisation's members, and is neither submitted
 * nor approved (TS-065). Only periods that end after the earlier lock date,
 * `since`, are looked at: those before it were locked already. A period that
 * runs past `through` is left to its person. Each is recorded as submitted
 * by the system: no actor, source `system`. Returns how many were submitted.
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
	const people = await drizzle(env.DB)
		.select({ id: users.id, timeZone: users.timeZone })
		.from(users)
		.where(
			inArray(
				users.id,
				members.map((m) => m.userId),
			),
		);
	const at = new Date(now);
	let submitted = 0;
	for (const person of people) {
		const zone = zoneOf(person, organisation);
		// The last period that ends on or before `through`.
		const holding = periodContaining(through, organisation.weekStartsOn);
		const last = holding.endsOn > through ? periodAfter(holding, -1) : holding;
		const firstDay =
			since === null
				? null
				: periodContaining(addDays(since, 1), organisation.weekStartsOn).startsOn;
		if (firstDay !== null && firstDay > last.startsOn) continue;
		const to = bounds(last.endsOn, last.endsOn, zone).to;
		const from = firstDay === null ? null : bounds(firstDay, firstDay, zone).from;
		const entries = await scope.timeEntries.select((e) =>
			and(
				eq(e.userId, person.id),
				lt(e.startedAt, new Date(to)),
				from === null ? undefined : gte(e.startedAt, new Date(from)),
			),
		);
		const starts = new Set(
			entries.map(
				(e) => periodContaining(dayOf(e.startedAt, zone), organisation.weekStartsOn).startsOn,
			),
		);
		if (starts.size === 0) continue;
		const rows = await scope.periods.select((p) =>
			and(eq(p.userId, person.id), inArray(p.startsOn, [...starts])),
		);
		for (const startsOn of [...starts].sort()) {
			const row = rows.find((r) => r.startsOn === startsOn);
			const status = row ? PeriodStatus.parse(row.status) : null;
			if (locksEntries(status)) continue;
			const id = row?.id ?? uuidv7();
			const period = periodContaining(startsOn, organisation.weekStartsOn);
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
						userId: person.id,
						startsOn: period.startsOn,
						endsOn: period.endsOn,
						status: "submitted",
						submittedAt: at,
					});
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
					{ type: "period", id, ownerId: person.id },
					changes({ status }, { status: "submitted" }, ["status"]),
					"system",
				),
			]);
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
		const written = await writeLockDate(row.id, { userId: null }, settings.lockedThrough, {
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
