import { data } from "react-router";
import * as z from "zod";

import { periodContaining } from "~/periods/periods";
import { WELCOME_PARAM } from "~/shell/destinations";
import { Day } from "~/time/calendar";

import { CALENDAR_SCALES, type CalendarScale, DEFAULT_ZOOM, ZOOMS, type Zoom } from "./views";

/**
 * Reads which view of Timesheet an address asks for (`views.ts` names the
 * addresses). On the server alone: a Zod object schema compiles itself with
 * `new Function` where it can, which the Content Security Policy forbids in the
 * browser.
 */

const Query = z.union([
	z.object({ view: z.literal("day").optional(), day: Day.optional() }).strict(),
	z.object({ view: z.literal("week"), start: Day.optional() }).strict(),
	z
		.object({
			view: z.literal("calendar"),
			scale: z.enum(CALENDAR_SCALES).optional(),
			date: Day.optional(),
			zoom: z.enum(ZOOMS).optional(),
		})
		.strict(),
	z.object({ view: z.literal("history") }).strict(),
]);

export type ChosenView =
	| { view: "day"; day: Day | null }
	| { view: "week"; start: Day | null }
	| { view: "calendar"; scale: CalendarScale; date: Day | null; zoom: Zoom }
	| { view: "history" };

/** Fields of an address that are not the view's: the welcome's mark, and the index route's. */
const NOT_THE_VIEWS = new Set([WELCOME_PARAM, "index"]);

/**
 * The view an address asks for. A day or a start that is not a date, a start
 * that is not the first day of a period of the organisation, an unknown view or
 * an unknown field answers 400 (TS-013).
 */
export function chosenView(searchParams: URLSearchParams, weekStartsOn: number): ChosenView {
	const fields = Object.fromEntries(
		[...searchParams.entries()].filter(([name]) => !NOT_THE_VIEWS.has(name)),
	);
	const parsed = Query.safeParse(fields);
	if (!parsed.success) throw badView();
	const query = parsed.data;
	if (query.view === "week") {
		const start = query.start ?? null;
		if (start !== null && periodContaining(start, weekStartsOn).startsOn !== start) {
			throw badView();
		}
		return { view: "week", start };
	}
	if (query.view === "calendar") {
		const scale = query.scale ?? "week";
		// A month has no hours to zoom.
		if (scale === "month" && query.zoom !== undefined) throw badView();
		return { view: "calendar", scale, date: query.date ?? null, zoom: query.zoom ?? DEFAULT_ZOOM };
	}
	if (query.view === "history") return { view: "history" };
	return { view: "day", day: query.day ?? null };
}

function badView() {
	return data("Bad Request", { status: 400 });
}
