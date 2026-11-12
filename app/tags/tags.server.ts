import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { changes, record, recordStatement } from "~/activity/activity.server";
import { type OrganisationScope, uuidv7 } from "~/db";
import { isNameClash, nameKey, RECORD_NAME_PROBLEM, recordName } from "~/lib/names";

/**
 * Tags (TS-085): words an organisation categorises its entries, expenses
 * and projects with. Owners and admins keep the list (`mayManageTasks`, as
 * for the task list); a person puts tags on their own entries and expenses,
 * and an owner or admin on projects. A tag is archived, never deleted: an
 * archived tag cannot be added to anything, and stays on what has it. A
 * project's tags count for its entries in a report's tag filter.
 */

export const TAG_NAME_TAKEN = "A tag with this name already exists.";
export const TAG_NOT_OFFERED = "Choose active tags only.";

/** What a write answered: the tag's name, a sentence for the person, or null for no such tag here. */
export type TagResult = { ok: true; name: string } | { ok: false; problem: string } | null;

/** A tag as a page shows it. */
export interface TagView {
	id: string;
	name: string;
	archived: boolean;
}

/** Every tag of the organisation, active and archived, by name, with how many entries and projects have it. */
export async function listTags(scope: OrganisationScope) {
	const [tags, entries, projects] = await Promise.all([
		scope.tags.select(undefined, { orderBy: (t) => [asc(t.nameKey)] }),
		scope.entryTags.sum(
			() => sql<number>`1`,
			(et) => et.tagId,
		),
		scope.projectTags.sum(
			() => sql<number>`1`,
			(pt) => pt.tagId,
		),
	]);
	const entryCount = new Map(entries.map(({ key, total }) => [key, total]));
	const projectCount = new Map(projects.map(({ key, total }) => [key, total]));
	return tags.map((tag) => ({
		id: tag.id,
		name: tag.name,
		archived: tag.archivedAt !== null,
		entries: entryCount.get(tag.id) ?? 0,
		projects: projectCount.get(tag.id) ?? 0,
	}));
}

/** The organisation's tags, active and archived, by name, as a picker or a filter offers them. */
export async function tagOptions(scope: OrganisationScope): Promise<TagView[]> {
	const tags = await scope.tags.select(undefined, { orderBy: (t) => [asc(t.nameKey)] });
	return tags.map((tag) => ({ id: tag.id, name: tag.name, archived: tag.archivedAt !== null }));
}

async function nameTaken(scope: OrganisationScope, key: string, except?: string) {
	const found = await scope.tags.select(
		(t) => and(eq(t.nameKey, key), except ? ne(t.id, except) : undefined),
		{ limit: 1 },
	);
	return found.length > 0;
}

export async function createTag(
	scope: OrganisationScope,
	actor: string,
	typed: string,
): Promise<TagResult> {
	const name = recordName(typed);
	if (name === null) return { ok: false, problem: RECORD_NAME_PROBLEM };
	const key = nameKey(name);
	if (await nameTaken(scope, key)) return { ok: false, problem: TAG_NAME_TAKEN };
	const id = uuidv7();
	try {
		await scope.batch([
			scope.tags.statements.insert({ id, name, nameKey: key }),
			recordStatement(
				scope,
				actor,
				"tag.created",
				{ type: "tag", id },
				changes(null, { name }, ["name"]),
			),
		]);
	} catch (error) {
		if (isNameClash(error)) return { ok: false, problem: TAG_NAME_TAKEN };
		throw error;
	}
	return { ok: true, name };
}

export async function renameTag(
	scope: OrganisationScope,
	actor: string,
	id: string,
	typed: string,
): Promise<TagResult> {
	const [tag] = await scope.tags.select((t) => eq(t.id, id), { limit: 1 });
	if (!tag) return null;
	const name = recordName(typed);
	if (name === null) return { ok: false, problem: RECORD_NAME_PROBLEM };
	const key = nameKey(name);
	if (await nameTaken(scope, key, id)) return { ok: false, problem: TAG_NAME_TAKEN };
	try {
		await scope.batch([
			scope.tags.statements.update({ name, nameKey: key }, (t) => eq(t.id, id)),
			recordStatement(
				scope,
				actor,
				"tag.renamed",
				{ type: "tag", id },
				changes(tag, { name }, ["name"]),
			),
		]);
	} catch (error) {
		if (isNameClash(error)) return { ok: false, problem: TAG_NAME_TAKEN };
		throw error;
	}
	return { ok: true, name };
}

export async function setTagArchived(
	scope: OrganisationScope,
	actor: string,
	id: string,
	archived: boolean,
): Promise<TagResult> {
	const [changed] = await scope.tags.update({ archivedAt: archived ? new Date() : null }, (t) =>
		eq(t.id, id),
	);
	if (!changed) return null;
	await record(scope, actor, archived ? "tag.archived" : "tag.restored", { type: "tag", id });
	return { ok: true, name: changed.name };
}

/**
 * Whether `wanted` may be the tags of something that has `current` now:
 * every tag added must be an active tag of the organisation; one it already
 * has may stay though it has been archived since.
 */
export async function tagsAllowed(
	scope: OrganisationScope,
	current: readonly string[],
	wanted: readonly string[],
): Promise<boolean> {
	const added = [...new Set(wanted)].filter((id) => !current.includes(id));
	if (added.length === 0) return true;
	if (added.length > 50) return false;
	const active = await scope.tags.select((t) => and(inArray(t.id, added), isNull(t.archivedAt)));
	return active.length === added.length;
}

/** The tags of each of these entries, by id. */
export async function tagsOfEntries(
	scope: OrganisationScope,
	entryIds: readonly string[],
): Promise<Map<string, string[]>> {
	const byEntry = new Map<string, string[]>();
	if (entryIds.length === 0) return byEntry;
	const rows = await scope.entryTags.select(
		(et) => sql`${et.timeEntryId} in (select value from json_each(${JSON.stringify(entryIds)}))`,
	);
	for (const row of rows) {
		byEntry.set(row.timeEntryId, [...(byEntry.get(row.timeEntryId) ?? []), row.tagId]);
	}
	return byEntry;
}

/** The tag ids of one project. */
export async function tagsOfProject(scope: OrganisationScope, projectId: string) {
	const rows = await scope.projectTags.select((pt) => eq(pt.projectId, projectId));
	return rows.map((row) => row.tagId);
}

/**
 * The statements that make an entry's tags exactly `tagIds`: those it loses
 * are removed, those it gains added. Check `tagsAllowed` first.
 */
export function entryTagStatements(
	scope: OrganisationScope,
	entryId: string,
	current: readonly string[],
	tagIds: readonly string[],
) {
	const wanted = [...new Set(tagIds)];
	const removed = current.filter((id) => !wanted.includes(id));
	const added = wanted.filter((id) => !current.includes(id));
	return [
		...(removed.length > 0
			? [
					scope.entryTags.statements.delete((et) =>
						and(eq(et.timeEntryId, entryId), inArray(et.tagId, removed)),
					),
				]
			: []),
		...(added.length > 0
			? [scope.entryTags.statements.insert(added.map((tagId) => ({ timeEntryId: entryId, tagId })))]
			: []),
	];
}

/** The tags of each of these expenses, by id. */
export async function tagsOfExpenses(
	scope: OrganisationScope,
	expenseIds: readonly string[],
): Promise<Map<string, string[]>> {
	const byExpense = new Map<string, string[]>();
	if (expenseIds.length === 0) return byExpense;
	const rows = await scope.expenseTags.select(
		(et) => sql`${et.expenseId} in (select value from json_each(${JSON.stringify(expenseIds)}))`,
	);
	for (const row of rows) {
		byExpense.set(row.expenseId, [...(byExpense.get(row.expenseId) ?? []), row.tagId]);
	}
	return byExpense;
}

/**
 * The statements that make an expense's tags exactly `tagIds`, as
 * `entryTagStatements` does for an entry. Check `tagsAllowed` first.
 */
export function expenseTagStatements(
	scope: OrganisationScope,
	expenseId: string,
	current: readonly string[],
	tagIds: readonly string[],
) {
	const wanted = [...new Set(tagIds)];
	const removed = current.filter((id) => !wanted.includes(id));
	const added = wanted.filter((id) => !current.includes(id));
	return [
		...(removed.length > 0
			? [
					scope.expenseTags.statements.delete((et) =>
						and(eq(et.expenseId, expenseId), inArray(et.tagId, removed)),
					),
				]
			: []),
		...(added.length > 0
			? [scope.expenseTags.statements.insert(added.map((tagId) => ({ expenseId, tagId })))]
			: []),
	];
}

/** Makes a project's tags exactly `tagIds`, for an owner or admin. Null for no such project here. */
export async function setProjectTags(
	scope: OrganisationScope,
	actor: string,
	projectId: string,
	tagIds: readonly string[],
): Promise<TagResult> {
	const [project] = await scope.projects.select((p) => eq(p.id, projectId), { limit: 1 });
	if (!project) return null;
	const current = await tagsOfProject(scope, projectId);
	if (!(await tagsAllowed(scope, current, tagIds))) return { ok: false, problem: TAG_NOT_OFFERED };
	const wanted = [...new Set(tagIds)];
	const removed = current.filter((id) => !wanted.includes(id));
	const added = wanted.filter((id) => !current.includes(id));
	if (removed.length === 0 && added.length === 0) return { ok: true, name: project.name };
	await scope.batch([
		recordStatement(
			scope,
			actor,
			"project.updated",
			{ type: "project", id: projectId },
			{ before: { tags: current.join(",") }, after: { tags: wanted.join(",") } },
		),
		...(removed.length > 0
			? [
					scope.projectTags.statements.delete((pt) =>
						and(eq(pt.projectId, projectId), inArray(pt.tagId, removed)),
					),
				]
			: []),
		...(added.length > 0
			? [scope.projectTags.statements.insert(added.map((tagId) => ({ projectId, tagId })))]
			: []),
	]);
	return { ok: true, name: project.name };
}
