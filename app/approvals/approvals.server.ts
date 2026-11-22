import { env } from "cloudflare:workers";
import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { changes, recordStatement } from "~/activity/activity.server";
import { among, type OrganisationScope, organisationScope, users, waitingFor } from "~/db";
import { halvesCovered } from "~/leave/days";
import { daysOverOf } from "~/leave/rules.server";
import { lockDateOf, lockReachFor } from "~/locks/locks.server";
import {
	type Access,
	isAdministrator,
	mayDecidePeriodOf,
	mayReopenPeriods,
} from "~/organisations/access";
import { type Membership, viewerOf } from "~/organisations/membership.server";
import { nameOrEmail } from "~/organisations/people";
import { type PeriodDays, PeriodStatus, periodOfWeek, statusAfter } from "~/periods/periods";
import { canSee } from "~/shell/destinations";
import { type Person, peopleOf } from "~/teams/people.server";
import { addDays, type Day, dayOf } from "~/time/calendar";
import { zoneOf } from "~/time/zones";

import { overLimitLabel } from "./words";

/**
 * Approvals (TS-047): the periods people submit, decided one period at a
 * time. Whose periods a person decides is `mayDecidePeriodOf` in
 * `access.ts`: an owner or admin everyone's, a manager the members of the
 * teams they manage, and nobody their own (D5, decision 47). A week with a
 * day over its limit is approved only when the approver confirms it, and a
 * week in which its person's timer still runs is not approved at all
 * (TR-01, TR-02); a week on days the lock date has reached is neither
 * returned nor reopened (TR-07). Every decision changes the period
 * through `statusAfter` and records who took it and when in `period_events`
 * and in the activity log, in one D1 batch, so neither is written without
 * the other.
 */

/** The people whose periods `access` decides, and so is shown on Approvals. */
export async function decidablePeople(
	scope: OrganisationScope,
	organisation: { timeZone: string },
	access: Access,
): Promise<Person[]> {
	const people = isAdministrator(access.role)
		? await peopleOf(scope, organisation)
		: await peopleOf(scope, organisation, access.managed);
	return people.filter((person) => mayDecidePeriodOf(access, person.id));
}

export interface PendingPeriod {
	id: string;
	person: Person;
	submittedAt: number;
	/** Whether the system submitted it, at the lock date, rather than its person (TR-01). */
	bySystem: boolean;
	/** What Submit would have refused: "Over by 7:30 on Tue 10"; null when no day is over (TR-01). */
	overLimit: string | null;
}

export interface DecidedPeriod {
	id: string;
	person: Person;
	status: "approved" | "returned";
	decidedBy: string;
	decidedAt: number;
	comment: string | null;
}

export interface PeriodApprovals {
	pending: PendingPeriod[];
	/** The people who have not submitted the period, once it has closed; null while it is open. */
	notSubmitted: Person[] | null;
	decided: DecidedPeriod[];
}

/**
 * The periods of `people` that start on `period.startsOn`, sorted into
 * pending, not submitted and decided. `today` is the viewer's: a period is
 * closed when its last day is before it.
 */
export async function approvalsFor(
	scope: OrganisationScope,
	people: readonly Person[],
	period: PeriodDays,
	today: Day,
): Promise<PeriodApprovals> {
	const ids = people.map((p) => p.id);
	const [overlapping, joined] =
		ids.length === 0
			? [[], []]
			: await Promise.all([
					scope.periods.select((p) =>
						and(
							among(p.userId, ids),
							lte(p.startsOn, period.endsOn),
							gte(p.endsOn, period.startsOn),
						),
					),
					scope.memberships.select((m) => among(m.userId, ids)),
				]);
	// Each person's period for the week, found by range (TR-12).
	const rows = ids.flatMap((id) => {
		const { row } = periodOfWeek(
			overlapping.filter((p) => p.userId === id),
			period,
		);
		return row ? [row] : [];
	});
	const waiting = rows.filter((row) => row.status === "submitted");
	const [over, bySystem] = await Promise.all([
		daysOverOf(scope, waiting, Date.now()),
		submittedBySystem(
			scope,
			waiting.map((row) => row.id),
		),
	]);
	// The day each person joined, in their zone: nobody is chased for a
	// period that ended before they were a member (W13).
	const joinedAt = new Map(joined.map((m) => [m.userId, m.createdAt.getTime()]));
	const byPerson = new Map(rows.map((row) => [row.userId, row]));
	const deciders = [...new Set(rows.flatMap((row) => (row.decidedBy ? [row.decidedBy] : [])))];
	const deciderNames = new Map(
		deciders.length === 0
			? []
			: (
					await drizzle(env.DB)
						.select({ id: users.id, name: users.name, email: users.email })
						.from(users)
						.where(among(users.id, deciders))
				).map((user) => [user.id, nameOrEmail(user)]),
	);

	const pending: PendingPeriod[] = [];
	const decided: DecidedPeriod[] = [];
	const notSubmitted: Person[] = [];
	for (const person of people) {
		const row = byPerson.get(person.id);
		const status = row ? PeriodStatus.parse(row.status) : null;
		if (row && status === "submitted") {
			const days = over.get(row.id);
			pending.push({
				id: row.id,
				person,
				submittedAt: row.submittedAt.getTime(),
				bySystem: bySystem.has(row.id),
				overLimit: days ? overLimitLabel(days) : null,
			});
		} else if (row && (status === "approved" || status === "returned")) {
			decided.push({
				id: row.id,
				person,
				status,
				decidedBy: (row.decidedBy && deciderNames.get(row.decidedBy)) || "",
				decidedAt: row.decidedAt?.getTime() ?? 0,
				comment: row.comment,
			});
		} else {
			const at = joinedAt.get(person.id);
			if (at === undefined || dayOf(at, person.timeZone) <= period.endsOn) {
				notSubmitted.push(person);
			}
		}
	}
	return { pending, notSubmitted: period.endsOn < today ? notSubmitted : null, decided };
}

/** The ids among `periodIds` whose last submission had no actor: the system submitted them at the lock date (TR-01). */
async function submittedBySystem(
	scope: OrganisationScope,
	periodIds: readonly string[],
): Promise<Set<string>> {
	if (periodIds.length === 0) return new Set();
	const events = await scope.periodEvents.select(
		(e) => and(among(e.periodId, periodIds), eq(e.action, "submitted")),
		{ orderBy: (e) => [desc(e.createdAt), desc(e.id)] },
	);
	const last = new Map<string, string | null>();
	for (const event of events) {
		if (!last.has(event.periodId)) last.set(event.periodId, event.actorId);
	}
	return new Set([...last].filter(([, actor]) => actor === null).map(([id]) => id));
}

/** The periods waiting on `people`'s decider, by the day each starts on, latest first. */
export async function pendingPeriods(
	scope: OrganisationScope,
	people: readonly Person[],
): Promise<{ startsOn: Day; count: number }[]> {
	const ids = people.map((p) => p.id);
	if (ids.length === 0) return [];
	const rows = await scope.periods.select(
		(p) => and(among(p.userId, ids), eq(p.status, "submitted")),
		{ orderBy: (p) => [desc(p.startsOn)] },
	);
	const counts = new Map<Day, number>();
	for (const row of rows) counts.set(row.startsOn, (counts.get(row.startsOn) ?? 0) + 1);
	return [...counts].map(([startsOn, count]) => ({ startsOn, count }));
}

/**
 * The number on the Approvals link: the periods, and the requests for leave,
 * overtime and weekend work, waiting for the person behind `membership` to
 * decide, counted in one statement (`waitingFor`). Null for a person who is
 * not shown Approvals, which costs no query.
 */
export async function pendingApprovalsOf(membership: Membership): Promise<number | null> {
	if (!canSee(viewerOf(membership), "approvals")) return null;
	// A manager on whole-day leave is skipped: nothing waits on them while away (D6, decision 48).
	if (!isAdministrator(membership.role)) {
		const scope = organisationScope(env.DB, membership.organisation.id);
		const away = await onLeaveToday(
			scope,
			[membership.user.id],
			membership.organisation,
			Date.now(),
		);
		if (away.has(membership.user.id)) return 0;
	}
	return waitingFor(
		env.DB,
		membership.organisation.id,
		membership.user.id,
		isAdministrator(membership.role),
	);
}

/** A decision on one period. A return and a reopening carry the reason. */
export type Decision =
	| { action: "approved" }
	| { action: "returned"; comment: string }
	| { action: "reopened"; comment: string };

/**
 * What a decision came to. `missing`: no such period in the organisation.
 * `not-allowed`: the person may not take it on that period. `stale`: the
 * period no longer stands where the decision can be taken from. `running`: a
 * timer of its person still runs in it (TR-02). `over`: a day of it is over
 * its limit and the approver has not confirmed it (TR-01). `locked`: the lock
 * date has reached its days, so it cannot go back to its person (TR-07).
 */
export type Decided = "done" | "missing" | "not-allowed" | "stale" | "running" | "over" | "locked";

/** A decision's outcome, with what the page says of an `over` or a `locked` one. */
export interface DecisionOutcome {
	result: Decided;
	/** The days over their limit: "Over by 7:30 on Tue 10". */
	overLimit?: string;
	/** The organisation's lock date. */
	lockedThrough?: Day;
}

/** What a decision reads of a period. */
interface PeriodRow {
	id: string;
	userId: string;
	status: string;
	startsOn: Day;
	endsOn: Day;
}

function mayTake(access: Access, period: PeriodRow, decision: Decision): boolean {
	if (decision.action === "reopened") return mayReopenPeriods(access);
	return mayDecidePeriodOf(access, period.userId);
}

/** The writes of one decision: the period's new state, the step that brought it there, and its row in the activity log. */
function statementsOf(
	scope: OrganisationScope,
	period: PeriodRow,
	next: PeriodStatus,
	decision: Decision,
	actorId: string,
	at: Date,
	overLimit: string | null = null,
) {
	const comment = decision.action === "approved" ? null : decision.comment;
	const summary = changes({ status: period.status }, { status: next, comment }, [
		"status",
		"comment",
	]);
	// A week approved with a day over its limit says so in the log (TR-01).
	if (overLimit !== null) summary.after = { ...summary.after, overLimit };
	return [
		scope.periods.statements.update(
			{ status: next, decidedBy: actorId, decidedAt: at, comment },
			(p) => and(eq(p.id, period.id), eq(p.status, period.status)),
		),
		scope.periodEvents.statements.insert({
			periodId: period.id,
			action: decision.action,
			actorId,
			comment,
		}),
		recordStatement(
			scope,
			actorId,
			`period.${decision.action}`,
			{ type: "period", id: period.id, ownerId: period.userId },
			summary,
		),
	] as const;
}

/** The ids among `periods` in which a timer of their person still runs (TR-02). */
async function runningIn(
	scope: OrganisationScope,
	periods: readonly PeriodRow[],
): Promise<Set<string>> {
	if (periods.length === 0) return new Set();
	const running = await scope.timeEntries.select((e) =>
		and(
			among(
				e.userId,
				periods.map((p) => p.userId),
			),
			isNull(e.endedAt),
		),
	);
	return new Set(
		periods
			.filter((p) =>
				running.some(
					(e) => e.userId === p.userId && p.startsOn <= e.spentOn && e.spentOn <= p.endsOn,
				),
			)
			.map((p) => p.id),
	);
}

/**
 * Takes `decision` on the period `periodId`, as `access`. An approval is
 * refused while a timer of its person runs in it, and, while a day of it is
 * over its limit, until `overLimitConfirmed`; the approval then says so in the
 * log. A return or a reopening is refused once the lock date reaches its days
 * where its person is.
 */
export async function decide(
	scope: OrganisationScope,
	access: Access,
	periodId: string,
	decision: Decision,
	{ at = new Date(), overLimitConfirmed = false } = {},
): Promise<DecisionOutcome> {
	const [period] = await scope.periods.select((p) => eq(p.id, periodId), { limit: 1 });
	if (!period) return { result: "missing" };
	if (!mayTake(access, period, decision)) return { result: "not-allowed" };
	const next = statusAfter(PeriodStatus.parse(period.status), decision.action);
	if (!next) return { result: "stale" };
	let overLimit: string | null = null;
	if (decision.action === "approved") {
		if ((await runningIn(scope, [period])).size > 0) return { result: "running" };
		const over = (await daysOverOf(scope, [period], at.getTime())).get(period.id);
		if (over) {
			overLimit = overLimitLabel(over);
			if (!overLimitConfirmed) return { result: "over", overLimit };
		}
	} else {
		const reach = await lockReachFor(scope.organisationId, period.userId, at.getTime());
		if (reach !== null && period.startsOn <= reach) {
			return {
				result: "locked",
				lockedThrough: (await lockDateOf(scope.organisationId)) ?? reach,
			};
		}
	}
	await scope.batch(statementsOf(scope, period, next, decision, access.userId, at, overLimit));
	return { result: "done" };
}

/** What Approve all came to: how many it approved, and how many it left and why. */
export interface ApprovedAll {
	approved: number;
	/** Left with a day over its limit, to be approved one at a time (TR-01). */
	over: number;
	/** Left while a timer of their person runs in them (TR-02). */
	running: number;
}

/**
 * Approves every pending period of the week starting on `startsOn` that `access` decides,
 * among `people`, in one batch, but for those with a day over its limit or a
 * timer running, which it leaves and counts.
 */
export async function approveAll(
	scope: OrganisationScope,
	access: Access,
	people: readonly Person[],
	startsOn: Day,
	at = new Date(),
): Promise<ApprovedAll> {
	const ids = people.filter((p) => mayDecidePeriodOf(access, p.id)).map((p) => p.id);
	const none = { approved: 0, over: 0, running: 0 };
	if (ids.length === 0) return none;
	// Each person's period for the week, found by range (TR-12).
	const week = { startsOn, endsOn: addDays(startsOn, 6) };
	const overlapping = await scope.periods.select((p) =>
		and(among(p.userId, ids), lte(p.startsOn, week.endsOn), gte(p.endsOn, week.startsOn)),
	);
	const periods = ids.flatMap((id) => {
		const { row } = periodOfWeek(
			overlapping.filter((p) => p.userId === id),
			week,
		);
		return row?.status === "submitted" ? [row] : [];
	});
	const [running, over] = await Promise.all([
		runningIn(scope, periods),
		daysOverOf(scope, periods, at.getTime()),
	]);
	const approving = periods.filter((p) => !running.has(p.id) && !over.has(p.id));
	const statements = approving.flatMap((period) =>
		statementsOf(scope, period, "approved", { action: "approved" }, access.userId, at),
	);
	const left = {
		over: periods.filter((p) => !running.has(p.id) && over.has(p.id)).length,
		running: running.size,
	};
	const [first, ...rest] = statements;
	if (!first) return { ...none, ...left };
	await scope.batch([first, ...rest]);
	return { approved: approving.length, ...left };
}

/**
 * Of `userIds`, those on leave all of today where they are (D6, decision 48):
 * approved leave covering both halves of their day.
 */
export async function onLeaveToday(
	scope: OrganisationScope,
	userIds: readonly string[],
	organisation: { timeZone: string },
	now: number,
): Promise<Set<string>> {
	const ids = [...new Set(userIds)];
	if (ids.length === 0) return new Set();
	const near = dayOf(now, "UTC");
	const [requests, zones] = await Promise.all([
		scope.leaveRequests.select((r) =>
			and(
				among(r.userId, ids),
				eq(r.status, "approved"),
				lte(r.startsOn, addDays(near, 1)),
				gte(r.endsOn, addDays(near, -1)),
			),
		),
		drizzle(env.DB)
			.select({ id: users.id, timeZone: users.timeZone })
			.from(users)
			.where(among(users.id, ids)),
	]);
	const away = new Set<string>();
	for (const request of requests) {
		const zone = zoneOf(
			{ timeZone: zones.find((z) => z.id === request.userId)?.timeZone ?? null },
			organisation,
		);
		if (halvesCovered(request, dayOf(now, zone)) === 2) away.add(request.userId);
	}
	return away;
}

/**
 * For each of `personIds` whose every manager, of every team they are in and
 * other than themselves, is on leave all of today (D6, decision 48): the
 * managers' names. What waits on those managers waits on owners and admins,
 * and Approvals tells them so. A person no manager decides for is left out:
 * their requests wait on owners and admins as they always have.
 */
export async function managersAwayOf(
	scope: OrganisationScope,
	personIds: readonly string[],
	organisation: { timeZone: string },
	now: number,
): Promise<Map<string, string[]>> {
	const found = new Map<string, string[]>();
	const ids = [...new Set(personIds)];
	if (ids.length === 0) return found;
	const places = await scope.teamMembers.select((t) => among(t.userId, ids));
	if (places.length === 0) return found;
	const managers = await scope.teamMembers.select((t) =>
		and(inArray(t.teamId, [...new Set(places.map((p) => p.teamId))]), eq(t.isManager, true)),
	);
	const away = await onLeaveToday(
		scope,
		managers.map((m) => m.userId),
		organisation,
		now,
	);
	if (away.size === 0) return found;
	const names = new Map(
		(
			await drizzle(env.DB)
				.select({ id: users.id, name: users.name, email: users.email })
				.from(users)
				.where(among(users.id, [...away]))
		).map((user) => [user.id, nameOrEmail(user)]),
	);
	for (const id of ids) {
		const teams = new Set(places.filter((p) => p.userId === id).map((p) => p.teamId));
		const theirs = [
			...new Set(
				managers.filter((m) => teams.has(m.teamId) && m.userId !== id).map((m) => m.userId),
			),
		];
		if (theirs.length > 0 && theirs.every((m) => away.has(m))) {
			found.set(
				id,
				theirs.map((m) => names.get(m) ?? ""),
			);
		}
	}
	return found;
}
