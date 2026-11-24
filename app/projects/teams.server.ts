import { env } from "cloudflare:workers";
import { and, asc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { ActivitySource } from "~/activity/actions";
import { changes, recordStatement } from "~/activity/activity.server";
import { mayCreateProject } from "~/clients/managers.server";
import { among, type OrganisationScope, organisations, type TenantRow } from "~/db";
import { isAdministrator } from "~/organisations/access";
import type { Role } from "~/organisations/roles";
import { addDays, type Day } from "~/time/calendar";

import { namesOf } from "./project.server";
import {
	type AssignmentSource,
	covers,
	overlaps,
	type ProjectTracking,
	type Stretch,
	type TeamChoices,
	type TeamProblem,
	TeamRole,
} from "./teams";
import { mayManageWorkPackages } from "./work-packages.server";

/**
 * Project teams (TS-115c, docs/decisions.md entry 75): who is on each
 * project's team from which day to which (`project_members`), and the rule
 * every writer of time asks (`entryTeamOf`, `teamRules`): where the
 * organisation's `project_tracking` is `assigned`, a person's time on a day
 * goes to a project only while one of their stretches on its team covers that
 * day. Owners and admins manage every project's team; a client's account
 * managers its projects' (decision 42); a project's delivery managers assign
 * people to it, though only owners, admins and account managers name its
 * delivery managers. A change is dated: a stretch is ended, and a new one
 * starts the day after, so the history stays.
 */

export type Assignment = TenantRow<"projectMembers">;

/** The fields an assignment's activity record keeps. */
const ASSIGNMENT_FIELDS = ["userId", "role", "startsOn", "endsOn"] as const;

/** Whether the organisation of `scope` tracks by assignment. */
export async function trackingOf(scope: OrganisationScope): Promise<ProjectTracking> {
	const [row] = await drizzle(env.DB)
		.select({ tracking: organisations.projectTracking })
		.from(organisations)
		.where(eq(organisations.id, scope.organisationId))
		.limit(1);
	return row?.tracking === "assigned" ? "assigned" : "anyone";
}

/** The stretches of `userId` on `projectId`'s team, first first. */
function stretchesOf(scope: OrganisationScope, userId: string, projectId: string) {
	return scope.projectMembers.select((m) => and(eq(m.userId, userId), eq(m.projectId, projectId)), {
		orderBy: (m) => [asc(m.startsOn)],
	});
}

/** Whether `userId` is on `projectId`'s team on `day`. */
export async function isOnTeam(
	scope: OrganisationScope,
	userId: string,
	projectId: string,
	day: Day,
): Promise<boolean> {
	const rows = await scope.projectMembers.select(
		(m) =>
			and(
				eq(m.userId, userId),
				eq(m.projectId, projectId),
				lte(m.startsOn, day),
				or(isNull(m.endsOn), gte(m.endsOn, day)),
			),
		{ limit: 1 },
	);
	return rows.length > 0;
}

/**
 * Whether `userId`'s time on `day` may go to `projectId`: always where anyone
 * tracks to any project; else only while they are on its team that day. An
 * entry being changed (`kept`) that stays on its project and its day, and
 * gains no time, is let be, as a closed work package's entry is (TS-115b): a
 * stretch ended since does not stop its description being corrected or its
 * hours trimmed.
 */
export async function entryTeamOf(
	scope: OrganisationScope,
	userId: string,
	projectId: string,
	day: Day,
	kept: { projectId: string; spentOn: Day; addsTime: boolean } | null = null,
): Promise<{ ok: true } | { ok: false; reason: "not-assigned" }> {
	if (kept && kept.projectId === projectId && kept.spentOn === day && !kept.addsTime) {
		return { ok: true };
	}
	if ((await trackingOf(scope)) === "anyone") return { ok: true };
	return (await isOnTeam(scope, userId, projectId, day))
		? { ok: true }
		: { ok: false, reason: "not-assigned" };
}

/** The rule for many entries at once: a copy, an import. */
export interface TeamRules {
	tracking: ProjectTracking;
	/** Whether `userId`'s time on `day` may go to `projectId`. */
	admits(userId: string, projectId: string, day: Day): boolean;
}

/**
 * `entryTeamOf` for many entries on `projectIds` at once, read in one query
 * (decision 40): an import's thousands of rows, a week copied.
 */
export async function teamRules(
	scope: OrganisationScope,
	projectIds: readonly string[],
): Promise<TeamRules> {
	const tracking = await trackingOf(scope);
	if (tracking === "anyone" || projectIds.length === 0) {
		return { tracking, admits: () => tracking === "anyone" };
	}
	const rows = await scope.projectMembers.select((m) => among(m.projectId, projectIds));
	const byKey = new Map<string, Stretch[]>();
	for (const row of rows) {
		const key = `${row.userId}/${row.projectId}`;
		byKey.set(key, [...(byKey.get(key) ?? []), row]);
	}
	return {
		tracking,
		admits: (userId, projectId, day) =>
			(byKey.get(`${userId}/${projectId}`) ?? []).some((stretch) => covers(stretch, day)),
	};
}

/**
 * What the picker knows of `userId`'s teams: the organisation's choice, their
 * own stretches by project, and whether they may join any project's team.
 */
export async function teamChoices(
	scope: OrganisationScope,
	userId: string,
	role: Role,
	tracking: ProjectTracking,
): Promise<TeamChoices> {
	const rows = await scope.projectMembers.select((m) => eq(m.userId, userId), {
		orderBy: (m) => [asc(m.startsOn)],
	});
	const mine: TeamChoices["mine"] = {};
	for (const row of rows) {
		const stretchRole = TeamRole.safeParse(row.role);
		mine[row.projectId] = [
			...(mine[row.projectId] ?? []),
			{
				startsOn: row.startsOn,
				endsOn: row.endsOn,
				role: stretchRole.success ? stretchRole.data : "member",
			},
		];
	}
	return { tracking, mine, joinsAny: isAdministrator(role) };
}

/**
 * The projects `userId` leads: those with a stretch of theirs as delivery
 * manager that has not ended before `today`.
 */
export async function ledProjectIds(
	scope: OrganisationScope,
	userId: string,
	today: Day,
): Promise<Set<string>> {
	const rows = await scope.projectMembers.select((m) =>
		and(
			eq(m.userId, userId),
			eq(m.role, "delivery_manager"),
			or(isNull(m.endsOn), gte(m.endsOn, today)),
		),
	);
	return new Set(rows.map((row) => row.projectId));
}

/**
 * The projects `userId` leads as delivery manager (`led`), and those whose
 * hours, budgets in hours and team they see beyond their own time
 * (`overseen`, TS-115c): those they lead, and those of the clients they are
 * an account manager of (decision 42). Money stays with those who see rates
 * (`maySeeRates`).
 */
export async function oversightOf(
	scope: OrganisationScope,
	userId: string,
	today: Day,
): Promise<{ led: Set<string>; overseen: Set<string> }> {
	const [led, managed] = await Promise.all([
		ledProjectIds(scope, userId, today),
		scope.clientManagers.select((m) => eq(m.userId, userId)),
	]);
	if (managed.length === 0) return { led, overseen: led };
	const ofClients = await scope.projects.select((p) =>
		among(
			p.clientId,
			managed.map((m) => m.clientId),
		),
	);
	return { led, overseen: new Set([...led, ...ofClients.map((p) => p.id)]) };
}

/**
 * Who may assign people to `clientId`'s project and end their stretches:
 * owners and admins, the client's account managers (decision 42), and the
 * project's delivery managers: those who manage its work packages.
 */
export const mayManageTeam = mayManageWorkPackages;

/**
 * Who may name a project's delivery managers, or change a delivery manager's
 * stretch: owners, admins and the client's account managers. A delivery
 * manager assigns members, and does not make others what they are.
 */
export function mayNameDeliveryManagers(
	role: Role,
	managed: readonly string[],
	clientId: string | null,
): boolean {
	return mayCreateProject(role, managed, clientId);
}

/** One stretch on a project's team, as its Team tab and the API show it. */
export interface TeamStretch {
	id: string;
	userId: string;
	name: string;
	role: TeamRole;
	startsOn: Day;
	endsOn: Day | null;
	source: AssignmentSource;
}

/**
 * Every stretch on `projectId`'s team: the open ones and those still to come
 * first, by name, then those ended, the latest first.
 */
export async function projectTeam(
	scope: OrganisationScope,
	projectId: string,
	today: Day,
): Promise<TeamStretch[]> {
	const rows = await scope.projectMembers.select((m) => eq(m.projectId, projectId));
	const names = await namesOf([...new Set(rows.map((row) => row.userId))]);
	const listed = rows.map((row) => toStretch(row, names.get(row.userId) ?? "Former member"));
	const ended = (s: TeamStretch) => s.endsOn !== null && s.endsOn < today;
	return listed.sort((a, b) => {
		if (ended(a) !== ended(b)) return ended(a) ? 1 : -1;
		if (ended(a)) return (b.endsOn ?? "").localeCompare(a.endsOn ?? "");
		return a.name.localeCompare(b.name, "en") || a.startsOn.localeCompare(b.startsOn);
	});
}

function toStretch(row: Assignment, name: string): TeamStretch {
	const role = TeamRole.safeParse(row.role);
	return {
		id: row.id,
		userId: row.userId,
		name,
		role: role.success ? role.data : "member",
		startsOn: row.startsOn,
		endsOn: row.endsOn,
		source:
			row.sourceKind === "import" || row.sourceKind === "contract" ? row.sourceKind : "manual",
	};
}

export type TeamChange = { ok: true; id: string } | { ok: false; problem: TeamProblem } | null;

/** Who did it, and through which door, for the activity record. */
export interface TeamActor {
	userId: string;
	source?: ActivitySource;
	/** What made the stretch: a person by hand, or an import with its id. */
	sourceKind?: AssignmentSource;
	sourceId?: string | null;
}

/** Whether a race let an overlapping stretch through to the trigger. */
function isOverlap(error: unknown): boolean {
	return error instanceof Error && /never overlap/.test(`${error.message} ${error.cause ?? ""}`);
}

/**
 * Puts `userId` on `projectId`'s team as `role` from `startsOn` to `endsOn`
 * (null for open). Null when the project is not of this organisation.
 * Refused when they are not a member of it, or are already on the team on
 * one of those days.
 */
export async function assignToTeam(
	scope: OrganisationScope,
	actor: TeamActor,
	input: { projectId: string; userId: string; role: TeamRole; startsOn: Day; endsOn: Day | null },
): Promise<TeamChange> {
	const [project] = await scope.projects.select((p) => eq(p.id, input.projectId), { limit: 1 });
	if (!project) return null;
	if (input.endsOn !== null && input.endsOn < input.startsOn) {
		return { ok: false, problem: "ends-before-start" };
	}
	const [member] = await scope.memberships.select((m) => eq(m.userId, input.userId), { limit: 1 });
	if (!member) return { ok: false, problem: "not-member" };
	const existing = await stretchesOf(scope, input.userId, input.projectId);
	if (existing.some((stretch) => overlaps(stretch, input)))
		return { ok: false, problem: "overlaps" };
	const row = {
		projectId: input.projectId,
		userId: input.userId,
		role: input.role,
		startsOn: input.startsOn,
		endsOn: input.endsOn,
		sourceKind: actor.sourceKind ?? "manual",
		sourceId: actor.sourceId ?? null,
		createdBy: actor.userId,
	};
	try {
		const [[added]] = await scope.batch([
			scope.projectMembers.statements.insert(row),
			recordStatement(
				scope,
				actor.userId,
				"project.member_added",
				{ type: "project", id: input.projectId },
				changes(null, row, ASSIGNMENT_FIELDS),
				actor.source,
			),
		]);
		return { ok: true, id: (added as Assignment).id };
	} catch (error) {
		if (isOverlap(error)) return { ok: false, problem: "overlaps" };
		throw error;
	}
}

/** One stretch of `projectId`'s team by its id, or undefined. */
export async function stretchOf(scope: OrganisationScope, projectId: string, id: string) {
	const [row] = await scope.projectMembers.select(
		(m) => and(eq(m.id, id), eq(m.projectId, projectId)),
		{ limit: 1 },
	);
	return row;
}

/**
 * Changes one stretch of `projectId`'s team: its last day (null for open), or
 * its role from a day. A role changed from the stretch's first day, or before,
 * is the stretch's own; from a later day, the stretch ends the day before and
 * a new one of the new role runs on to where it ran, so the history stays.
 * Null when there is no such stretch.
 */
export async function changeStretch(
	scope: OrganisationScope,
	actor: TeamActor,
	projectId: string,
	id: string,
	change: { endsOn: Day | null } | { role: TeamRole; from: Day },
): Promise<TeamChange> {
	const stretch = await stretchOf(scope, projectId, id);
	if (!stretch) return null;
	const subject = { type: "project" as const, id: projectId };
	if ("endsOn" in change) {
		if (change.endsOn !== null && change.endsOn < stretch.startsOn) {
			return { ok: false, problem: "ends-before-start" };
		}
		const others = (await stretchesOf(scope, stretch.userId, projectId)).filter(
			(other) => other.id !== id,
		);
		const after = { ...stretch, endsOn: change.endsOn };
		if (others.some((other) => overlaps(other, after))) return { ok: false, problem: "overlaps" };
		if (change.endsOn === stretch.endsOn) return { ok: true, id };
		try {
			await scope.batch([
				scope.projectMembers.statements.update(
					{ endsOn: change.endsOn, updatedAt: new Date() },
					(m) => eq(m.id, id),
				),
				recordStatement(
					scope,
					actor.userId,
					"project.member_changed",
					subject,
					changes(stretch, after, ASSIGNMENT_FIELDS),
					actor.source,
				),
			]);
		} catch (error) {
			if (isOverlap(error)) return { ok: false, problem: "overlaps" };
			throw error;
		}
		return { ok: true, id };
	}
	if (change.role === stretch.role) return { ok: true, id };
	if (stretch.endsOn !== null && change.from > stretch.endsOn) {
		return { ok: false, problem: "ends-before-start" };
	}
	if (change.from <= stretch.startsOn) {
		await scope.batch([
			scope.projectMembers.statements.update({ role: change.role, updatedAt: new Date() }, (m) =>
				eq(m.id, id),
			),
			recordStatement(
				scope,
				actor.userId,
				"project.member_changed",
				subject,
				changes(stretch, { ...stretch, role: change.role }, ASSIGNMENT_FIELDS),
				actor.source,
			),
		]);
		return { ok: true, id };
	}
	const next = {
		projectId,
		userId: stretch.userId,
		role: change.role,
		startsOn: change.from,
		endsOn: stretch.endsOn,
		sourceKind: "manual",
		sourceId: null,
		createdBy: actor.userId,
	};
	const ended = { ...stretch, endsOn: addDays(change.from, -1) };
	const [, [added]] = await scope.batch([
		scope.projectMembers.statements.update({ endsOn: ended.endsOn, updatedAt: new Date() }, (m) =>
			eq(m.id, id),
		),
		scope.projectMembers.statements.insert(next),
		recordStatement(
			scope,
			actor.userId,
			"project.member_changed",
			subject,
			changes(stretch, ended, ASSIGNMENT_FIELDS),
			actor.source,
		),
		recordStatement(
			scope,
			actor.userId,
			"project.member_added",
			subject,
			changes(null, next, ASSIGNMENT_FIELDS),
			actor.source,
		),
	]);
	return { ok: true, id: (added as Assignment).id };
}

/**
 * Takes away a stretch put there in error: one in which its person has
 * tracked no time to the project. One with time is ended instead, so what it
 * let in stays explained.
 */
export async function removeStretch(
	scope: OrganisationScope,
	actor: TeamActor,
	projectId: string,
	id: string,
): Promise<TeamChange> {
	const stretch = await stretchOf(scope, projectId, id);
	if (!stretch) return null;
	const tracked = await scope.timeEntries.select(
		(e) =>
			and(
				eq(e.userId, stretch.userId),
				eq(e.projectId, projectId),
				gte(e.spentOn, stretch.startsOn),
				stretch.endsOn === null ? undefined : lte(e.spentOn, stretch.endsOn),
			),
		{ limit: 1 },
	);
	if (tracked.length > 0) return { ok: false, problem: "has-time" };
	await scope.batch([
		scope.projectMembers.statements.delete((m) => eq(m.id, id)),
		recordStatement(
			scope,
			actor.userId,
			"project.member_removed",
			{ type: "project", id: projectId },
			changes(stretch, null, ASSIGNMENT_FIELDS),
			actor.source,
		),
	]);
	return { ok: true, id };
}

/**
 * Puts `userId` on `projectId`'s team from `day`, in one step from the picker
 * (TS-115c): an owner or an admin on any project, a delivery manager on their
 * own. The stretch runs until the day before their next one starts, or on.
 * Nobody else is let in, and nobody is let in silently: the stretch is
 * recorded as any other, marked as their own doing. Null when the project is
 * not of this organisation, or is archived; false when they may not join it.
 */
export async function joinTeam(
	scope: OrganisationScope,
	who: { userId: string; role: Role },
	projectId: string,
	day: Day,
): Promise<TeamChange | false> {
	const [project] = await scope.projects.select((p) => eq(p.id, projectId), { limit: 1 });
	if (!project || project.archivedAt !== null) return null;
	const stretches = await stretchesOf(scope, who.userId, projectId);
	const leads = stretches.some((s) => s.role === "delivery_manager");
	if (!isAdministrator(who.role) && !leads) return false;
	const covering = stretches.find((s) => covers(s, day));
	if (covering) return { ok: true, id: covering.id };
	const later = stretches.find((s) => s.startsOn > day);
	return assignToTeam(
		scope,
		{ userId: who.userId },
		{
			projectId,
			userId: who.userId,
			role: leads ? "delivery_manager" : "member",
			startsOn: day,
			endsOn: later ? addDays(later.startsOn, -1) : null,
		},
	);
}

/** What a project's Team tab shows its viewer of the project's team (TS-115c). */
export interface TeamTab {
	tracking: ProjectTracking;
	/** The stretches the viewer is shown: every one, or their own alone. */
	stretches: TeamStretch[];
	/** Whether they see the whole team, or only themselves on it. */
	seesAll: boolean;
	/** Whether they assign people and end their stretches. */
	manages: boolean;
	/** Whether they name delivery managers. */
	namesLeads: boolean;
	/** The members who may be assigned, by name; empty for those who do not manage the team. */
	people: { id: string; name: string }[];
}

/**
 * The project's team as `viewer` is shown it: the whole team to those who
 * see everyone's time (owners, admins, Finance), to managers of teams, and to
 * those who oversee the project; to anyone else, their own stretches alone.
 */
export async function teamTab(
	scope: OrganisationScope,
	viewer: {
		userId: string;
		role: Role;
		managesTeams: boolean;
		managed: readonly string[];
		leads: boolean;
		oversees: boolean;
	},
	project: { id: string; clientId: string | null },
	today: Day,
): Promise<TeamTab> {
	const manages = mayManageTeam(viewer.role, viewer.managed, project.clientId, viewer.leads);
	const seesAll = manages || viewer.oversees || viewer.managesTeams || viewer.role === "finance";
	const [tracking, team] = await Promise.all([
		trackingOf(scope),
		projectTeam(scope, project.id, today),
	]);
	let people: { id: string; name: string }[] = [];
	if (manages) {
		const members = await scope.memberships.select();
		const names = await namesOf(members.map((m) => m.userId));
		people = members
			.map((m) => ({ id: m.userId, name: names.get(m.userId) ?? "Former member" }))
			.sort((a, b) => a.name.localeCompare(b.name, "en"));
	}
	return {
		tracking,
		stretches: seesAll ? team : team.filter((s) => s.userId === viewer.userId),
		seesAll,
		manages,
		namesLeads: mayNameDeliveryManagers(viewer.role, viewer.managed, project.clientId),
		people,
	};
}
