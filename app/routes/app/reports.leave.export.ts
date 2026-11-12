import { data } from "react-router";

import { membershipContext } from "~/organisations/membership.server";
import { BYTE_ORDER_MARK, csvLine } from "~/reports/csv";
import { daysCell, LEAVE_CSV_COLUMNS, leaveCsvFilename, leaveYearOf } from "~/reports/leave";
import { leaveBalances } from "~/reports/leave.server";
import { reportRequest } from "~/reports/reports.server";

import type { Route } from "./+types/reports.leave.export";

// The export of the Leave view (TS-084) as CSV: one row for each person and
// kind of leave, read by the function the page reads, so the file's figures
// are the screen's. It sits below Reports, so the organisation layout's
// checks cover it.

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const url = new URL(request.url);
	const report = await reportRequest(membership, url, Date.now());
	const year = leaveYearOf(url.searchParams.get("year"), report.today);
	if (year === null) throw data("Bad Request", { status: 400 });
	const lines = await leaveBalances(report, year, report.today);
	let body = BYTE_ORDER_MARK + csvLine(LEAVE_CSV_COLUMNS);
	for (const line of lines) {
		body += csvLine([
			line.person,
			line.email,
			line.kind,
			String(year),
			daysCell(line.allowance),
			daysCell(line.taken),
			daysCell(line.booked),
			daysCell(line.pending),
			daysCell(line.remaining),
		]);
	}
	return new Response(body, {
		headers: {
			"Content-Type": "text/csv; charset=utf-8; header=present",
			"Content-Disposition": `attachment; filename="${leaveCsvFilename(membership.organisation.slug, year)}"`,
			"Cache-Control": "no-store",
		},
	});
}
