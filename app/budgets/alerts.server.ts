import { env } from "cloudflare:workers";
import { and, eq, gte, isNotNull, ne } from "drizzle-orm";
import { organisationScope } from "~/db";
import type { Membership } from "~/organisations/membership.server";
import { organisationMoney, pricingOf } from "~/projects/money.server";
import { projectPath } from "~/projects/projects";

import { alertIfCrossed, projectBudgets } from "./budget.server";

/**
 * After a person's time changes, tells those who look after each project it
 * touched whose budget has crossed its alert (TS-069). The projects are those
 * of the person's entries written since `since`: the ones a change could take
 * over. An entry that was deleted or moved away takes spending down, which
 * sends nothing. `origin` is the host the change was made on, for the link.
 */
export async function alertBudgetsAfter(
	membership: Membership,
	since: number,
	origin: string,
): Promise<void> {
	const { organisation, user } = membership;
	const scope = organisationScope(env.DB, organisation.id);
	const written = await scope.timeEntries.select((e) =>
		and(eq(e.userId, user.id), gte(e.updatedAt, new Date(since))),
	);
	const touched = [...new Set(written.map((e) => e.projectId))];
	if (touched.length === 0) return;
	const projects = (
		await scope.projects.select((p) =>
			and(ne(p.budgetKind, "none"), isNotNull(p.budgetAlertPercent)),
		)
	).filter((p) => touched.includes(p.id));
	if (projects.length === 0) return;
	const now = Date.now();
	const money = await organisationMoney(organisation.id);
	const budgets = await projectBudgets(scope, projects, {
		zone: organisation.timeZone,
		now,
		money,
		pricing: await pricingOf(scope, money.currency),
	});
	for (const project of projects) {
		await alertIfCrossed(
			scope,
			project,
			budgets.get(project.id) ?? null,
			{
				organisationName: organisation.name,
				link: `${origin}${projectPath(organisation.slug, project.id)}`,
			},
			now,
		);
	}
}
