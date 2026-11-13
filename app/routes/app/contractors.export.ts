import { data } from "react-router";
import { CONTRACTOR_CSV_COLUMNS, contractorCsvRows } from "~/contractors/contractors";
import { contractorReport, requireSeesCost } from "~/contractors/contractors.server";
import { exportFilename } from "~/organisations/export-filename";
import { membershipContext } from "~/organisations/membership.server";
import { BYTE_ORDER_MARK, csvLine } from "~/reports/csv";
import { dayOf } from "~/time/calendar";

import type { Route } from "./+types/contractors.export";

// The export of the Contractors report as CSV (TS-079), at the address of the
// report with `/export` after it and the same query, so it holds the same
// people. RFC 4180, UTF-8 with a byte order mark, lines ended by CRLF, a cell
// that could start a formula made text, as the export of Reports
// (app/reports/csv.ts). Hours keep their seconds: `seconds` exactly, and
// `hours` to six decimal places. Owners, admins and Finance only: anybody else
// gets the organisation's 404, as on the page.

export const middleware: Route.MiddlewareFunction[] = [
	({ context }) => requireSeesCost(context.get(membershipContext)),
];

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const report = await contractorReport(membership, new URL(request.url), Date.now());
	if ("problem" in report) throw data("Bad Request", { status: 400 });
	const { days, lines } = report;
	const body =
		BYTE_ORDER_MARK +
		csvLine(CONTRACTOR_CSV_COLUMNS) +
		lines.flatMap((line) => contractorCsvRows(line).map(csvLine)).join("");
	const { organisation } = membership;
	const filename = exportFilename(
		organisation.name,
		`contractors-${days.first}-to-${days.last}`,
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
