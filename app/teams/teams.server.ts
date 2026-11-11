import { and, eq, inArray } from "drizzle-orm";

import type { OrganisationScope } from "~/db";

/**
 * Teams and their managers (TS-038, docs/decisions.md entry 29). A manager is
 * a role a person holds for one team: `team_members.is_manager`. What a
 * manager may see is the time of the members of the teams they manage, read
 * from the database on every request, so a change takes effect on the next.
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
	const rows = await scope.teamMembers.select((t) => inArray(t.teamId, teams));
	return new Set(rows.map((row) => row.userId));
}
