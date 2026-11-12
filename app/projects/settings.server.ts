import { and, eq, inArray } from "drizzle-orm";

import { changes, recordStatement } from "~/activity/activity.server";
import type { BillingType } from "~/billing/billable";
import type { BudgetKind } from "~/budgets/budget";
import type { OrganisationScope, ScopedStatement } from "~/db";
import type { RateMode } from "~/rates/price";
import { rerateForBillingType } from "~/tasks/tasks.server";

/**
 * A project's money settings (TS-067, TS-069): how it bills and what its
 * budget is. Set from the project's own page by owners, admins and Finance
 * (`mayManageRates`); the route checks that. Each change goes in one batch
 * with its row in the activity log.
 */

/** How a project bills. `feeMinor` is the fixed fee, for a fixed-fee project only. */
export interface BillingInput {
	billingType: BillingType;
	rateMode: RateMode;
	feeMinor: number | null;
	/** Null bills in the client's currency, or the organisation's. */
	currency: string | null;
}

/**
 * Changes how a project bills. Making it non-billable makes every task on it
 * and every entry not yet invoiced non-billable; making a non-billable project
 * bill again makes its tasks billable as their defaults say, and re-rates the
 * entries (`rerateForBillingType`). Null for no such project here.
 */
export async function changeBilling(
	scope: OrganisationScope,
	actor: string,
	projectId: string,
	input: BillingInput,
): Promise<{ ok: true; name: string } | null> {
	const [project] = await scope.projects.select((p) => eq(p.id, projectId), { limit: 1 });
	if (!project) return null;
	const changed = {
		billingType: input.billingType,
		rateMode: input.rateMode,
		feeMinor: input.billingType === "fixed_fee" ? input.feeMinor : null,
		currency: input.currency,
	};
	const summary = changes(project, changed, ["billingType", "rateMode", "feeMinor", "currency"]);
	const rerated = await rerateForBillingType(
		scope,
		projectId,
		project.billingType,
		input.billingType,
	);
	await scope.batch([
		scope.projects.statements.update(changed, (p) => eq(p.id, projectId)),
		...rerated,
		recordStatement(scope, actor, "project.updated", { type: "project", id: projectId }, summary),
	]);
	return { ok: true, name: project.name };
}

/** A project's budget. Amounts are minutes for an hours budget, minor units for fees. */
export interface BudgetInput {
	kind: BudgetKind;
	/** The whole budget, for a total budget. */
	amount: number | null;
	/** Each task's or person's budget, by its id, for a per-task or per-person budget. Absent ones have none. */
	lines: ReadonlyMap<string, number>;
	resetsMonthly: boolean;
	/** Null sends no alert. */
	alertPercent: number | null;
	warnMembers: boolean;
	includesExpenses: boolean;
}

/** Why a budget was not saved. */
export type NotBudgeted = "no-amount" | "not-on-project";

/**
 * Sets a project's budget. A per-task budget's lines must be tasks on the
 * project's list; a per-person budget's lines must be members of the
 * organisation. The lines of a kind other than the new one are removed.
 */
export async function changeBudget(
	scope: OrganisationScope,
	actor: string,
	projectId: string,
	input: BudgetInput,
): Promise<{ ok: true; name: string } | { ok: false; reason: NotBudgeted } | null> {
	const [project] = await scope.projects.select((p) => eq(p.id, projectId), { limit: 1 });
	if (!project) return null;
	const total = input.kind === "total_hours" || input.kind === "total_fees";
	if (total && input.amount === null) return { ok: false, reason: "no-amount" };
	const keys = [...input.lines.keys()].slice(0, 200);
	const perTask = input.kind === "task_hours" || input.kind === "task_fees";
	const perPerson = input.kind === "person_hours";
	if (keys.length > 0) {
		if (perTask) {
			const onProject = await scope.projectTasks.select((pt) =>
				and(eq(pt.projectId, projectId), inArray(pt.taskId, keys.slice(0, 90))),
			);
			if (onProject.length !== keys.length) return { ok: false, reason: "not-on-project" };
		} else if (perPerson) {
			const members = await scope.memberships.select((m) => inArray(m.userId, keys.slice(0, 90)));
			if (members.length !== keys.length) return { ok: false, reason: "not-on-project" };
		}
	}
	const changed = {
		budgetKind: input.kind,
		budgetAmount: total ? input.amount : null,
		budgetResetsMonthly: input.kind !== "none" && input.resetsMonthly,
		budgetAlertPercent: input.alertPercent,
		budgetWarnMembers: input.warnMembers,
		budgetIncludesExpenses: input.kind === "total_fees" && input.includesExpenses,
	};
	const lines: ScopedStatement<unknown>[] =
		perTask || perPerson
			? [...input.lines].map(([key, amount]) =>
					scope.budgetLines.statements.insert({
						projectId,
						taskId: perTask ? key : null,
						userId: perPerson ? key : null,
						amount,
					}),
				)
			: [];
	// No budget before and none now: nothing to change, nothing to record.
	if (project.budgetKind === "none" && input.kind === "none") {
		return { ok: true, name: project.name };
	}
	await scope.batch([
		scope.projects.statements.update(changed, (p) => eq(p.id, projectId)),
		scope.budgetLines.statements.delete((l) => eq(l.projectId, projectId)),
		...lines,
		recordStatement(
			scope,
			actor,
			project.budgetKind === "none" && input.kind !== "none"
				? "budget.created"
				: input.kind === "none"
					? "budget.deleted"
					: "budget.updated",
			{ type: "budget", id: projectId },
			changes(project, changed, [
				"budgetKind",
				"budgetAmount",
				"budgetResetsMonthly",
				"budgetAlertPercent",
				"budgetWarnMembers",
				"budgetIncludesExpenses",
			]),
		),
	]);
	return { ok: true, name: project.name };
}
