import { organisationPath } from "~/shell/destinations";
import type { Day } from "~/time/calendar";

/**
 * The views of Timesheet and their addresses (docs/navigation.md: "Day view:
 * the timer and the day's entries. Week view: … History lists past periods").
 * All three are the destination's own address with a query, so the navigation
 * marks Timesheet on each and the check of who may open it is the
 * destination's:
 *
 * - `/app/<slug>` or `?day=YYYY-MM-DD`: one day, today in the person's zone by default.
 * - `?view=week` or `?view=week&start=YYYY-MM-DD`: the period that starts on that day.
 * - `?view=history`: the person's periods and their status.
 */

export const VIEWS = ["day", "week", "history"] as const;
export type View = (typeof VIEWS)[number];

export const VIEW_LABELS: Record<View, string> = { day: "Day", week: "Week", history: "History" };

/** Where on the Day view "Track time" is: "Start timer" in the navigation leads here, and the sheet opens. */
export const TIMER_ANCHOR = "timer";

/** The address of the Day view, of `day` or of today. */
export function dayPath(slug: string, day?: Day): string {
	return day ? `${organisationPath(slug)}?day=${day}` : organisationPath(slug);
}

/** The address of the Week view, of the period starting on `start` or of this one. */
export function weekPath(slug: string, start?: Day): string {
	return `${organisationPath(slug)}?view=week${start ? `&start=${start}` : ""}`;
}

/** The address of History. */
export function historyPath(slug: string): string {
	return `${organisationPath(slug)}?view=history`;
}

/** The address of `view` with nothing chosen: today, this week. */
export function viewPath(slug: string, view: View): string {
	if (view === "week") return weekPath(slug);
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
