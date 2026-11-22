import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";

import { projectBudgets } from "~/budgets/budget.server";
import { among, type OrganisationScope } from "~/db";
import type { Membership } from "~/organisations/membership.server";
import { organisationMoney, pricingOf } from "~/projects/money.server";
import { recentProjectIds } from "~/projects/recent.server";
import { tagOptions, tagsOfEntries } from "~/tags/tags.server";
import { tasksOfProjects } from "./tasks.server";
import type { TrackChoices } from "./track";

/**
 * What Track time and an entry's sheet offer beside the project (TS-066,
 * TS-085, TS-069): each project's active tasks, the organisation's tags, the
 * projects over budget whose people are warned, the task and tags of each
 * entry shown, so its sheet starts at what it has, and for the project picker
 * the person's recent projects and each project's client.
 */
export async function trackChoices(
	scope: OrganisationScope,
	membership: Membership,
	shownEntryIds: readonly string[],
	now: number,
): Promise<TrackChoices> {
	const [byProject, tags, overBudget, entries, entryTags, recent, withClient, clients] =
		await Promise.all([
			tasksOfProjects(scope),
			tagOptions(scope),
			warnedOverBudget(scope, membership, now),
			shownEntryIds.length === 0 ? [] : scope.timeEntries.select((e) => among(e.id, shownEntryIds)),
			tagsOfEntries(scope, shownEntryIds),
			recentProjectIds(scope, membership.user.id),
			scope.projects.select((p) => and(isNull(p.archivedAt), isNotNull(p.clientId))),
			scope.clients.select(),
		]);
	const clientNames = new Map(clients.map((c) => [c.id, c.name]));
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
			entries.map((e) => [e.id, { taskId: e.taskId, tagIds: entryTags.get(e.id) ?? [] }]),
		),
		recent,
		clients: Object.fromEntries(
			withClient.flatMap((p) => {
				const client = p.clientId === null ? undefined : clientNames.get(p.clientId);
				return client === undefined ? [] : [[p.id, client]];
			}),
		),
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
