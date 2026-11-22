import { and, asc, eq, ne } from "drizzle-orm";

import { changes, record, recordStatement } from "~/activity/activity.server";
import { among, type OrganisationScope, uuidv7 } from "~/db";
import { nameKey } from "~/lib/names";

/**
 * Teams and their managers (TS-038, docs/decisions.md entry 29). A manager is
 * a role a person holds for one team: `team_members.is_manager`. What a
 * manager may see is the time of the members of the teams they manage, read
 * from the database on every request, so a change takes effect on the next.
 * Every change is recorded in the activity log as the act of `actor`, the
 * person who made it.
 */

/** The ids of the teams `userId` manages in the organisation. */
export async function managedTeams(scope: OrganisationScope, userId: string): Promise<string[]> {
	const rows = await scope.teamMembers.select((t) =>
		and(eq(t.userId, userId), eq(t.isManager, true)),
	);
	return rows.map((row) => row.teamId);
}

/**
 * The people `userId` manages: every member of every team they manage, the
 * other managers of those teams included, and `userId` too when they are in one.
 */
export async function managedPeople(
	scope: OrganisationScope,
	userId: string,
): Promise<Set<string>> {
	const teams = await managedTeams(scope, userId);
	if (teams.length === 0) return new Set();
	const rows = await scope.teamMembers.select((t) => among(t.teamId, teams));
	return new Set(rows.map((row) => row.userId));
}

/** A team and its places: who is in it, and which of them manage it. */
export interface TeamWithMembers {
	id: string;
	name: string;
	members: { userId: string; isManager: boolean }[];
}

/** The organisation's teams by name, or those among `only`, each with its members. */
export async function teamsWithMembers(
	scope: OrganisationScope,
	only?: readonly string[],
): Promise<TeamWithMembers[]> {
	if (only?.length === 0) return [];
	const [teams, places] = await Promise.all([
		scope.teams.select((t) => (only ? among(t.id, only) : undefined), {
			orderBy: (t) => [asc(t.nameKey)],
		}),
		scope.teamMembers.select((t) => (only ? among(t.teamId, only) : undefined)),
	]);
	return teams.map((team) => ({
		id: team.id,
		name: team.name,
		members: places
			.filter((place) => place.teamId === team.id)
			.map(({ userId, isManager }) => ({ userId, isManager })),
	}));
}

/**
 * What a change to the teams came to. `taken`: another team of the
 * organisation has that name. `missing`: the team, or the person's place in
 * it, is no longer there. `not-member`: the person is not a member of the
 * organisation. `already`: they are in the team already.
 */
export type TeamChange = "done" | "taken" | "missing" | "not-member" | "already";

async function nameTaken(scope: OrganisationScope, name: string, except?: string) {
	const key = nameKey(name);
	const found = await scope.teams.select(
		(t) => and(eq(t.nameKey, key), except ? ne(t.id, except) : undefined),
		{ limit: 1 },
	);
	return found.length > 0;
}

/** Whether `error` is SQLite refusing a second row with the same unique value. */
function isUniqueViolation(error: unknown): boolean {
	return (
		error instanceof Error && /UNIQUE constraint failed/.test(`${error.message} ${error.cause}`)
	);
}

/** Creates a team called `name`, unless the organisation has one called that already. */
export async function createTeam(
	scope: OrganisationScope,
	actor: string,
	name: string,
): Promise<TeamChange> {
	if (await nameTaken(scope, name)) return "taken";
	const id = uuidv7();
	try {
		await scope.batch([
			scope.teams.statements.insert({ id, name, nameKey: nameKey(name) }),
			recordStatement(
				scope,
				actor,
				"team.created",
				{ type: "team", id },
				changes(null, { name }, ["name"]),
			),
		]);
	} catch (error) {
		if (isUniqueViolation(error)) return "taken";
		throw error;
	}
	return "done";
}

/** Gives the team `teamId` the name `name`. */
export async function renameTeam(
	scope: OrganisationScope,
	actor: string,
	teamId: string,
	name: string,
): Promise<TeamChange> {
	if (await nameTaken(scope, name, teamId)) return "taken";
	const [team] = await scope.teams.select((t) => eq(t.id, teamId), { limit: 1 });
	if (!team) return "missing";
	try {
		await scope.batch([
			scope.teams.statements.update({ name, nameKey: nameKey(name), updatedAt: new Date() }, (t) =>
				eq(t.id, teamId),
			),
			recordStatement(
				scope,
				actor,
				"team.renamed",
				{ type: "team", id: teamId },
				changes(team, { name }, ["name"]),
			),
		]);
		return "done";
	} catch (error) {
		if (isUniqueViolation(error)) return "taken";
		throw error;
	}
}

/** Deletes the team `teamId`; its places go with it, and its managers stop managing it. */
export async function deleteTeam(
	scope: OrganisationScope,
	actor: string,
	teamId: string,
): Promise<TeamChange> {
	const [deleted] = await scope.teams.delete((t) => eq(t.id, teamId));
	if (!deleted) return "missing";
	await record(
		scope,
		actor,
		"team.deleted",
		{ type: "team", id: teamId },
		changes(deleted, null, ["name"]),
	);
	return "done";
}

/** Puts `userId`, a member of the organisation, in the team `teamId`, as its manager or not. */
export async function addToTeam(
	scope: OrganisationScope,
	actor: string,
	teamId: string,
	userId: string,
	isManager: boolean,
): Promise<TeamChange> {
	const [[team], [membership], [place]] = await Promise.all([
		scope.teams.select((t) => eq(t.id, teamId), { limit: 1 }),
		scope.memberships.select((m) => eq(m.userId, userId), { limit: 1 }),
		scope.teamMembers.select((t) => and(eq(t.teamId, teamId), eq(t.userId, userId)), {
			limit: 1,
		}),
	]);
	if (!team) return "missing";
	if (!membership) return "not-member";
	if (place) return "already";
	try {
		await scope.batch([
			scope.teamMembers.statements.insert({ teamId, userId, isManager }),
			recordStatement(
				scope,
				actor,
				"team.member_added",
				{ type: "team", id: teamId, ownerId: userId },
				changes(null, { isManager }, ["isManager"]),
			),
		]);
	} catch (error) {
		if (isUniqueViolation(error)) return "already";
		throw error;
	}
	return "done";
}

/** Takes `userId` out of the team `teamId`, which also ends their time as its manager. */
export async function removeFromTeam(
	scope: OrganisationScope,
	actor: string,
	teamId: string,
	userId: string,
): Promise<TeamChange> {
	const [removed] = await scope.teamMembers.delete((t) =>
		and(eq(t.teamId, teamId), eq(t.userId, userId)),
	);
	if (!removed) return "missing";
	await record(
		scope,
		actor,
		"team.member_removed",
		{ type: "team", id: teamId, ownerId: userId },
		changes(removed, null, ["isManager"]),
	);
	return "done";
}

/** Makes `userId` a manager of the team `teamId`, or ends their time as one; they stay in it. */
export async function setManager(
	scope: OrganisationScope,
	actor: string,
	teamId: string,
	userId: string,
	isManager: boolean,
): Promise<TeamChange> {
	const [place] = await scope.teamMembers.select(
		(t) => and(eq(t.teamId, teamId), eq(t.userId, userId)),
		{ limit: 1 },
	);
	if (!place) return "missing";
	if (place.isManager === isManager) return "done";
	const changed = await scope.teamMembers.update({ isManager, updatedAt: new Date() }, (t) =>
		and(eq(t.teamId, teamId), eq(t.userId, userId)),
	);
	if (changed.length === 0) return "missing";
	await record(
		scope,
		actor,
		"team.manager_changed",
		{ type: "team", id: teamId, ownerId: userId },
		changes(place, { isManager }, ["isManager"]),
	);
	return "done";
}
