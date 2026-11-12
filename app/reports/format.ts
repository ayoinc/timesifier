import type { Day } from "~/time/calendar";
import { formatDay, formatDuration, formatRange, formatTime } from "~/time/format";

import type { Range } from "./choices";

/**
 * How a report puts its figures into words (docs/design-direction.md, "Totals
 * and figures"), in the forms every page uses (`app/time/format.ts`): a length
 * as hours and minutes, a time of day on the 24-hour clock, a day by its
 * weekday, date and month. The server writes them, in the organisation's zone,
 * so the page reads the same before and after it hydrates.
 */

/** A length of time as hours and minutes, the seconds dropped: 5400 is "1:30". */
export function hoursAndMinutes(seconds: number): string {
	return formatDuration(seconds);
}

/** A day as a row names it: "Monday 2 November". */
export function dayLabel(day: Day): string {
	return formatDay(day);
}

/** A range of days as the report's heading line names it: "2–8 November 2026". */
export function rangeLabel(first: Day, last: Day): string {
	return formatRange(first, last);
}

/**
 * What Previous and Next move a range by, as their words end: "week", "month",
 * "day", "10 days".
 */
export function stepUnit(range: Range, { first, last }: { first: Day; last: Day }): string {
	switch (range) {
		case "this-week":
		case "last-week":
		case "week":
			return "week";
		case "this-month":
		case "last-month":
		case "month":
			return "month";
		case "custom": {
			const length =
				(Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000 + 1;
			return length === 1 ? "day" : `${length} days`;
		}
	}
}

/** The time of day at `instant` in `zone`, on the 24-hour clock: "09:15". */
export function clockIn(instant: number, zone: string): string {
	return formatTime(instant, zone);
}
