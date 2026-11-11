import { and, asc, eq, isNull } from "drizzle-orm";

import type { OrganisationScope } from "~/db";

/**
 * The projects of one organisation, as more than one destination reads them:
 * the timer chooses from the active ones (TS-012a), Projects lists them
 * (TS-011a), reports name them (TS-014a). Every role sees every project.
 */

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
