import { organisationPath } from "../shell/destinations";
import type { Day } from "../time/calendar";

/**
 * The views of Timesheet and their addresses (docs/navigation.md: "Day view:
 * the timer and the day's entries. Week view: … Calendar … History lists past
 * periods"). All four are the destination's own address with a query, so the
 * navigation marks Timesheet on each and the check of who may open it is the
 * destination's:
 *
 * - `/app/<slug>` or `?day=YYYY-MM-DD`: one day, today in the person's zone by default.
 * - `?view=week` or `?view=week&start=YYYY-MM-DD`: the period that starts on that day.
 * - `?view=calendar`, with `scale=month`, `date=YYYY-MM-DD` and `zoom=compact`
 *   where they are not the defaults: the week or the month that holds the day (TS-062).
 * - `?view=history`: the person's periods and their status.
 */

export const VIEWS = ["day", "week", "calendar", "history"] as const;
export type View = (typeof VIEWS)[number];

export const VIEW_LABELS: Record<View, string> = {
	day: "Day",
	week: "Week",
	calendar: "Calendar",
	history: "History",
};

/** What the calendar shows at once: a week on an hour axis, or a month of days. */
export const CALENDAR_SCALES = ["week", "month"] as const;
export type CalendarScale = (typeof CALENDAR_SCALES)[number];

/** How tall the week calendar's hours are: the whole day in view, or tall enough to read a quarter of an hour. */
export const ZOOMS = ["compact", "detailed"] as const;
export type Zoom = (typeof ZOOMS)[number];

/** The week calendar's zoom when the address names none. */
export const DEFAULT_ZOOM: Zoom = "detailed";

/**
 * What the Track time sheet reads for the date chosen in it, from any page
 * (taste HT-C), and the month the day title's picker shows (HT-D): two
 * addresses of data under the organisation, `?day=` and `?date=`.
 */
export const TRACK_DAY_SEGMENT = "timesheet/day";
export const PICKER_MONTH_SEGMENT = "timesheet/month";

export function trackDayPath(slug: string, day?: Day): string {
	return `${organisationPath(slug)}/${TRACK_DAY_SEGMENT}${day ? `?day=${day}` : ""}`;
}

export function pickerMonthPath(slug: string, date: Day): string {
	return `${organisationPath(slug)}/${PICKER_MONTH_SEGMENT}?date=${date}`;
}

/** The address of the Day view, of `day` or of today. */
export function dayPath(slug: string, day?: Day): string {
	return day ? `${organisationPath(slug)}?day=${day}` : organisationPath(slug);
}

/** The address of the Week view, of the period starting on `start` or of this one. */
export function weekPath(slug: string, start?: Day): string {
	return `${organisationPath(slug)}?view=week${start ? `&start=${start}` : ""}`;
}

/**
 * The address of the calendar: the week or the month that holds `date`, or
 * today when there is none, and the week's zoom. A default is left out, so
 * each calendar has one address.
 */
export function calendarPath(
	slug: string,
	{
		scale = "week",
		date,
		zoom = DEFAULT_ZOOM,
	}: { scale?: CalendarScale; date?: Day; zoom?: Zoom } = {},
): string {
	const query = new URLSearchParams({ view: "calendar" });
	if (scale !== "week") query.set("scale", scale);
	if (date) query.set("date", date);
	if (scale === "week" && zoom !== DEFAULT_ZOOM) query.set("zoom", zoom);
	return `${organisationPath(slug)}?${query}`;
}

/** The address of History. */
export function historyPath(slug: string): string {
	return `${organisationPath(slug)}?view=history`;
}

/** The address of `view` with nothing chosen: today, this week. */
export function viewPath(slug: string, view: View): string {
	if (view === "week") return weekPath(slug);
	if (view === "calendar") return calendarPath(slug);
	if (view === "history") return historyPath(slug);
	return dayPath(slug);
}

/**
 * Where a form that starts or stops the timer posts from any page: the
 * Timesheet's own action. `?index` names the index route rather than the
 * organisation's layout, which shares its address.
 */
export function timerAction(slug: string): string {
	return `${organisationPath(slug)}?index`;
}
