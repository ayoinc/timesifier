import { parseReportQuery } from "./query";

/**
 * Saved reports (TS-080, B18), apart from the database: which views can be
 * saved, and the query a view is saved with. A saved report holds the
 * question, never the answer: its range kind, its days only where the range
 * names them (a custom range, a week or a month Previous and Next stepped
 * to), its grouping and its person. Reopened, it is asked again of today's
 * data, so "Last month" saved in October shows September and opened in
 * December shows November. Its name is a record name (`recordName`).
 */

export const SAVED_VIEWS = ["time", "utilisation", "profitability", "leave"] as const;
export type SavedView = (typeof SAVED_VIEWS)[number];

export const SAVED_VIEW_LABELS: Record<SavedView, string> = {
	time: "Time",
	utilisation: "Utilisation",
	profitability: "Profitability",
	leave: "Leave",
};

/**
 * The query `view` is saved with, from the address it is shown at: the view
 * first, then only what makes the report, in a fixed order. Null for an
 * address that asks for no report.
 */
export function savedQueryOf(view: SavedView, params: URLSearchParams): string | null {
	const parsed = parseReportQuery(params);
	if (!parsed || parsed.problem) return null;
	const { query } = parsed;
	const saved = new URLSearchParams({ view, range: query.range });
	const named = query.range === "custom" || query.range === "week" || query.range === "month";
	if (named && query.from !== undefined) saved.set("from", query.from);
	if (query.range === "custom" && query.to !== undefined) saved.set("to", query.to);
	if (view === "time") saved.set("group", query.group);
	if (query.person !== undefined) saved.set("person", query.person);
	if (view === "time" && query.tag !== undefined) saved.set("tag", query.tag);
	const year = params.get("year");
	if (view === "leave" && year !== null && /^\d{4}$/.test(year)) saved.set("year", year);
	return saved.toString();
}

/** A saved query read back: its view and the rest of its address. Null for one the Worker never wrote. */
export function readSavedQuery(
	stored: string,
): { view: SavedView; search: URLSearchParams } | null {
	const search = new URLSearchParams(stored);
	const view = search.get("view") ?? "";
	if (!(SAVED_VIEWS as readonly string[]).includes(view)) return null;
	search.delete("view");
	return { view: view as SavedView, search };
}
