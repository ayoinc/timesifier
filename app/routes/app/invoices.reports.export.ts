import {
	BILLING_CSV_COLUMNS,
	billingCsvCells,
	billingReportOf,
	billingReportRequest,
} from "~/invoices/billing-reports.server";
import { billingOf } from "~/invoices/context.server";
import { csvLine } from "~/reports/csv";

import type { Route } from "./+types/invoices.reports.export";

// A report of Invoices as a CSV (TS-074): the rows its page shows, for the
// same `?report=&from=&to=`, one invoice or payment per line.

export async function loader({ request, context }: Route.LoaderArgs) {
	const { scope, organisation, today } = await billingOf(context, request);
	const { report, days } = billingReportRequest(new URL(request.url).searchParams, today);
	const { rows } = await billingReportOf(scope, report, days, today);
	let file = csvLine(BILLING_CSV_COLUMNS[report]);
	for (const row of rows) file += csvLine(billingCsvCells(report, row));
	const name =
		report === "receivables"
			? `timesifier-${organisation.slug}-receivables-${today}.csv`
			: `timesifier-${organisation.slug}-${report}-${days.first}-to-${days.last}.csv`;
	return new Response(file, {
		headers: {
			"Content-Type": "text/csv; charset=utf-8; header=present",
			"Content-Disposition": `attachment; filename="${name}"`,
			"Cache-Control": "no-store",
		},
	});
}
