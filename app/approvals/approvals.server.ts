import { env } from "cloudflare:workers";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { changes, recordStatement } from "~/activity/activity.server";
import { among, type OrganisationScope, organisationScope, users, waitingFor } from "~/db";
import { halvesCovered } from "~/leave/days";
import { daysOverOf } from "~/leave/rules.server";
import { lockDateOf, lockReachFor } from "~/locks/locks.server";
import { notificationStatements, partDecided, weekDecided } from "~/notifications/words";
import {
	type Access,
	isAdministrator,
	mayDecidePartOf,
	mayDecidePeriodOf,
	mayReopenPeriods,
} from "~/organisations/access";
import { type Membership, viewerOf } from "~/organisations/membership.server";
import { nameOrEmail } from "~/organisations/people";
import { type PeriodDays, PeriodStatus, periodOfWeek, statusAfter } from "~/periods/periods";
import { canSee } from "~/shell/destinations";
import { type Person, peopleOf } from "~/teams/people.server";
import { addDays, type Day, dayOf, daysFrom } from "~/time/calendar";
import { zoneOf } from "~/time/zones";

import type { PartStatus } from "./parts";
import { deliveryManagersIn, ledIn, type PartRow, partsOf, weekStatusSql } from "./parts.server";
import { managersAwaySentence, overLimitLabel } from "./words";

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
 *
 * A week held in parts (TS-117, decision 79; `parts.ts`) is decided a part
 * at a time: its line part by those who decide its person's weeks, on the
 * People tab; each project part by the project's delivery managers, or an
 * owner or admin, on the Projects tab (`mayDecidePartOf`). The period's
 * status follows its parts as each is decided (`weekStatusSql`).
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

/** A project part of a week as the People tab shows it beside the rest (TS-117). */
export interface PartSummary {
	projectId: string;
	project: string;
	status: PartStatus;
	/** Who decided it: a name, "the system", or "" while it waits. */
	decidedBy: string;
}

export interface PendingPeriod {
	id: string;
	person: Person;
	submittedAt: number;
	/** Whether the system submitted it, at the lock date, rather than its person (TR-01). */
	bySystem: boolean;
	/** What Submit would have refused: "Over by 7:30 on Tue 10"; null when no day is over (TR-01). */
	overLimit: string | null;
	/** Its project parts, for a week held in parts; null for one decided whole (TS-117). */
	projects: PartSummary[] | null;
}

export interface DecidedPeriod {
	id: string;
	person: Person;
	/** The week's, or for a week held in parts its line part's (TS-117). */
	status: "approved" | "returned";
	decidedBy: string;
	decidedAt: number;
	comment: string | null;
	/** Its project parts, for a week held in parts; null for one decided whole (TS-117). */
	projects: PartSummary[] | null;
	/** Whether the whole week is approved, so an owner or admin may reopen it. */
	reopenable: boolean;
}

export interface PeriodApprovals {
	pending: PendingPeriod[];
	/** The people who have not submitted the period, once it has closed; null while it is open. */
	notSubmitted: Person[] | null;
	decided: DecidedPeriod[];
}

/** The names of `ids`, as the organisation shows them. */
async function userNames(ids: readonly string[]): Promise<Map<string, string>> {
	const wanted = [...new Set(ids)];
	if (wanted.length === 0) return new Map();
	const rows = await drizzle(env.DB)
		.select({ id: users.id, name: users.name, email: users.email })
		.from(users)
		.where(among(users.id, wanted));
	return new Map(rows.map((user) => [user.id, nameOrEmail(user)]));
}

/** The names of the projects `ids`. */
async function projectNames(
	scope: OrganisationScope,
	ids: readonly string[],
): Promise<Map<string, string>> {
	const wanted = [...new Set(ids)];
	if (wanted.length === 0) return new Map();
	const rows = await scope.projects.select((p) => among(p.id, wanted));
	return new Map(rows.map((p) => [p.id, p.name]));
}

/**
 * The periods of `people` that start on `period.startsOn`, sorted into
 * pending, not submitted and decided. `today` is the viewer's: a period is
 * closed when its last day is before it. A week held in parts (TS-117) is
 * sorted by its line part, which is what the People tab decides, and carries
 * its project parts, decided or waiting.
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
	const parts = await partsOf(
		scope,
		rows.map((row) => row.id),
	);
	// Where each week stands on the People tab: its line part's status, or its own.
	const standing = (row: (typeof rows)[number]) => {
		const line = parts.get(row.id)?.find((p) => p.projectId === null);
		return line ? { status: line.status as PartStatus, decision: line } : null;
	};
	const statusOf = (row: (typeof rows)[number]): PeriodStatus =>
		standing(row)?.status ?? PeriodStatus.parse(row.status);
	const waiting = rows.filter((row) => statusOf(row) === "submitted");
	const projectIds = [...parts.values()].flatMap((list) =>
		list.flatMap((p) => (p.projectId === null ? [] : [p.projectId])),
	);
	const [over, bySystem, deciderNames, names] = await Promise.all([
		daysOverOf(scope, waiting, Date.now()),
		submittedBySystem(
			scope,
			waiting.map((row) => row.id),
		),
		userNames([
			...rows.flatMap((row) => (row.decidedBy ? [row.decidedBy] : [])),
			...[...parts.values()].flatMap((list) =>
				list.flatMap((p) => (p.decidedBy ? [p.decidedBy] : [])),
			),
		]),
		projectNames(scope, projectIds),
	]);
	const projectsOf = (row: (typeof rows)[number]): PartSummary[] | null => {
		const list = parts.get(row.id);
		if (!list || list.length === 0) return null;
		return list
			.flatMap((p) => (p.projectId === null ? [] : [{ ...p, projectId: p.projectId }]))
			.map((p) => ({
				projectId: p.projectId,
				project: names.get(p.projectId) ?? "",
				status: p.status as PartStatus,
				decidedBy:
					p.status === "submitted"
						? ""
						: (p.decidedBy && deciderNames.get(p.decidedBy)) || "the system",
			}))
			.sort((a, b) => a.project.localeCompare(b.project, "en"));
	};
	// The day each person joined, in their zone: nobody is chased for a
	// period that ended before they were a member (W13).
	const joinedAt = new Map(joined.map((m) => [m.userId, m.createdAt.getTime()]));
	const byPerson = new Map(rows.map((row) => [row.userId, row]));

	const pending: PendingPeriod[] = [];
	const decided: DecidedPeriod[] = [];
	const notSubmitted: Person[] = [];
	for (const person of people) {
		const row = byPerson.get(person.id);
		const status = row ? statusOf(row) : null;
		if (row && status === "submitted") {
			const days = over.get(row.id);
			pending.push({
				id: row.id,
				person,
				submittedAt: row.submittedAt.getTime(),
				bySystem: bySystem.has(row.id),
				overLimit: days ? overLimitLabel(days) : null,
				projects: projectsOf(row),
			});
		} else if (row && (status === "approved" || status === "returned")) {
			const decision = standing(row)?.decision ?? row;
			decided.push({
				id: row.id,
				person,
				status,
				decidedBy: (decision.decidedBy && deciderNames.get(decision.decidedBy)) || "",
				decidedAt: decision.decidedAt?.getTime() ?? 0,
				comment: decision.comment,
				projects: projectsOf(row),
				reopenable: row.status === "approved",
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

/** How many wait in each week, by the day it starts on, latest first. */
function byWeek(startsOn: readonly Day[]): { startsOn: Day; count: number }[] {
	const counts = new Map<Day, number>();
	for (const day of startsOn) counts.set(day, (counts.get(day) ?? 0) + 1);
	return [...counts]
		.sort(([a], [b]) => b.localeCompare(a))
		.map(([day, count]) => ({ startsOn: day, count }));
}

/**
 * The periods waiting on `people`'s decider on the People tab, by the day
 * each starts on, latest first: those decided whole that are submitted, and
 * those held in parts whose line part waits (TS-117).
 */
export async function pendingPeriods(
	scope: OrganisationScope,
	people: readonly Person[],
): Promise<{ startsOn: Day; count: number }[]> {
	const ids = people.map((p) => p.id);
	if (ids.length === 0) return [];
	const rows = await scope.periods.select((p) =>
		and(
			among(p.userId, ids),
			inArray(p.status, ["submitted", "returned"]),
			sql`(${p.status} = 'submitted' and not ${scope.periodParts.exists((part) => eq(part.periodId, p.id))}
				or ${scope.periodParts.exists((part) =>
					and(eq(part.periodId, p.id), isNull(part.projectId), eq(part.status, "submitted")),
				)})`,
		),
	);
	return byWeek(rows.map((row) => row.startsOn));
}

/**
 * The weeks with project parts waiting for `access` on the Projects tab
 * (TS-117), by the day each starts on, latest first: of any project for an
 * owner or admin; for anyone else, of the projects they are a delivery
 * manager of in that week. Never their own.
 */
export async function pendingProjectWeeks(
	scope: OrganisationScope,
	access: Access,
): Promise<{ startsOn: Day; count: number }[]> {
	const administrator = isAdministrator(access.role);
	const stretches = administrator
		? []
		: await scope.projectMembers.select((m) =>
				and(eq(m.userId, access.userId), eq(m.role, "delivery_manager")),
			);
	if (!administrator && stretches.length === 0) return [];
	const parts = await scope.periodParts.select((p) =>
		and(
			eq(p.status, "submitted"),
			administrator
				? isNotNull(p.projectId)
				: among(
						p.projectId,
						stretches.map((s) => s.projectId),
					),
		),
	);
	if (parts.length === 0) return [];
	const periods = await scope.periods.select((p) =>
		among(
			p.id,
			parts.map((part) => part.periodId),
		),
	);
	const periodOf = new Map(periods.map((p) => [p.id, p]));
	return byWeek(
		parts.flatMap((part) => {
			const period = periodOf.get(part.periodId);
			if (!period || period.userId === access.userId) return [];
			const leads =
				administrator ||
				stretches.some(
					(s) =>
						s.projectId === part.projectId &&
						s.startsOn <= period.endsOn &&
						(s.endsOn === null || s.endsOn >= period.startsOn),
				);
			return leads ? [period.startsOn] : [];
		}),
	);
}

/** One person's time on one project in a week, as the Projects tab shows it (TS-117). */
export interface ProjectPart {
	periodId: string;
	person: Person;
	status: PartStatus;
	/** Each day of the week and the time on the project that day, in seconds. */
	days: { day: Day; seconds: number }[];
	seconds: number;
	/** Of `seconds`, those of overtime (TS-095). */
	overtimeSeconds: number;
	submittedAt: number;
	/** Who decided it: a name, "the system", or "" while it waits. */
	decidedBy: string;
	decidedAt: number | null;
	comment: string | null;
	/** Whether the viewer may approve or return it: never their own (D5). */
	mayDecide: boolean;
	/** Why it waits for an owner or admin: every other delivery manager is on leave today (D6). */
	waits: string | null;
}

/** A project and its people's parts in the week. */
export interface ProjectParts {
	id: string;
	name: string;
	parts: ProjectPart[];
}

/**
 * The project parts of the week `period` that `access` sees on the Projects
 * tab (TS-117): of every project for an owner or admin, else of those they
 * are a delivery manager of in the week; each project with its people and
 * their days, projects and people in name order. Their own parts are shown,
 * and are not theirs to decide (D5, decision 47).
 */
export async function projectApprovals(
	scope: OrganisationScope,
	organisation: { timeZone: string },
	access: Access,
	period: PeriodDays,
	now: number,
): Promise<ProjectParts[]> {
	const administrator = isAdministrator(access.role);
	const leads = administrator ? new Set<string>() : await ledIn(scope, access.userId, period);
	if (!administrator && leads.size === 0) return [];
	const ofWeek = scope.periods.value(
		(p) => p.id,
		(p) => and(lte(p.startsOn, period.endsOn), gte(p.endsOn, period.startsOn)),
	);
	const parts = await scope.periodParts.select((p) =>
		and(
			administrator ? isNotNull(p.projectId) : among(p.projectId, [...leads]),
			sql`${p.periodId} in ${ofWeek}`,
		),
	);
	if (parts.length === 0) return [];
	const periods = await scope.periods.select((p) =>
		among(
			p.id,
			parts.map((part) => part.periodId),
		),
	);
	const periodOf = new Map(periods.map((p) => [p.id, p]));
	const userIds = [...new Set(periods.map((p) => p.userId))];
	const projectIds = [...new Set(parts.flatMap((p) => (p.projectId ? [p.projectId] : [])))];
	const first = periods.map((p) => p.startsOn).sort()[0] as Day;
	const last = periods
		.map((p) => p.endsOn)
		.sort()
		.at(-1) as Day;
	const [people, names, lines, deciderNames, leaders] = await Promise.all([
		peopleOf(scope, organisation, userIds),
		projectNames(scope, projectIds),
		scope.timeEntries.sums(
			(e) => ({ userId: e.userId, projectId: e.projectId, spentOn: e.spentOn }),
			(e) => {
				const seconds = sql<number>`max(0, cast((coalesce(${e.endedAt}, ${now}) - ${e.startedAt}) / 1000 as integer))`;
				return {
					seconds,
					overtimeSeconds: sql<number>`case when ${e.overtime} then ${seconds} else 0 end`,
				};
			},
			[["userId", "projectId", "spentOn"]],
			(e) =>
				and(
					among(e.userId, userIds),
					among(e.projectId, projectIds),
					gte(e.spentOn, first),
					lte(e.spentOn, last),
				),
		),
		userNames(parts.flatMap((p) => (p.decidedBy ? [p.decidedBy] : []))),
		// What waits on delivery managers on leave waits on owners and admins, who are told so (D6).
		administrator ? deliveryManagersIn(scope, projectIds, period) : new Map<string, string[]>(),
	]);
	const away = await onLeaveToday(
		scope,
		[...new Set([...leaders.values()].flat())],
		organisation,
		now,
	);
	const awayNames = await userNames([...away]);
	const personOf = new Map(people.map((p) => [p.id, p]));
	const groups = new Map<string, ProjectParts>();
	for (const part of parts) {
		const row = periodOf.get(part.periodId);
		const projectId = part.projectId;
		const person = row ? personOf.get(row.userId) : undefined;
		if (!row || !projectId || !person) continue;
		const days = daysFrom(row.startsOn, row.endsOn).map((day) => ({
			day,
			seconds: lines
				.filter((l) => l.userId === row.userId && l.projectId === projectId && l.spentOn === day)
				.reduce((sum, l) => sum + l.seconds, 0),
		}));
		const overtimeSeconds = lines
			.filter((l) => l.userId === row.userId && l.projectId === projectId)
			.reduce((sum, l) => sum + l.overtimeSeconds, 0);
		const others = (leaders.get(projectId) ?? []).filter((id) => id !== row.userId);
		const status = part.status as PartStatus;
		const group = groups.get(projectId) ?? {
			id: projectId,
			name: names.get(projectId) ?? "",
			parts: [],
		};
		group.parts.push({
			periodId: row.id,
			person,
			status,
			days,
			seconds: days.reduce((sum, d) => sum + d.seconds, 0),
			overtimeSeconds,
			submittedAt: row.submittedAt.getTime(),
			decidedBy:
				status === "submitted"
					? ""
					: (part.decidedBy && deciderNames.get(part.decidedBy)) || "the system",
			decidedAt: part.decidedAt?.getTime() ?? null,
			comment: part.comment,
			mayDecide: mayDecidePartOf(access, row.userId, projectId, leads),
			waits:
				status === "submitted" && others.length > 0 && others.every((id) => away.has(id))
					? managersAwaySentence(others.map((id) => awayNames.get(id) ?? ""))
					: null,
		});
		groups.set(projectId, group);
	}
	return [...groups.values()]
		.map((group) => ({
			...group,
			parts: group.parts.sort((a, b) => a.person.name.localeCompare(b.person.name, "en")),
		}))
		.sort((a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id));
}

/**
 * The number on the Approvals link: the periods and their parts, and the
 * requests for leave, overtime and weekend work, waiting for the person
 * behind `membership` to decide, counted in one statement (`waitingFor`).
 * Null for a person who is not shown Approvals, which costs no query.
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
 * What a decision came to. `missing`: no such period, or no such part of it,
 * in the organisation. `not-allowed`: the person may not take it on that
 * period or part. `stale`: the period or part no longer stands where the
 * decision can be taken from. `running`: a timer of its person still runs in
 * it (TR-02). `over`: a day of it is over its limit and the approver has not
 * confirmed it (TR-01). `locked`: the lock date has reached its days, so it
 * cannot go back to its person (TR-07).
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
		// Its person is told, with the reason (TS-049).
		...notificationStatements(scope, [weekDecided(period, decision.action, comment)]),
	] as const;
}

/**
 * The writes of a decision on one part of a week (TS-117): the part's new
 * state, the period's as its parts then stand (`weekStatusSql`), the step,
 * naming the part, and its row in the activity log, and its person told.
 * `whole`: approving it leaves no part waiting or returned, so the week is
 * approved with it.
 */
function partStatementsOf(
	scope: OrganisationScope,
	period: PeriodRow,
	part: PartRow,
	project: string | null,
	decision: Exclude<Decision, { action: "reopened" }>,
	actorId: string,
	at: Date,
	{ overLimit = null, whole = false }: { overLimit?: string | null; whole?: boolean } = {},
) {
	const comment = decision.action === "approved" ? null : decision.comment;
	const summary = changes({ status: part.status }, { status: decision.action, comment }, [
		"status",
		"comment",
	]);
	summary.after = { ...summary.after, part: project ?? "rest of the week" };
	if (overLimit !== null) summary.after = { ...summary.after, overLimit };
	return [
		scope.periodParts.statements.update(
			{ status: decision.action, decidedBy: actorId, decidedAt: at, comment },
			(p) => and(eq(p.id, part.id), eq(p.status, "submitted")),
		),
		scope.periods.statements.update(
			decision.action === "returned"
				? { status: "returned", decidedBy: actorId, decidedAt: at, comment }
				: { status: weekStatusSql(scope, period.id), decidedBy: actorId, decidedAt: at },
			(p) => eq(p.id, period.id),
		),
		scope.periodEvents.statements.insert({
			periodId: period.id,
			action: decision.action,
			actorId,
			comment,
			part: part.projectId === null ? "line" : "project",
			projectId: part.projectId,
		}),
		recordStatement(
			scope,
			actorId,
			`period.${decision.action}`,
			{ type: "period", id: period.id, ownerId: period.userId },
			summary,
		),
		// Its person is told, with the reason (TS-049).
		...notificationStatements(scope, [
			partDecided(period, project, decision.action, comment, whole),
		]),
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
 *
 * A week held in parts (TS-117) is approved or returned a part at a time:
 * `projectId` names a project part, and null the line part, the only one the
 * limit of a day is confirmed on, as the line manager decides the week's
 * hours. Reopening an approved week returns every part of it.
 */
export async function decide(
	scope: OrganisationScope,
	access: Access,
	periodId: string,
	decision: Decision,
	{
		at = new Date(),
		overLimitConfirmed = false,
		projectId = null,
	}: { at?: Date; overLimitConfirmed?: boolean; projectId?: string | null } = {},
): Promise<DecisionOutcome> {
	const [period] = await scope.periods.select((p) => eq(p.id, periodId), { limit: 1 });
	if (!period) return { result: "missing" };
	const parts = await scope.periodParts.select((p) => eq(p.periodId, period.id));
	const part =
		decision.action === "reopened" || parts.length === 0
			? null
			: parts.find((p) => p.projectId === projectId);
	if (part === undefined || (part === null && projectId !== null)) return { result: "missing" };
	if (part === null) {
		if (!mayTake(access, period, decision)) return { result: "not-allowed" };
	} else {
		const leads =
			projectId === null || isAdministrator(access.role)
				? new Set<string>()
				: await ledIn(scope, access.userId, period);
		if (!mayDecidePartOf(access, period.userId, projectId, leads)) {
			return { result: "not-allowed" };
		}
		if (part.status !== "submitted") return { result: "stale" };
	}
	const next = statusAfter(PeriodStatus.parse(period.status), decision.action);
	if (part === null && !next) return { result: "stale" };
	let overLimit: string | null = null;
	if (decision.action === "approved") {
		if ((await runningIn(scope, [period])).size > 0) return { result: "running" };
		if (part === null || part.projectId === null) {
			const over = (await daysOverOf(scope, [period], at.getTime())).get(period.id);
			if (over) {
				overLimit = overLimitLabel(over);
				if (!overLimitConfirmed) return { result: "over", overLimit };
			}
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
	if (part === null) {
		// A reopening sends every part of the week back with it.
		const comment = decision.action === "approved" ? null : decision.comment;
		await scope.batch([
			...statementsOf(scope, period, next as PeriodStatus, decision, access.userId, at, overLimit),
			...(parts.length > 0
				? [
						scope.periodParts.statements.update(
							{ status: "returned", decidedBy: access.userId, decidedAt: at, comment },
							(p) => eq(p.periodId, period.id),
						),
					]
				: []),
		]);
		return { result: "done" };
	}
	const project =
		part.projectId === null
			? null
			: ((await projectNames(scope, [part.projectId])).get(part.projectId) ?? "");
	const whole =
		decision.action === "approved" &&
		parts.every((p) => p.id === part.id || p.status === "approved");
	await scope.batch(
		partStatementsOf(
			scope,
			period,
			part,
			project,
			decision as Exclude<Decision, { action: "reopened" }>,
			access.userId,
			at,
			{
				overLimit,
				whole,
			},
		),
	);
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
 * timer running, which it leaves and counts. Of a week held in parts
 * (TS-117), the line part, which the People tab shows.
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
	const rows = ids.flatMap((id) => {
		const { row } = periodOfWeek(
			overlapping.filter((p) => p.userId === id),
			week,
		);
		return row ? [row] : [];
	});
	const parts = await partsOf(
		scope,
		rows.map((row) => row.id),
	);
	const lineOf = (id: string) => parts.get(id)?.find((p) => p.projectId === null);
	const periods = rows.filter((row) =>
		parts.has(row.id) ? lineOf(row.id)?.status === "submitted" : row.status === "submitted",
	);
	const [running, over] = await Promise.all([
		runningIn(scope, periods),
		daysOverOf(scope, periods, at.getTime()),
	]);
	const approving = periods.filter((p) => !running.has(p.id) && !over.has(p.id));
	const statements = approving.flatMap((period) => {
		const line = lineOf(period.id);
		if (!line) {
			return statementsOf(scope, period, "approved", { action: "approved" }, access.userId, at);
		}
		const whole = (parts.get(period.id) ?? []).every(
			(p) => p.id === line.id || p.status === "approved",
		);
		return partStatementsOf(scope, period, line, null, { action: "approved" }, access.userId, at, {
			whole,
		});
	});
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
 * Approves every project part waiting in the week `period` that `access` may
 * decide (TS-117), on the Projects tab, in one batch, but for those in a week
 * in which a timer of their person runs, which it leaves and counts. A day
 * over its limit is the line part's to confirm, so it holds no project part.
 */
export async function approveAllParts(
	scope: OrganisationScope,
	organisation: { timeZone: string },
	access: Access,
	period: PeriodDays,
	at = new Date(),
): Promise<ApprovedAll> {
	const groups = await projectApprovals(scope, organisation, access, period, at.getTime());
	const waiting = groups.flatMap((g) =>
		g.parts
			.filter((p) => p.status === "submitted" && p.mayDecide)
			.map((p) => ({ projectId: g.id, project: g.name, periodId: p.periodId })),
	);
	const none = { approved: 0, over: 0, running: 0 };
	if (waiting.length === 0) return none;
	const periodIds = [...new Set(waiting.map((w) => w.periodId))];
	const [periods, parts] = await Promise.all([
		scope.periods.select((p) => among(p.id, periodIds)),
		partsOf(scope, periodIds),
	]);
	const running = await runningIn(scope, periods);
	const approved = new Set<string>();
	const statements = waiting.flatMap((w) => {
		const row = periods.find((p) => p.id === w.periodId);
		const part = parts.get(w.periodId)?.find((p) => p.projectId === w.projectId);
		if (!row || !part || running.has(row.id)) return [];
		approved.add(part.id);
		const whole = (parts.get(row.id) ?? []).every(
			(p) => p.status === "approved" || approved.has(p.id),
		);
		return partStatementsOf(
			scope,
			row,
			part,
			w.project,
			{ action: "approved" },
			access.userId,
			at,
			{
				whole,
			},
		);
	});
	const left = {
		over: 0,
		running: waiting.filter((w) => running.has(w.periodId)).length,
	};
	const [first, ...rest] = statements;
	if (!first) return { ...none, ...left };
	await scope.batch([first, ...rest]);
	return { approved: approved.size, ...left };
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
		and(
			among(
				t.teamId,
				places.map((p) => p.teamId),
			),
			eq(t.isManager, true),
		),
	);
	const away = await onLeaveToday(
		scope,
		managers.map((m) => m.userId),
		organisation,
		now,
	);
	if (away.size === 0) return found;
	const names = await userNames([...away]);
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
