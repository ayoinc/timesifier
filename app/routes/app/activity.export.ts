import { env } from "cloudflare:workers";

import {
	type LogCursor,
	type LogRequest,
	logRecords,
	logRequest,
	logRows,
	parseLogQuery,
} from "~/activity/log.server";
import { organisationScope } from "~/db";
import { exportFilename } from "~/organisations/export-filename";
import { membershipContext } from "~/organisations/membership.server";
import { BYTE_ORDER_MARK, csvLine, isoInstant } from "~/reports/csv";
import { dayOf } from "~/time/calendar";

import type { Route } from "./+types/activity.export";

// The activity log as CSV (TS-072), at the address of the log's page with
// `/export` after it and the same query, so it holds the same records, every
// one of them, newest first. It sits below the Activity log, so the
// organisation layout's checks cover it: anybody not shown the log gets 404.
// The file is streamed a page of records at a time.

/** The columns, in their order. */
export const ACTIVITY_CSV_COLUMNS = [
	"recorded_at",
	"performed_by",
	"source",
	"action",
	"what",
	"owned_by",
	"subject_type",
	"subject_id",
	"changes",
] as const;

/** How many records are read at a time. */
const PAGE = 500;

async function* csvChunks(log: LogRequest): AsyncGenerator<string> {
	yield BYTE_ORDER_MARK + csvLine(ACTIVITY_CSV_COLUMNS);
	let after: LogCursor | undefined;
	for (;;) {
		const records = await logRecords(log, PAGE, after);
		if (records.length === 0) return;
		const rows = await logRows(log.scope, records, log.zone);
		yield rows
			.map((row) =>
				csvLine([
					isoInstant(row.at),
					row.actor,
					row.source,
					row.action,
					row.what,
					row.owner ?? "",
					row.subjectType,
					row.subjectId,
					row.changesText,
				]),
			)
			.join("");
		const last = records.at(-1);
		if (!last || records.length < PAGE) return;
		after = { at: last.createdAt, id: last.id };
	}
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const { organisation } = membership;
	const scope = organisationScope(env.DB, organisation.id);
	const query = parseLogQuery(new URL(request.url).searchParams);
	const log = query === null ? null : await logRequest(membership, query, Date.now(), scope);
	if (!log) return new Response("Those filters are not ones the log knows.", { status: 400 });
	const chunks = csvChunks(log);
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
	const filename = exportFilename(
		organisation.name,
		`activity-${log.first}-to-${log.last}`,
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
