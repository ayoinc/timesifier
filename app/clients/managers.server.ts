import { and, eq } from "drizzle-orm";

import { recordStatement } from "~/activity/activity.server";
import type { OrganisationScope } from "~/db";
import type { Role } from "~/organisations/roles";

/**
 * A client's account managers (TS-115a, decision 42): members who create
 * projects for that client, and only for that client. Owners and admins name
 * them on Clients › a client; each change is recorded with the person as its
 * owner.
 */

/** The ids of the clients `userId` is an account manager of. */
export async function managedClientIds(
	scope: OrganisationScope,
	userId: string,
): Promise<string[]> {
	const rows = await scope.clientManagers.select((m) => eq(m.userId, userId));
	return rows.map((row) => row.clientId);
}

/** The account managers of every client, as client id to their user ids. */
export async function managersByClient(scope: OrganisationScope): Promise<Map<string, string[]>> {
	const rows = await scope.clientManagers.select();
	const byClient = new Map<string, string[]>();
	for (const row of rows)
		byClient.set(row.clientId, [...(byClient.get(row.clientId) ?? []), row.userId]);
	return byClient;
}

/**
 * Who may create a project for `clientId` (decision 42): owners and admins for
 * any client or none; an account manager for a client they manage; nobody else.
 */
export function mayCreateProject(
	role: Role,
	managed: readonly string[],
	clientId: string | null,
): boolean {
	if (role === "owner" || role === "admin") return true;
	return clientId !== null && managed.includes(clientId);
}

/** Whether `role` with `managed` clients may create any project at all, and so is offered Create. */
export function mayCreateAnyProject(role: Role, managed: readonly string[]): boolean {
	return role === "owner" || role === "admin" || managed.length > 0;
}

export const MANAGER_NOT_A_MEMBER = "Choose a member of this organisation.";

/**
 * Makes `userId` an account manager of `clientId`, or stops them being one
 * with `on` false. False when the client or the member is not of this
 * organisation; true when the change was made or was already so, in which case
 * nothing is recorded.
 */
export async function setClientManager(
	scope: OrganisationScope,
	actor: string,
	clientId: string,
	userId: string,
	on: boolean,
): Promise<boolean> {
	const [[client], [member], [existing]] = await Promise.all([
		scope.clients.select((c) => eq(c.id, clientId), { limit: 1 }),
		scope.memberships.select((m) => eq(m.userId, userId), { limit: 1 }),
		scope.clientManagers.select((m) => and(eq(m.clientId, clientId), eq(m.userId, userId)), {
			limit: 1,
		}),
	]);
	if (!client || !member) return false;
	if (on === Boolean(existing)) return true;
	const subject = { type: "client", id: clientId, ownerId: userId } as const;
	await scope.batch([
		on
			? scope.clientManagers.statements.insert({ clientId, userId })
			: scope.clientManagers.statements.delete((m) =>
					and(eq(m.clientId, clientId), eq(m.userId, userId)),
				),
		recordStatement(scope, actor, on ? "client.manager_added" : "client.manager_removed", subject),
	]);
	return true;
}
