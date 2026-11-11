import { duration } from "~/landing/example-week";
import type { PeriodDays, PeriodStatus } from "~/periods/periods";
import { Day } from "~/time/calendar";

/** A day in words, with only the parts asked for: "9", "9 November", "9 November 2026". */
function dateWords(day: Day, parts: "day" | "month" | "year"): string {
	return new Intl.DateTimeFormat("en-GB", {
		day: "numeric",
		...(parts === "day" ? {} : { month: "long" }),
		...(parts === "year" ? { year: "numeric" } : {}),
		timeZone: "UTC",
	}).format(new Date(`${day}T00:00:00Z`));
}

// How Team and Approvals put periods, their states and lengths of time into
// words. Nothing here runs only on the server.

/** Seconds as hours and minutes: 27000 is "7:30". */
export function hours(seconds: number): string {
	return duration(Math.floor(seconds / 60));
}

/** Where a period stands, as a person reads it. A withdrawn period is one not submitted. */
export function statusLabel(status: PeriodStatus | null): string {
	switch (status) {
		case "submitted":
			return "Submitted";
		case "approved":
			return "Approved";
		case "returned":
			return "Returned";
		default:
			return "Not submitted";
	}
}

/** A period's days: "9 to 15 November 2026", "28 December 2026 to 3 January 2027". */
export function periodLabel({ startsOn, endsOn }: PeriodDays): string {
	const first =
		startsOn.slice(0, 4) !== endsOn.slice(0, 4)
			? "year"
			: startsOn.slice(0, 7) !== endsOn.slice(0, 7)
				? "month"
				: "day";
	return `${dateWords(startsOn, first)} to ${dateWords(endsOn, "year")}`;
}

/** A day as written on a person's week: "Monday 9 November". */
export function dayLabel(day: Day): string {
	return new Intl.DateTimeFormat("en-GB", {
		weekday: "long",
		day: "numeric",
		month: "long",
		timeZone: "UTC",
	}).format(new Date(`${day}T00:00:00Z`));
}

/** The query that names the period a page shows by its first day: `?week=2026-11-09`. */
export const WEEK_PARAM = "week";

/** The day in a query, when it is one, such as `?week=2026-11-09`. */
export function dayParam(value: string | null): Day | null {
	const parsed = Day.safeParse(value);
	return parsed.success ? parsed.data : null;
}
