import { and, asc, eq, isNull, ne } from "drizzle-orm";

import { findActiveClient } from "~/clients/clients.server";
import type { OrganisationScope } from "~/db";
import { isNameClash, nameKey, RECORD_NAME_PROBLEM, recordName } from "~/lib/names";

/**
 * The projects of one organisation, as more than one destination reads them:
 * the timer chooses from the active ones (TS-012a), Projects lists and keeps
 * them (TS-011a), reports name them (TS-014a). Every role sees and manages
 * every project. A project is archived, never deleted, so an entry always has
 * its project (decision 25).
 */

export const PROJECT_NAME_TAKEN = "A project with this name already exists.";
export const CLIENT_NOT_OFFERED = "Choose an active client, or none.";

/** What a write answered: the project's name as stored, a sentence for the person, or null for no such project here. */
export type ProjectResult = { ok: true; name: string } | { ok: false; problem: string } | null;

/** The organisation's active projects, by name. */
export function activeProjects(scope: OrganisationScope) {
	return scope.projects.select((p) => isNull(p.archivedAt), {
		orderBy: (p) => [asc(p.nameKey)],
	});
}

/** The active project of this organisation with this id, or null: one archived or of another organisation is none. */
export async function findActiveProject(scope: OrganisationScope, id: string) {
	const [project] = await scope.projects.select((p) => and(eq(p.id, id), isNull(p.archivedAt)), {
		limit: 1,
	});
	return project ?? null;
}

/** Every project of the organisation, active and archived, by name, each with its client. */
export async function listProjects(scope: OrganisationScope) {
	const [projects, clients] = await Promise.all([
		scope.projects.select(undefined, { orderBy: (p) => [asc(p.nameKey)] }),
		scope.clients.select(),
	]);
	const byId = new Map(clients.map((client) => [client.id, client]));
	return projects.map((project) => {
		const client = project.clientId ? byId.get(project.clientId) : undefined;
		return {
			id: project.id,
			name: project.name,
			archived: project.archivedAt !== null,
			client: client
				? { id: client.id, name: client.name, archived: client.archivedAt !== null }
				: null,
		};
	});
}

/** Whether another project of the organisation, archived or not, already has this name. */
async function nameTaken(scope: OrganisationScope, key: string, except?: string) {
	const found = await scope.projects.select(
		(p) => and(eq(p.nameKey, key), except ? ne(p.id, except) : undefined),
		{ limit: 1 },
	);
	return found.length > 0;
}

/**
 * What a project is to have. `clientId` is left out to leave the client as it
 * is, null for none. Who may give a client is the caller's to decide.
 */
export interface ProjectInput {
	name: string;
	clientId?: string | null;
}

/** Adds a project with the name typed, and the client given, which is active. */
export async function createProject(
	scope: OrganisationScope,
	{ name: typed, clientId = null }: ProjectInput,
): Promise<ProjectResult> {
	const name = recordName(typed);
	if (name === null) return { ok: false, problem: RECORD_NAME_PROBLEM };
	const key = nameKey(name);
	if (await nameTaken(scope, key)) return { ok: false, problem: PROJECT_NAME_TAKEN };
	if (clientId !== null && !(await findActiveClient(scope, clientId))) {
		return { ok: false, problem: CLIENT_NOT_OFFERED };
	}
	try {
		await scope.projects.insert({ name, nameKey: key, clientId });
	} catch (error) {
		if (isNameClash(error)) return { ok: false, problem: PROJECT_NAME_TAKEN };
		throw error;
	}
	return { ok: true, name };
}

/**
 * Gives the project `id` the name typed, and the client given. Its own name in
 * other letters is no clash. An archived client is never given, but a project
 * that already has one keeps it.
 */
export async function changeProject(
	scope: OrganisationScope,
	id: string,
	{ name: typed, clientId }: ProjectInput,
): Promise<ProjectResult> {
	const [project] = await scope.projects.select((p) => eq(p.id, id), { limit: 1 });
	if (!project) return null;

	const name = recordName(typed);
	if (name === null) return { ok: false, problem: RECORD_NAME_PROBLEM };
	const key = nameKey(name);
	if (await nameTaken(scope, key, id)) return { ok: false, problem: PROJECT_NAME_TAKEN };
	const keepsClient = clientId === undefined || clientId === project.clientId;
	if (!keepsClient && clientId !== null && !(await findActiveClient(scope, clientId))) {
		return { ok: false, problem: CLIENT_NOT_OFFERED };
	}
	try {
		const [changed] = await scope.projects.update(
			keepsClient ? { name, nameKey: key } : { name, nameKey: key, clientId },
			(p) => eq(p.id, id),
		);
		return changed ? { ok: true, name } : null;
	} catch (error) {
		if (isNameClash(error)) return { ok: false, problem: PROJECT_NAME_TAKEN };
		throw error;
	}
}

/** Archives the project `id`, or restores it with `archived` false. Its entries are not touched. */
export async function setProjectArchived(
	scope: OrganisationScope,
	id: string,
	archived: boolean,
): Promise<ProjectResult> {
	const [changed] = await scope.projects.update({ archivedAt: archived ? new Date() : null }, (p) =>
		eq(p.id, id),
	);
	return changed ? { ok: true, name: changed.name } : null;
}
