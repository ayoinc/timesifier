import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";

import { changes, record, recordStatement } from "~/activity/activity.server";
import { among, type OrganisationScope, type ScopedStatement, uuidv7 } from "~/db";
import { isNameClash, nameKey, RECORD_NAME_PROBLEM, recordName } from "~/lib/names";

/**
 * Tasks (TS-066, B4): the kinds of work an organisation's time is tracked
 * to. Owners and admins keep the organisation's list (`mayManageTasks`); each
 * project has its own list of them, each billable or not on that project,
 * and a new project starts with the common ones (the trigger
 * `projects_common_tasks`, migration 0009). An entry has a task from its
 * project's list and is billable when that task is billable there. A task is
 * archived, never deleted: an archived task is offered for no new entry, and
 * the entries that have it keep it. Every change is recorded in the activity
 * log as the act of `actor`.
 */

export const TASK_NAME_TAKEN = "A task with this name already exists.";
export const TASK_NOT_OFFERED = "Choose an active task of this project.";

/** What a write answered: the task's name, a sentence for the person, or null for no such task here. */
export type TaskResult = { ok: true; name: string } | { ok: false; problem: string } | null;

/** Every task of the organisation, active and archived, by name, with the number of projects it is on. */
export async function listTasks(scope: OrganisationScope) {
	const [tasks, onProjects] = await Promise.all([
		scope.tasks.select(undefined, { orderBy: (t) => [asc(t.nameKey)] }),
		scope.projectTasks.sum(
			() => sql<number>`1`,
			(pt) => pt.taskId,
		),
	]);
	const projects = new Map(onProjects.map(({ key, total }) => [key, total]));
	return tasks.map((task) => ({
		id: task.id,
		name: task.name,
		billableByDefault: task.billableByDefault,
		common: task.common,
		archived: task.archivedAt !== null,
		projects: projects.get(task.id) ?? 0,
	}));
}

/** The organisation's active tasks, by name. */
export function activeTasks(scope: OrganisationScope) {
	return scope.tasks.select((t) => isNull(t.archivedAt), { orderBy: (t) => [asc(t.nameKey)] });
}

async function nameTaken(scope: OrganisationScope, key: string, except?: string) {
	const found = await scope.tasks.select(
		(t) => and(eq(t.nameKey, key), except ? ne(t.id, except) : undefined),
		{ limit: 1 },
	);
	return found.length > 0;
}

/** What a task is to have. */
export interface TaskInput {
	name: string;
	billableByDefault: boolean;
	common: boolean;
}

/** Whether a project bills nothing, which makes every task on it non-billable (B5). */
const billsNothing = (project: { billingType: string }) => project.billingType === "non_billable";

/**
 * Adds a task to the organisation's list. With `addToAllProjects` it is put
 * on every project, archived ones included, billable where its default says
 * and the project bills.
 */
export async function createTask(
	scope: OrganisationScope,
	actor: string,
	input: TaskInput & { addToAllProjects: boolean },
): Promise<TaskResult> {
	const name = recordName(input.name);
	if (name === null) return { ok: false, problem: RECORD_NAME_PROBLEM };
	const key = nameKey(name);
	if (await nameTaken(scope, key)) return { ok: false, problem: TASK_NAME_TAKEN };
	const id = uuidv7();
	const projects = input.addToAllProjects ? await scope.projects.select() : [];
	try {
		await scope.batch([
			scope.tasks.statements.insert({
				id,
				name,
				nameKey: key,
				billableByDefault: input.billableByDefault,
				common: input.common,
			}),
			...projects.map((project) =>
				scope.projectTasks.statements.insert({
					projectId: project.id,
					taskId: id,
					billable: input.billableByDefault && !billsNothing(project),
				}),
			),
			recordStatement(
				scope,
				actor,
				"task.created",
				{ type: "task", id },
				changes(null, { name, billableByDefault: input.billableByDefault, common: input.common }, [
					"name",
					"billableByDefault",
					"common",
				]),
			),
		]);
	} catch (error) {
		if (isNameClash(error)) return { ok: false, problem: TASK_NAME_TAKEN };
		throw error;
	}
	return { ok: true, name };
}

/** Renames a task and changes its defaults. A project's own billable choice is left as it is. */
export async function changeTask(
	scope: OrganisationScope,
	actor: string,
	id: string,
	input: TaskInput,
): Promise<TaskResult> {
	const [task] = await scope.tasks.select((t) => eq(t.id, id), { limit: 1 });
	if (!task) return null;
	const name = recordName(input.name);
	if (name === null) return { ok: false, problem: RECORD_NAME_PROBLEM };
	const key = nameKey(name);
	if (await nameTaken(scope, key, id)) return { ok: false, problem: TASK_NAME_TAKEN };
	const changed = {
		name,
		nameKey: key,
		billableByDefault: input.billableByDefault,
		common: input.common,
	};
	const summary = changes(task, changed, ["name", "billableByDefault", "common"]);
	try {
		await scope.batch([
			scope.tasks.statements.update(changed, (t) => eq(t.id, id)),
			...(summary.after || summary.before
				? [recordStatement(scope, actor, "task.updated", { type: "task", id }, summary)]
				: []),
		]);
	} catch (error) {
		if (isNameClash(error)) return { ok: false, problem: TASK_NAME_TAKEN };
		throw error;
	}
	return { ok: true, name };
}

/** Archives the task `id`, or restores it. Its entries and its places on projects are kept. */
export async function setTaskArchived(
	scope: OrganisationScope,
	actor: string,
	id: string,
	archived: boolean,
): Promise<TaskResult> {
	const [changed] = await scope.tasks.update({ archivedAt: archived ? new Date() : null }, (t) =>
		eq(t.id, id),
	);
	if (!changed) return null;
	await record(scope, actor, archived ? "task.archived" : "task.restored", { type: "task", id });
	return { ok: true, name: changed.name };
}

/** A task on one project's list. */
export interface ProjectTask {
	taskId: string;
	name: string;
	billable: boolean;
	archived: boolean;
}

/** The tasks on each of these projects, by name; every project's when `projectIds` is left out. */
export async function tasksOfProjects(
	scope: OrganisationScope,
	projectIds?: readonly string[],
): Promise<Map<string, ProjectTask[]>> {
	const [tasks, links] = await Promise.all([
		scope.tasks.select(undefined, { orderBy: (t) => [asc(t.nameKey)] }),
		scope.projectTasks.select(
			projectIds === undefined ? undefined : (pt) => among(pt.projectId, projectIds),
		),
	]);
	const byProject = new Map<string, ProjectTask[]>();
	for (const task of tasks) {
		for (const link of links) {
			if (link.taskId !== task.id) continue;
			const list = byProject.get(link.projectId) ?? [];
			list.push({
				taskId: task.id,
				name: task.name,
				billable: link.billable,
				archived: task.archivedAt !== null,
			});
			byProject.set(link.projectId, list);
		}
	}
	return byProject;
}

/** The project of this organisation, or null. */
async function projectOf(scope: OrganisationScope, projectId: string) {
	const [project] = await scope.projects.select((p) => eq(p.id, projectId), { limit: 1 });
	return project ?? null;
}

/** Puts an active task on a project's list, billable as its default says unless the project bills nothing. */
export async function addTaskToProject(
	scope: OrganisationScope,
	actor: string,
	projectId: string,
	taskId: string,
): Promise<TaskResult> {
	const project = await projectOf(scope, projectId);
	if (!project) return null;
	const [task] = await scope.tasks.select((t) => and(eq(t.id, taskId), isNull(t.archivedAt)), {
		limit: 1,
	});
	if (!task) return { ok: false, problem: "Choose an active task." };
	const [already] = await scope.projectTasks.select(
		(pt) => and(eq(pt.projectId, projectId), eq(pt.taskId, taskId)),
		{ limit: 1 },
	);
	if (already) return { ok: true, name: task.name };
	await scope.batch([
		scope.projectTasks.statements.insert({
			projectId,
			taskId,
			billable: task.billableByDefault && !billsNothing(project),
		}),
		recordStatement(
			scope,
			actor,
			"project.updated",
			{ type: "project", id: projectId },
			{ after: { taskAdded: taskId } },
		),
	]);
	return { ok: true, name: task.name };
}

/** Takes a task off a project's list. Entries that have it keep it. */
export async function removeTaskFromProject(
	scope: OrganisationScope,
	actor: string,
	projectId: string,
	taskId: string,
): Promise<TaskResult> {
	const [removed] = await scope.projectTasks.delete((pt) =>
		and(eq(pt.projectId, projectId), eq(pt.taskId, taskId)),
	);
	if (!removed) return null;
	const [task] = await scope.tasks.select((t) => eq(t.id, taskId), { limit: 1 });
	await record(
		scope,
		actor,
		"project.updated",
		{ type: "project", id: projectId },
		{
			before: { taskRemoved: taskId },
		},
	);
	return { ok: true, name: task?.name ?? "" };
}

/**
 * An entry of the project that no invoice bills: what re-rating may change.
 * An invoiced entry keeps what it was billed as.
 */
function notInvoiced(scope: OrganisationScope, id: Parameters<typeof eq>[0]) {
	return sql`${id} not in (select time_entry_id from invoice_line_sources where organisation_id = ${scope.organisationId} and time_entry_id is not null)`;
}

/**
 * Makes a task billable or not on a project, and re-rates the project's
 * entries of that task to match, as Harvest's "Set tasks billable" does,
 * except those an invoice bills. A project that bills nothing has no billable task.
 */
export async function setProjectTaskBillable(
	scope: OrganisationScope,
	actor: string,
	projectId: string,
	taskIds: readonly string[],
	billable: boolean,
): Promise<{ ok: true; count: number } | { ok: false; problem: string } | null> {
	const project = await projectOf(scope, projectId);
	if (!project) return null;
	if (billable && billsNothing(project)) {
		return {
			ok: false,
			problem: "A non-billable project has no billable task. Change its type first.",
		};
	}
	const links = await scope.projectTasks.select((pt) =>
		and(eq(pt.projectId, projectId), among(pt.taskId, taskIds)),
	);
	const changing = links.filter((link) => link.billable !== billable).map((link) => link.taskId);
	if (changing.length === 0) return { ok: true, count: links.length };
	await scope.batch([
		scope.projectTasks.statements.update({ billable }, (pt) =>
			and(eq(pt.projectId, projectId), among(pt.taskId, changing)),
		),
		scope.timeEntries.statements.update({ billable }, (e) =>
			and(eq(e.projectId, projectId), among(e.taskId, changing), notInvoiced(scope, e.id)),
		),
		recordStatement(
			scope,
			actor,
			"project.updated",
			{ type: "project", id: projectId },
			{ after: { billableTasks: changing.join(","), billable } },
		),
	]);
	return { ok: true, count: links.length };
}

/**
 * The statements that bring a project's tasks and entries in line with a
 * new billing type: non-billable makes every task and entry non-billable;
 * leaving non-billable makes each task billable as its default says, and
 * re-rates the entries. Invoiced entries are left as they were billed.
 */
export async function rerateForBillingType(
	scope: OrganisationScope,
	projectId: string,
	from: string,
	to: string,
): Promise<ScopedStatement<unknown>[]> {
	if (from === to) return [];
	if (to === "non_billable") {
		return [
			scope.projectTasks.statements.update({ billable: false }, (pt) =>
				eq(pt.projectId, projectId),
			),
			scope.timeEntries.statements.update({ billable: false }, (e) =>
				and(eq(e.projectId, projectId), notInvoiced(scope, e.id)),
			),
		];
	}
	if (from !== "non_billable") return [];
	const tasks = await scope.tasks.select((t) => eq(t.billableByDefault, true));
	const billableIds = tasks.map((t) => t.id);
	if (billableIds.length === 0) return [];
	return [
		scope.projectTasks.statements.update({ billable: true }, (pt) =>
			and(eq(pt.projectId, projectId), among(pt.taskId, billableIds)),
		),
		scope.timeEntries.statements.update({ billable: true }, (e) =>
			and(eq(e.projectId, projectId), among(e.taskId, billableIds), notInvoiced(scope, e.id)),
		),
	];
}

/** The task an entry is given and whether it is billable, or why none can be. */
export type EntryTask =
	| { ok: true; taskId: string | null; billable: boolean }
	| { ok: false; reason: "no-task" };

/**
 * The task of a new or changed entry on `projectId` (B4). `chosen` is the
 * task the person chose, which must be active and on the project's list;
 * `keep` is the task the entry already has, which it may keep though it has
 * been archived or taken off the list since. With nothing chosen the entry
 * gets the project's first active task by name; a project with none gives
 * no task, and the entry is not billable. Billable is the task's flag on the
 * project, and never on a project that bills nothing.
 */
export async function entryTaskOf(
	scope: OrganisationScope,
	projectId: string,
	chosen: string | undefined,
	keep: string | null = null,
): Promise<EntryTask> {
	const [project] = await scope.projects.select((p) => eq(p.id, projectId), { limit: 1 });
	if (!project) return { ok: false, reason: "no-task" };
	const list = (await tasksOfProjects(scope, [projectId])).get(projectId) ?? [];
	const billableOf = (taskId: string | null) =>
		!billsNothing(project) && (list.find((t) => t.taskId === taskId)?.billable ?? false);
	if (chosen === undefined || chosen === "") {
		if (keep !== null) return { ok: true, taskId: keep, billable: billableOf(keep) };
		const first = list.find((t) => !t.archived);
		return { ok: true, taskId: first?.taskId ?? null, billable: billableOf(first?.taskId ?? null) };
	}
	if (chosen === keep) return { ok: true, taskId: keep, billable: billableOf(keep) };
	const task = list.find((t) => t.taskId === chosen && !t.archived);
	if (!task) return { ok: false, reason: "no-task" };
	return { ok: true, taskId: task.taskId, billable: billableOf(task.taskId) };
}
