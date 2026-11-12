import { env } from "cloudflare:workers";
import { and, asc, gte, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { data } from "react-router";

import { users } from "~/db";
import { type Money, totalsByCurrency } from "~/money/money";
import type { Membership } from "~/organisations/membership.server";
import { nameOrEmail } from "~/organisations/people";
import { type ReportRequest, reportRequest } from "~/reports/reports.server";
import type { Day } from "~/time/calendar";

import { categoriesById } from "./categories.server";
import { amountText, type ExpenseGrouping, expenseGrouping, quantityText } from "./expenses";
import { among } from "./expenses.server";

/**
 * The Expenses view of Reports (TS-070, B9): the expenses dated in a range,
 * grouped by category, project or person, with their totals, billable and to
 * be paid back, one for each currency (amounts in different currencies are
 * never added). Whose expenses it holds is whose time the viewer may see, as
 * for the time report (`reportRequest`), which reads the range and the person
 * from the same address; the grouping is this view's own.
 */

/** A report of expenses as its address asks for it. */
export interface ExpenseReportRequest extends ReportRequest {
	expenseGroup: ExpenseGrouping;
}

/**
 * Reads the report the address asks for: the range and the person as the
 * time report reads them, and the grouping. An address that names no grouping
 * this view has is answered 400, as one with no range that can be made.
 */
export async function expenseReportRequest(
	membership: Membership,
	url: URL,
	now: number,
): Promise<ExpenseReportRequest> {
	const expenseGroup = expenseGrouping(url.searchParams.get("group"));
	if (expenseGroup === null) throw data("Bad Request", { status: 400 });
	const asTime = new URL(url);
	asTime.searchParams.delete("group");
	const report = await reportRequest(membership, asTime, now);
	// A custom range that makes no report is answered 400 here.
	if ("problem" in report) throw data("Bad Request", { status: 400 });
	return { ...report, expenseGroup };
}

/** One expense as the report and its export list it. */
export interface ReportedExpense {
	id: string;
	spentOn: Day;
	personId: string;
	person: string;
	projectId: string;
	project: string;
	client: string | null;
	categoryId: string;
	category: string;
	unitName: string | null;
	quantityMilli: number | null;
	unitPriceMinor: number | null;
	amountMinor: number;
	currency: string;
	billable: boolean;
	reimbursable: boolean;
	notes: string | null;
	hasReceipt: boolean;
}

/** The expenses of the report, by day. */
export async function reportedExpenses(
	request: Pick<ReportRequest, "scope" | "days" | "people">,
): Promise<ReportedExpense[]> {
	const { scope, days, people } = request;
	const rows = await scope.expenses.select(
		(e) =>
			and(
				gte(e.spentOn, days.first),
				lte(e.spentOn, days.last),
				people.everyone ? undefined : among(e.userId, people.people),
			),
		{ orderBy: (e) => [asc(e.spentOn), asc(e.id)] },
	);
	if (rows.length === 0) return [];

	const unique = (ids: string[]) => [...new Set(ids)];
	const projectIds = unique(rows.map((row) => row.projectId));
	const personIds = unique(rows.map((row) => row.userId));
	const [projects, categories, persons] = await Promise.all([
		scope.projects.select((p) => among(p.id, projectIds)),
		categoriesById(scope, unique(rows.map((row) => row.categoryId))),
		drizzle(env.DB)
			.select({ id: users.id, name: users.name, email: users.email })
			.from(users)
			.where(among(users.id, personIds)),
	]);
	const clientIds = unique(projects.flatMap((p) => (p.clientId === null ? [] : [p.clientId])));
	const clients =
		clientIds.length === 0 ? [] : await scope.clients.select((c) => among(c.id, clientIds));
	const projectOf = new Map(projects.map((p) => [p.id, p]));
	const clientName = new Map(clients.map((c) => [c.id, c.name]));
	const personName = new Map(persons.map((p) => [p.id, nameOrEmail(p)]));

	return rows.map((row) => {
		const project = projectOf.get(row.projectId);
		const category = categories.get(row.categoryId);
		return {
			id: row.id,
			spentOn: row.spentOn,
			personId: row.userId,
			person: personName.get(row.userId) ?? "A former member",
			projectId: row.projectId,
			project: project?.name ?? "",
			client: project?.clientId ? (clientName.get(project.clientId) ?? null) : null,
			categoryId: row.categoryId,
			category: category?.name ?? "",
			unitName: row.quantityMilli === null ? null : (category?.unitName ?? null),
			quantityMilli: row.quantityMilli,
			unitPriceMinor: row.unitPriceMinor,
			amountMinor: row.amountMinor,
			currency: row.currency,
			billable: row.billable,
			reimbursable: row.reimbursable,
			notes: row.notes,
			hasReceipt: row.receiptKey !== null,
		};
	});
}

/** The expenses of one group, added up. */
export interface ExpenseGroup {
	key: string;
	label: string;
	count: number;
	total: Money[];
	billable: Money[];
	reimbursable: Money[];
}

/** What a list of expenses comes to, in each currency. */
export function expenseTotals(expenses: readonly ReportedExpense[]) {
	const money = ({ amountMinor, currency }: ReportedExpense) => ({ amountMinor, currency });
	return {
		count: expenses.length,
		total: totalsByCurrency(expenses.map(money)),
		billable: totalsByCurrency(expenses.filter((e) => e.billable).map(money)),
		reimbursable: totalsByCurrency(expenses.filter((e) => e.reimbursable).map(money)),
	};
}

/** The expenses grouped as asked, the groups by name. */
export function groupExpenses(
	expenses: readonly ReportedExpense[],
	grouping: ExpenseGrouping,
): ExpenseGroup[] {
	const keyOf = (e: ReportedExpense): [string, string] => {
		switch (grouping) {
			case "category":
				return [e.categoryId, e.category];
			case "project":
				return [e.projectId, e.project];
			case "person":
				return [e.personId, e.person];
		}
	};
	const groups = new Map<string, { label: string; expenses: ReportedExpense[] }>();
	for (const expense of expenses) {
		const [key, label] = keyOf(expense);
		const group = groups.get(key) ?? { label, expenses: [] };
		group.expenses.push(expense);
		groups.set(key, group);
	}
	return [...groups.entries()]
		.map(([key, group]) => ({ key, label: group.label, ...expenseTotals(group.expenses) }))
		.sort((a, b) => a.label.localeCompare(b.label, "en") || (a.key < b.key ? -1 : 1));
}

/** The export's columns, in order. */
export const EXPENSE_CSV_COLUMNS = [
	"Expense ID",
	"Date",
	"Person",
	"Project",
	"Client",
	"Category",
	"Notes",
	"Quantity",
	"Unit",
	"Unit price",
	"Amount",
	"Currency",
	"Billable",
	"Reimbursable",
	"Receipt",
] as const;

/** The cells of one expense, in the order of `EXPENSE_CSV_COLUMNS`. */
export function expenseCells(expense: ReportedExpense, showClients: boolean): string[] {
	const yes = (value: boolean) => (value ? "Yes" : "No");
	return [
		expense.id,
		expense.spentOn,
		expense.person,
		expense.project,
		(showClients && expense.client) || "",
		expense.category,
		expense.notes ?? "",
		expense.quantityMilli === null ? "" : quantityText(expense.quantityMilli),
		expense.unitName ?? "",
		expense.unitPriceMinor === null ? "" : amountText(expense.unitPriceMinor, expense.currency),
		amountText(expense.amountMinor, expense.currency),
		expense.currency,
		yes(expense.billable),
		yes(expense.reimbursable),
		yes(expense.hasReceipt),
	];
}

/** The file's name: "timesifier-acme-expenses-2026-11-02-to-2026-11-08.csv". */
export function expenseCsvFilename(slug: string, first: Day, last: Day): string {
	return `timesifier-${slug}-expenses-${first}-to-${last}.csv`;
}
