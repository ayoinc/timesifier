import type { Day } from "~/time/calendar";

import type { Row } from "./report";

/**
 * The export of a report as CSV (TS-014b): RFC 4180, UTF-8, lines ended by
 * CRLF. Its rows are the report's rows: one for each entry that starts in the
 * range, the rows the page lists (docs/decisions.md entry 26). Times are UTC,
 * in ISO 8601 with `Z`, to the second. The duration is the entry's whole
 * minutes, in seconds, as the page counts it, so the durations add up to the
 * page's total.
 */

/** The columns, in their order. */
export const CSV_COLUMNS = [
	"entry_id",
	"person",
	"project",
	"client",
	"description",
	"started_at",
	"ended_at",
	"duration_seconds",
] as const;

/**
 * The byte order mark the file starts with. It is not needed to read UTF-8,
 * but without it Excel reads the file in the machine's own code page, and a
 * name with an accent comes out wrong.
 */
export const BYTE_ORDER_MARK = "\uFEFF";

/**
 * What a spreadsheet would read as the start of a formula: `=`, `+`, `-`, `@`,
 * a tab or a carriage return (OWASP, "CSV Injection").
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One cell, safe to open in a spreadsheet: a value that could start a formula
 * is prefixed with `'`, which a spreadsheet shows as text; then a value with a
 * comma, a quote or a line break is quoted, its quotes doubled.
 */
export function csvCell(value: string): string {
	const text = FORMULA_START.test(value) ? `'${value}` : value;
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One line of the file, with its CRLF. */
export function csvLine(cells: readonly string[]): string {
	return `${cells.map(csvCell).join(",")}\r\n`;
}

/** An instant in UTC, in ISO 8601 with `Z`, to the second: "2026-11-02T09:00:00Z". */
export function isoInstant(instant: number): string {
	return new Date(instant).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The cells of one row, in the order of `CSV_COLUMNS`. A running entry has no
 * end. The client is left empty while the organisation has Clients turned off.
 */
export function rowCells(row: Row, showClients: boolean): string[] {
	const { entry } = row;
	return [
		entry.id,
		entry.person,
		entry.project,
		(showClients && entry.client) || "",
		entry.description ?? "",
		isoInstant(row.start),
		row.running ? "" : isoInstant(row.end),
		String(row.minutes * 60),
	];
}

/** The file's name: the organisation and the range, "timesifier-acme-2026-11-02-to-2026-11-08.csv". */
export function csvFilename(slug: string, first: Day, last: Day): string {
	return `timesifier-${slug}-${first}-to-${last}.csv`;
}
