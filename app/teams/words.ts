import type { PeriodDays, PeriodStatus } from "~/periods/periods";
import { Day } from "~/time/calendar";
import { formatDay, formatDuration, formatRange } from "~/time/format";

// How Team and Approvals put periods, their states and lengths of time into
// words, in the forms every page uses (`app/time/format.ts`). Nothing here runs
// only on the server.

/** Seconds as hours and minutes: 27000 is "7:30". */
export function hours(seconds: number): string {
	return formatDuration(seconds);
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

/** A period's days: "9–15 November 2026", "28 December 2026 – 3 January 2027". */
export function periodLabel({ startsOn, endsOn }: PeriodDays): string {
	return formatRange(startsOn, endsOn);
}

/** A day as written on a person's week: "Monday 9 November". */
export function dayLabel(day: Day): string {
	return formatDay(day);
}

/** The query that names the period a page shows by its first day: `?week=2026-11-09`. */
export const WEEK_PARAM = "week";

/** The day in a query, when it is one, such as `?week=2026-11-09`. */
export function dayParam(value: string | null): Day | null {
	const parsed = Day.safeParse(value);
	return parsed.success ? parsed.data : null;
}
