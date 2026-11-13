import { env } from "cloudflare:workers";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { changes, recordStatement } from "~/activity/activity.server";
import { among, type OrganisationScope, users, waitingFor } from "~/db";
import {
	type Access,
	isAdministrator,
	mayDecidePeriodOf,
	mayReopenPeriods,
} from "~/organisations/access";
import { type Membership, viewerOf } from "~/organisations/membership.server";
import { nameOrEmail } from "~/organisations/people";
import { type PeriodDays, PeriodStatus, statusAfter } from "~/periods/periods";
import { canSee } from "~/shell/destinations";
import { type Person, peopleOf } from "~/teams/people.server";
import { type Day, dayOf } from "~/time/calendar";

/**
 * Approvals (TS-047): the periods people submit, decided one period at a
 * time. Whose periods a person decides is `mayDecidePeriodOf` in
 * `access.ts`: an owner or admin everyone's, a manager the members of the
 * teams they manage and never their own. Every decision changes the period
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
	const [rows, joined] =
		ids.length === 0
			? [[], []]
			: await Promise.all([
					scope.periods.select((p) => and(among(p.userId, ids), eq(p.startsOn, period.startsOn))),
					scope.memberships.select((m) => among(m.userId, ids)),
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
			pending.push({ id: row.id, person, submittedAt: row.submittedAt.getTime() });
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
 * period no longer stands where the decision can be taken from.
 */
export type Decided = "done" | "missing" | "not-allowed" | "stale";

/** What a decision reads of a period. */
interface PeriodRow {
	id: string;
	userId: string;
	status: string;
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
) {
	const comment = decision.action === "approved" ? null : decision.comment;
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
			changes({ status: period.status }, { status: next, comment }, ["status", "comment"]),
		),
	] as const;
}

/** Takes `decision` on the period `periodId`, as `access`. */
export async function decide(
	scope: OrganisationScope,
	access: Access,
	periodId: string,
	decision: Decision,
	at = new Date(),
): Promise<Decided> {
	const [period] = await scope.periods.select((p) => eq(p.id, periodId), { limit: 1 });
	if (!period) return "missing";
	if (!mayTake(access, period, decision)) return "not-allowed";
	const next = statusAfter(PeriodStatus.parse(period.status), decision.action);
	if (!next) return "stale";
	await scope.batch(statementsOf(scope, period, next, decision, access.userId, at));
	return "done";
}

/**
 * Approves every pending period starting on `startsOn` that `access` decides,
 * among `people`, in one batch. Returns how many it approved.
 */
export async function approveAll(
	scope: OrganisationScope,
	access: Access,
	people: readonly Person[],
	startsOn: Day,
	at = new Date(),
): Promise<number> {
	const ids = people.filter((p) => mayDecidePeriodOf(access, p.id)).map((p) => p.id);
	if (ids.length === 0) return 0;
	const periods = await scope.periods.select((p) =>
		and(among(p.userId, ids), eq(p.startsOn, startsOn), eq(p.status, "submitted")),
	);
	const statements = periods.flatMap((period) =>
		statementsOf(scope, period, "approved", { action: "approved" }, access.userId, at),
	);
	const [first, ...rest] = statements;
	if (!first) return 0;
	await scope.batch([first, ...rest]);
	return periods.length;
}
