import { useEffect, useRef } from "react";
import { useFetcher, useFetchers, useLocation, useNavigation } from "react-router";

import { periodContaining } from "~/periods/periods";
import type { loader, TimesheetAnswer } from "~/routes/app/timesheet";
import { organisationPath } from "~/shell/destinations";
import { addDays, type Day } from "~/time/calendar";

import { monthAfter, monthOf } from "./calendar-sheets";
import { REFRESH_EVERY_MS } from "./live";
import type { TimesheetData } from "./timesheet.server";
import {
	CALENDAR_SCALES,
	type CalendarScale,
	calendarPath,
	DEFAULT_ZOOM,
	dayPath,
	weekPath,
	ZOOMS,
	type Zoom,
} from "./views";

/**
 * The Timesheet answers a press before the server does (TS-114, live-feel F1,
 * harvest sweep S2-01). A step or a view tab is a link to an address of the
 * Timesheet, so the view, the day and the period it asks for are known the
 * moment it is pressed: the date label, the selected day and the tab are drawn
 * from that address at once, while the content the server is replacing dims.
 *
 * The answers of the periods either side of the one on screen are read while
 * the page is idle and kept for the session, as is the answer on screen. A step
 * to one of them draws it from memory in the frame of the press; the server's
 * answer then takes its place. What a person changes clears every answer kept,
 * and none older than the pages' own refresh is used.
 */

/** The view a press asked for, read from the address it moves to. */
export type Aim =
	| { view: "day"; day: Day }
	| { view: "week"; start: Day }
	| { view: "calendar"; scale: CalendarScale; date: Day; zoom: Zoom }
	| { view: "history" };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isOneOf<T extends string>(list: readonly T[], value: string): value is T {
	return (list as readonly string[]).includes(value);
}

/**
 * The view the Timesheet's address `search` asks for, with today and this week
 * where it names no day; null for an address the server would refuse, which is
 * then left to the server to say.
 */
export function aimOf(search: string, today: Day, weekStartsOn: number): Aim | null {
	const params = new URLSearchParams(search);
	const dateIn = (name: string): Day | null => {
		const value = params.get(name);
		if (value === null) return today;
		return DATE.test(value) ? value : null;
	};
	switch (params.get("view") ?? "day") {
		case "day": {
			const day = dateIn("day");
			return day === null ? null : { view: "day", day };
		}
		case "week": {
			const start = dateIn("start");
			return start === null
				? null
				: { view: "week", start: periodContaining(start, weekStartsOn).startsOn };
		}
		case "calendar": {
			const scale = params.get("scale") ?? "week";
			const zoom = params.get("zoom") ?? DEFAULT_ZOOM;
			const date = dateIn("date");
			if (date === null || !isOneOf(CALENDAR_SCALES, scale) || !isOneOf(ZOOMS, zoom)) return null;
			return { view: "calendar", scale, date, zoom };
		}
		case "history":
			return { view: "history" };
		default:
			return null;
	}
}

/** The view an answer of the server is of. */
export function aimOfData(data: TimesheetData): Aim {
	switch (data.view) {
		case "day":
			return { view: "day", day: data.day };
		case "week":
			return { view: "week", start: data.period.startsOn };
		case "calendar":
			return { view: "calendar", scale: data.scale, date: data.date, zoom: data.zoom };
		case "history":
			return { view: "history" };
	}
}

/** A view with steps: every one but History. */
export type SteppedAim = Exclude<Aim, { view: "history" }>;

/** Where the steps either side of `aim` go: the day, the week or the month before and after. */
export function stepsAround(
	slug: string,
	aim: SteppedAim,
	weekStartsOn: number,
): { previous: string; next: string } {
	switch (aim.view) {
		case "day":
			return {
				previous: dayPath(slug, addDays(aim.day, -1)),
				next: dayPath(slug, addDays(aim.day, 1)),
			};
		case "week":
			return {
				previous: weekPath(slug, addDays(aim.start, -7)),
				next: weekPath(slug, addDays(aim.start, 7)),
			};
		case "calendar": {
			if (aim.scale === "month") {
				const month = monthOf(aim.date);
				return {
					previous: calendarPath(slug, { scale: "month", date: monthAfter(month, -1) }),
					next: calendarPath(slug, { scale: "month", date: monthAfter(month, 1) }),
				};
			}
			const first = periodContaining(aim.date, weekStartsOn).startsOn;
			return {
				previous: calendarPath(slug, { date: addDays(first, -7), zoom: aim.zoom }),
				next: calendarPath(slug, { date: addDays(first, 7), zoom: aim.zoom }),
			};
		}
	}
}

function isMutation(formMethod: string | undefined): boolean {
	return formMethod !== undefined && formMethod.toUpperCase() !== "GET";
}

/** The address the Timesheet is moving to, while a press on it waits for the server; null otherwise. */
function useMovingTo(slug: string): { pathname: string; search: string } | null {
	const navigation = useNavigation();
	if (navigation.state !== "loading" || isMutation(navigation.formMethod)) return null;
	const { pathname, search } = navigation.location;
	return pathname === organisationPath(slug) ? { pathname, search } : null;
}

// The answers kept, by address: the one on screen and its neighbours.
const kept = new Map<string, { answer: TimesheetAnswer; at: number }>();

/** One address for each view, whatever the order of its fields or the index route's mark. */
function keyOf(path: string): string {
	const url = new URL(path, "http://timesheet.invalid");
	url.searchParams.delete("index");
	url.searchParams.sort();
	return `${url.pathname}?${url.searchParams}`;
}

function freshAt(path: string): TimesheetAnswer | undefined {
	const held = kept.get(keyOf(path));
	if (held === undefined || Date.now() - held.at > REFRESH_EVERY_MS) return undefined;
	return held.answer;
}

/** A path of the Timesheet as a fetcher reads it: from the index route, not the organisation's layout. */
function indexPath(path: string): string {
	return `${path}${path.includes("?") ? "&" : "?"}index`;
}

/**
 * What a press on the Timesheet asks for while the server answers it: the view
 * it aims at, and that view's answer when the page holds a fresh one.
 */
export function useAim(
	slug: string,
	today: Day,
	weekStartsOn: number,
): { aim: Aim | null; held: TimesheetAnswer | undefined } {
	const moving = useMovingTo(slug);
	if (moving === null) return { aim: null, held: undefined };
	return {
		aim: aimOf(moving.search, today, weekStartsOn),
		held: freshAt(`${moving.pathname}${moving.search}`),
	};
}

/**
 * Keeps the answer on screen, and reads the answers at `neighbours` once the
 * page has settled: a press that keeps a key held reads only where it stops.
 * Anything sent to the server clears what is kept.
 */
export function useWarmNeighbours(answer: TimesheetAnswer, neighbours: readonly string[]) {
	const { pathname, search } = useLocation();
	const here = `${pathname}${search}`;
	const navigation = useNavigation();
	const fetchers = useFetchers();
	const sending =
		isMutation(navigation.formMethod) || fetchers.some((each) => isMutation(each.formMethod));
	const settled = navigation.state === "idle" && !sending;

	useEffect(() => {
		if (sending) kept.clear();
	}, [sending]);
	useEffect(() => {
		kept.set(keyOf(here), { answer, at: Date.now() });
	}, [here, answer]);

	useWarm(neighbours[0] ?? null, settled);
	useWarm(neighbours[1] ?? null, settled);
}

/** How long the page is left still before a neighbour is read. */
const SETTLE_MS = 150;

function useWarm(path: string | null, settled: boolean) {
	const { load, reset, state, data } = useFetcher<typeof loader>();
	const asked = useRef<string | null>(null);
	useEffect(() => {
		if (!settled || path === null || freshAt(path) !== undefined) return;
		const timer = setTimeout(() => {
			if (document.visibilityState !== "visible") return;
			asked.current = path;
			void load(indexPath(path));
		}, SETTLE_MS);
		return () => clearTimeout(timer);
	}, [settled, path, load]);
	useEffect(() => {
		if (state !== "idle" || data === undefined || asked.current === null) return;
		kept.set(keyOf(asked.current), { answer: data, at: Date.now() });
		asked.current = null;
		// Kept here now: a fetcher with data is read again after every change sent, which this one need not be.
		reset();
	}, [state, data, reset]);
}
