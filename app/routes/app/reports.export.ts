import { membershipContext } from "~/organisations/membership.server";
import { BYTE_ORDER_MARK, CSV_COLUMNS, csvFilename, csvLine, pieceCells } from "~/reports/csv";
import { piecesOf } from "~/reports/report";
import { entryPages, type ReportRequest, reportRequest } from "~/reports/reports.server";

import type { Route } from "./+types/reports.export";

// The export of a report as CSV (TS-014b), at the address of the report's page
// with `/export` after it and the same query, so it holds the same rows. It
// sits below Reports, so the organisation layout's checks cover it: a person
// who is not a member gets the same 404 as anywhere in the organisation.
//
// The file is streamed: each page of entries is read, written and sent before
// the next is read, and nothing is stored.

/** The file, a chunk at a time: its first line names the columns, then one chunk for each page of entries. */
async function* csvChunks(report: ReportRequest): AsyncGenerator<string> {
	yield BYTE_ORDER_MARK + csvLine(CSV_COLUMNS);
	for await (const page of entryPages(report)) {
		let chunk = "";
		for (const entry of page) {
			for (const piece of piecesOf(entry, report.days, report.zone, report.now)) {
				chunk += csvLine(pieceCells(piece, report.showClients));
			}
		}
		if (chunk) yield chunk;
	}
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const report = await reportRequest(membership, new URL(request.url), Date.now());
	const chunks = csvChunks(report);
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const next = await chunks.next();
			if (next.done) controller.close();
			else controller.enqueue(encoder.encode(next.value));
		},
		async cancel() {
			await chunks.return(undefined);
		},
	});
	const filename = csvFilename(membership.organisation.slug, report.days.first, report.days.last);
	return new Response(body, {
		headers: {
			"Content-Type": "text/csv; charset=utf-8; header=present",
			"Content-Disposition": `attachment; filename="${filename}"`,
			"Cache-Control": "no-store",
		},
	});
}
