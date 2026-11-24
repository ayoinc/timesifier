import { and, eq, isNull, ne } from "drizzle-orm";

import { projectBudgets } from "~/budgets/budget.server";
import { among, type OrganisationScope } from "~/db";
import type { Membership } from "~/organisations/membership.server";
import { pinnedProjectIds } from "~/pins/pins.server";
import { organisationMoney, pricingOf } from "~/projects/money.server";
import { recentProjectIds } from "~/projects/recent.server";
import { workPackageChoices } from "~/projects/work-packages.server";
import { tagOptions, tagsOfEntries } from "~/tags/tags.server";
import { hasClients } from "~/workspace/work-model";
import { tasksOfProjects } from "./tasks.server";
import type { ProjectChoice, TrackChoices } from "./track";

/**
 * What Track time and an entry's sheet offer beside the project (TS-066,
 * TS-085, TS-069): each project's active tasks, the organisation's tags, the
 * projects over budget whose people are warned, the task and tags of each
 * entry shown, so its sheet starts at what it has, and for the project picker
 * the person's pinned and recent projects and each project's code, client
 * and the client's code, and whether it is a work code (TS-115a), and each
 * project's work packages (TS-115b). An
 * organisation that shows no clients is given none.
 */
export async function trackChoices(
	scope: OrganisationScope,
	membership: Membership,
	shownEntryIds: readonly string[] | Promise<readonly string[]>,
	now: number,
): Promise<TrackChoices> {
	// The entries shown may still be on their way: the Timesheet reads them
	// beside these (TS-114), and only the two reads of the entries wait for them.
	const shown = Promise.resolve(shownEntryIds);
	const showsClients = hasClients(membership.organisation.workModel);
	const [
		byProject,
		tags,
		overBudget,
		entries,
		entryTags,
		recent,
		pinned,
		active,
		clients,
		packages,
	] = await Promise.all([
		tasksOfProjects(scope),
		tagOptions(scope),
		warnedOverBudget(scope, membership, now),
		shown.then((ids) =>
			ids.length === 0 ? [] : scope.timeEntries.select((e) => among(e.id, ids)),
		),
		shown.then((ids) => tagsOfEntries(scope, ids)),
		recentProjectIds(scope, membership.user.id),
		pinnedProjectIds(scope, membership.user.id),
		scope.projects.select((p) => isNull(p.archivedAt)),
		showsClients ? scope.clients.select() : [],
		workPackageChoices(scope),
	]);
	const clientOf = new Map(clients.map((c) => [c.id, { name: c.name, code: c.code }]));
	return {
		tasks: Object.fromEntries(
			[...byProject].map(([projectId, list]) => [
				projectId,
				list.map(({ taskId, name, billable, archived }) => ({
					id: taskId,
					name,
					billable,
					archived,
				})),
			]),
		),
		tags,
		overBudget,
		entries: Object.fromEntries(
			entries.map((e) => [
				e.id,
				{ taskId: e.taskId, workPackageId: e.workPackageId, tagIds: entryTags.get(e.id) ?? [] },
			]),
		),
		recent,
		pinned,
		projects: Object.fromEntries(
			active.map((p): [string, ProjectChoice] => [
				p.id,
				{
					code: p.code,
					client: (p.clientId === null ? undefined : clientOf.get(p.clientId)) ?? null,
					workCode: p.clientId === null && p.billingType === "non_billable",
				},
			]),
		),
		workPackages: packages,
	};
}

/** The active projects with "warn when over" on whose budget is over for its current period. */
async function warnedOverBudget(
	scope: OrganisationScope,
	membership: Membership,
	now: number,
): Promise<string[]> {
	const warned = await scope.projects.select((p) =>
		and(isNull(p.archivedAt), eq(p.budgetWarnMembers, true), ne(p.budgetKind, "none")),
	);
	if (warned.length === 0) return [];
	const money = await organisationMoney(membership.organisation.id);
	const budgets = await projectBudgets(scope, warned, {
		zone: membership.organisation.timeZone,
		now,
		money,
		pricing: await pricingOf(scope, money.currency),
	});
	return [...budgets].filter(([, figures]) => figures.total?.over).map(([id]) => id);
}
