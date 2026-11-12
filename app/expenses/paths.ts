import { destination, destinationPath } from "../shell/destinations";

// The addresses below Expenses and Reports that expenses add (TS-070): a
// receipt, and the Expenses view of Reports with its export. Each sits below
// its destination, so the organisation layout's checks cover it. The route
// configuration (app/routes.ts) reads this in Node, so it imports by relative
// path, as that file does.

/** The parameter that names the expense whose receipt is asked for. */
export const EXPENSE_PARAM = "expenseId";

/** What follows the organisation in the address of a receipt. */
export const RECEIPT_SEGMENT = `${destination("expenses").segment}/:${EXPENSE_PARAM}/receipt`;

/** The address of the receipt of expense `id`. */
export function receiptPath(slug: string, id: string): string {
	return `${destinationPath(slug, "expenses")}/${id}/receipt`;
}

/** What follows the organisation in the address of the Expenses view's export (the view itself is in app/reports/views.ts). */
export const EXPENSE_REPORT_EXPORT_SEGMENT = `${destination("reports").segment}/expenses/export`;

/** Its export: the same query on the export's address. */
export function expenseReportExportPath(slug: string, search: string): string {
	return `${destinationPath(slug, "reports")}/expenses/export${search}`;
}
