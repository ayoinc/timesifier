import {
	EXPENSE_CSV_COLUMNS,
	expenseCells,
	expenseExportRequest,
	reportedExpenses,
} from "~/expenses/report.server";
import { exportFilename } from "~/organisations/export-filename";
import { membershipContext } from "~/organisations/membership.server";
import { BYTE_ORDER_MARK, csvLine } from "~/reports/csv";
import { dayOf } from "~/time/calendar";

import type { Route } from "./+types/reports.expenses.export";

// The Expenses view of Reports as CSV (TS-070, B9), at its address with
// `/export` after it and the same query, so it holds the same expenses: one
// line each, with its person, project, client, category, quantity, amount,
// currency, whether it is billable, to be paid back and has a receipt, and its
// tags (TS-085). It sits below Reports, so the organisation layout's checks
// cover it.

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const report = await expenseExportRequest(membership, new URL(request.url), Date.now());
	const expenses = await reportedExpenses(report);
	let body = BYTE_ORDER_MARK + csvLine(EXPENSE_CSV_COLUMNS);
	for (const expense of expenses) body += csvLine(expenseCells(expense, report.showClients));
	const { organisation } = membership;
	const filename = exportFilename(
		organisation.name,
		`expenses-${report.days.first}-to-${report.days.last}`,
		dayOf(Date.now(), organisation.timeZone),
		"csv",
	);
	return new Response(body, {
		headers: {
			"Content-Type": "text/csv; charset=utf-8; header=present",
			"Content-Disposition": `attachment; filename="${filename}"`,
			"Cache-Control": "no-store",
		},
	});
}
