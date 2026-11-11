import { and, asc, eq, isNotNull, isNull, ne } from "drizzle-orm";

import type { OrganisationScope } from "~/db";
import { isNameClash, nameKey, RECORD_NAME_PROBLEM, recordName } from "~/lib/names";
import { nameHas } from "~/projects/search.server";

/**
 * Whom an organisation's projects are for (TS-011b). Owners and admins keep
 * the list on Clients and give a project a client or none; everybody else
 * reads a project's client by its name (docs/navigation.md). A client is
 * archived, never deleted: an archived client is offered to no project, and
 * the projects that have it keep it.
 */

export const CLIENT_NAME_TAKEN = "A client with this name already exists.";

/** What a write answered: the client's name as stored, a sentence for the person, or null for no such client here. */
export type ClientResult = { ok: true; name: string } | { ok: false; problem: string } | null;

/**
 * Every client of the organisation, active and archived, by name, each with
 * its projects by name; those whose name has the words typed in the filter,
 * when there are some, narrowed in SQL (TS-057).
 */
export async function listClients(scope: OrganisationScope, query: string) {
	const [clients, projects] = await Promise.all([
		scope.clients.select(nameKey(query) === "" ? undefined : (c) => nameHas(c.nameKey, query), {
			orderBy: (c) => [asc(c.nameKey)],
		}),
		scope.projects.select((p) => isNotNull(p.clientId), { orderBy: (p) => [asc(p.nameKey)] }),
	]);
	return clients.map((client) => ({
		id: client.id,
		name: client.name,
		archived: client.archivedAt !== null,
		projects: projects
			.filter((project) => project.clientId === client.id)
			.map((project) => ({ name: project.name, archived: project.archivedAt !== null })),
	}));
}

/** The organisation's active clients, by name: what a project may be given. */
export function activeClients(scope: OrganisationScope) {
	return scope.clients.select((c) => isNull(c.archivedAt), { orderBy: (c) => [asc(c.nameKey)] });
}

/** The active client of this organisation with this id, or null: one archived or of another organisation is none. */
export async function findActiveClient(scope: OrganisationScope, id: string) {
	const [client] = await scope.clients.select((c) => and(eq(c.id, id), isNull(c.archivedAt)), {
		limit: 1,
	});
	return client ?? null;
}

/** Whether another client of the organisation, archived or not, already has this name. */
async function nameTaken(scope: OrganisationScope, key: string, except?: string) {
	const found = await scope.clients.select(
		(c) => and(eq(c.nameKey, key), except ? ne(c.id, except) : undefined),
		{ limit: 1 },
	);
	return found.length > 0;
}

/** Adds a client with the name typed. */
export async function createClient(scope: OrganisationScope, typed: string): Promise<ClientResult> {
	const name = recordName(typed);
	if (name === null) return { ok: false, problem: RECORD_NAME_PROBLEM };
	const key = nameKey(name);
	if (await nameTaken(scope, key)) return { ok: false, problem: CLIENT_NAME_TAKEN };
	try {
		await scope.clients.insert({ name, nameKey: key });
	} catch (error) {
		if (isNameClash(error)) return { ok: false, problem: CLIENT_NAME_TAKEN };
		throw error;
	}
	return { ok: true, name };
}

/** Gives the client `id` the name typed. Its own name in other letters is no clash. */
export async function renameClient(
	scope: OrganisationScope,
	id: string,
	typed: string,
): Promise<ClientResult> {
	const [client] = await scope.clients.select((c) => eq(c.id, id), { limit: 1 });
	if (!client) return null;

	const name = recordName(typed);
	if (name === null) return { ok: false, problem: RECORD_NAME_PROBLEM };
	const key = nameKey(name);
	if (await nameTaken(scope, key, id)) return { ok: false, problem: CLIENT_NAME_TAKEN };
	try {
		const [renamed] = await scope.clients.update({ name, nameKey: key }, (c) => eq(c.id, id));
		return renamed ? { ok: true, name } : null;
	} catch (error) {
		if (isNameClash(error)) return { ok: false, problem: CLIENT_NAME_TAKEN };
		throw error;
	}
}

/** Archives the client `id`, or restores it with `archived` false. Its projects are not touched. */
export async function setClientArchived(
	scope: OrganisationScope,
	id: string,
	archived: boolean,
): Promise<ClientResult> {
	const [changed] = await scope.clients.update({ archivedAt: archived ? new Date() : null }, (c) =>
		eq(c.id, id),
	);
	return changed ? { ok: true, name: changed.name } : null;
}
