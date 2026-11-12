import { budgetKindOf, projectBudgets } from "~/budgets/budget.server";
import { maySeeRates } from "~/organisations/access";
import type { Membership } from "~/organisations/membership.server";
import { organisationMoney, pricingOf } from "~/projects/money.server";
import { type ProfitabilityReport, profitabilityReport } from "~/reports/profitability.server";
import { type Row, totalsOf } from "~/reports/report";
import { peopleOfReport, type ReportRequest, rowsOfReport } from "~/reports/reports.server";
import { bills } from "~/reports/utilisation";
import {
	nonBillableProjects,
	type UtilisationReport,
	utilisationReport,
} from "~/reports/utilisation.server";

/**
 * Dashboards (TS-086): one page of figures for a range, each read by the
 * function its report reads, so a panel's figure is the figure of the report
 * it links to. Time panels hold the people the viewer may see
 * (`timeScopeOf`); money panels are read only for those who see rates
 * (`maySeeRates`), never for a manager.
 */

/** How many projects the panels list. */
export const PANEL_ROWS = 5;

export interface BudgetNearLimit {
	projectId: string;
	project: string;
	hours: boolean;
	currency: string;
	spent: number;
	amount: number;
	/** Spent as a share of the budget, 1 at the limit. */
	share: number;
	/** The whole percentage spent, as the project page shows it; null for a budget of 0. */
	percent: number | null;
}

export interface Dashboard {
	/** Seconds tracked in the range. */
	totalSeconds: number;
	/** Minutes expected over the range of the people shown. */
	expectedMinutes: number;
	billableSeconds: number;
	utilisation: UtilisationReport;
	/** The projects with the most time, most first. */
	topProjects: { id: string; name: string; seconds: number }[];
	budgets: BudgetNearLimit[];
	/** The people shown who have approved leave in the range. */
	onLeave: { id: string; name: string; leaveMinutes: number; halfDays: number }[];
	/** Null for a viewer who does not see rates. */
	money: ProfitabilityReport | null;
}

export async function dashboardOf(
	membership: Membership,
	report: ReportRequest,
): Promise<Dashboard> {
	const { scope } = report;
	const rows = await rowsOfReport(report);
	const lines = await peopleOfReport(report, rows);
	const seesMoney = maySeeRates(membership.role);
	const [utilisation, nonBillable, money, budgets] = await Promise.all([
		utilisationReport(report, rows, lines),
		nonBillableProjects(scope),
		seesMoney ? profitabilityReport(report, rows) : Promise.resolve(null),
		budgetsNearLimit(report, rows, seesMoney),
	]);
	const byProject = totalsOf(rows, "project");
	return {
		totalSeconds: byProject.minutes * 60,
		expectedMinutes: lines.reduce((sum, line) => sum + line.expectedMinutes, 0),
		billableSeconds: rows.reduce(
			(sum, row) => sum + (bills(row, nonBillable) ? row.minutes * 60 : 0),
			0,
		),
		utilisation,
		topProjects: [...byProject.groups]
			.sort((a, b) => b.minutes - a.minutes || (a.label ?? "").localeCompare(b.label ?? "", "en"))
			.slice(0, PANEL_ROWS)
			.map((g) => ({ id: g.key, name: g.label ?? "", seconds: g.minutes * 60 })),
		budgets,
		onLeave: lines
			.filter((line) => line.leaveHalfDays > 0)
			.map((line) => ({
				id: line.id,
				name: line.name,
				leaveMinutes: line.leaveMinutes,
				halfDays: line.leaveHalfDays,
			})),
		money,
	};
}

/**
 * The budgets nearest their limit, as the project page counts them
 * (`projectBudgets`). Those who see rates see every project's; a manager the
 * hours budgets of the projects their people tracked time to in the range.
 */
async function budgetsNearLimit(
	report: ReportRequest,
	rows: readonly Row[],
	seesMoney: boolean,
): Promise<BudgetNearLimit[]> {
	const { scope } = report;
	const worked = new Set(rows.map((p) => p.entry.projectId));
	const projects = (await scope.projects.select()).filter(
		(p) =>
			p.archivedAt === null &&
			budgetKindOf(p.budgetKind) !== "none" &&
			(seesMoney || worked.has(p.id)),
	);
	if (projects.length === 0) return [];
	const money = await organisationMoney(scope.organisationId);
	const figures = await projectBudgets(scope, projects, {
		zone: report.zone,
		now: report.now,
		money,
		pricing: await pricingOf(scope, money.currency),
	});
	const names = new Map(projects.map((p) => [p.id, p.name]));
	const near: BudgetNearLimit[] = [];
	for (const [projectId, budget] of figures) {
		if (!budget.total || budget.amount === null || budget.amount <= 0) continue;
		if (!budget.hours && !seesMoney) continue;
		near.push({
			projectId,
			project: names.get(projectId) ?? "",
			hours: budget.hours,
			currency: budget.currency,
			spent: budget.total.spent,
			amount: budget.amount,
			share: budget.total.spent / budget.amount,
			percent: budget.total.percent,
		});
	}
	return near.sort((a, b) => b.share - a.share).slice(0, PANEL_ROWS);
}
