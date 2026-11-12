import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import type { OrganisationScope } from "~/db";

/** How many of the person's latest entries are read for their recent projects. */
const ENTRIES_READ = 50;

/**
 * The person's recent projects, for the head of the project picker: the
 * distinct projects of their latest time entries, most recent first, archived
 * ones left out, at most `limit`.
 */
export async function recentProjectIds(
	scope: OrganisationScope,
	userId: string,
	limit = 5,
): Promise<string[]> {
	const entries = await scope.timeEntries.select((e) => eq(e.userId, userId), {
		orderBy: (e) => [desc(e.startedAt)],
		limit: ENTRIES_READ,
	});
	const ids = [...new Set(entries.map((e) => e.projectId))];
	if (ids.length === 0) return [];
	const active = new Set(
		(await scope.projects.select((p) => and(inArray(p.id, ids), isNull(p.archivedAt)))).map(
			(p) => p.id,
		),
	);
	return ids.filter((id) => active.has(id)).slice(0, limit);
}
