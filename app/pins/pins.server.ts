import { and, eq, isNotNull } from "drizzle-orm";

import type { OrganisationScope } from "~/db";

// Pins (TS-122, S2-09; docs/decisions.md entry 65): the projects and people a
// member keeps at the top of their own lists. A pin is the pinner's alone; the
// table's references take it away when they leave, when the project goes, and
// when the pinned person leaves. Who may pin what is the page's rule: any
// project of the organisation, and a person the pinner sees on Team.

/** What pinning or unpinning came to: done, or no such project or person here. */
export type PinChange = "done" | "missing";

/** The projects `userId` pinned. */
export async function pinnedProjectIds(
	scope: OrganisationScope,
	userId: string,
): Promise<string[]> {
	const rows = await scope.pins.select((p) => and(eq(p.userId, userId), isNotNull(p.projectId)));
	return rows.flatMap((row) => (row.projectId === null ? [] : [row.projectId]));
}

/** The people `userId` pinned. */
export async function pinnedPeopleIds(scope: OrganisationScope, userId: string): Promise<string[]> {
	const rows = await scope.pins.select((p) => and(eq(p.userId, userId), isNotNull(p.personId)));
	return rows.flatMap((row) => (row.personId === null ? [] : [row.personId]));
}

/**
 * Pins a project of the organisation for `userId`, or unpins it. Pinning one
 * already pinned, or unpinning one that is not, changes nothing and is done.
 */
export async function pinProject(
	scope: OrganisationScope,
	userId: string,
	projectId: string,
	pinned: boolean,
): Promise<PinChange> {
	if (!pinned) {
		await scope.pins.delete((p) => and(eq(p.userId, userId), eq(p.projectId, projectId)));
		return "done";
	}
	const [project] = await scope.projects.select((p) => eq(p.id, projectId), { limit: 1 });
	if (!project) return "missing";
	await scope.batch([scope.pins.statements.insertIfAbsent({ userId, projectId })]);
	return "done";
}

/**
 * Pins a person for `userId`, or unpins them. The caller has checked that
 * `personId` is somebody `userId` may see; a person who is not a member here
 * is missing.
 */
export async function pinPerson(
	scope: OrganisationScope,
	userId: string,
	personId: string,
	pinned: boolean,
): Promise<PinChange> {
	if (!pinned) {
		await scope.pins.delete((p) => and(eq(p.userId, userId), eq(p.personId, personId)));
		return "done";
	}
	const [member] = await scope.memberships.select((m) => eq(m.userId, personId), { limit: 1 });
	if (!member) return "missing";
	await scope.batch([scope.pins.statements.insertIfAbsent({ userId, personId })]);
	return "done";
}
