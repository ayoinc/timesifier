import type { Day } from "~/time/calendar";

import type { Range } from "./choices";

/**
 * How a report puts its figures into words (docs/design-direction.md, "Totals
 * and figures"): a length as hours and minutes, a time of day on the 24-hour
 * clock, a day by its weekday, date and month. The server writes them, in the
 * organisation's zone, so the page reads the same before and after it hydrates.
 */

/** A length of time as hours and minutes, the seconds dropped: 5400 is "1:30". */
export function hoursAndMinutes(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** A day's own midnight in UTC, which a formatter in UTC reads back as that day. */
const asUtc = (day: Day) => new Date(`${day}T00:00:00Z`);

const dayFormat = new Intl.DateTimeFormat("en-GB", {
	weekday: "short",
	day: "numeric",
	month: "short",
	timeZone: "UTC",
});

/** A day as a row names it: "Mon 2 Nov". */
export function dayLabel(day: Day): string {
	return dayFormat.format(asUtc(day)).replace(",", "");
}

const rangeFormat = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "long",
	year: "numeric",
	timeZone: "UTC",
});

/** A range of days as the report's heading line names it: "2–8 November 2026". */
export function rangeLabel(first: Day, last: Day): string {
	return first === last
		? rangeFormat.format(asUtc(first))
		: rangeFormat.formatRange(asUtc(first), asUtc(last));
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
		case "month":
			return "month";
		case "custom": {
			const length = (asUtc(last).getTime() - asUtc(first).getTime()) / 86_400_000 + 1;
			return length === 1 ? "day" : `${length} days`;
		}
	}
}

const clockFormats = new Map<string, Intl.DateTimeFormat>();

/** The time of day at `instant` in `zone`, on the 24-hour clock: "09:15". */
export function clockIn(instant: number, zone: string): string {
	let format = clockFormats.get(zone);
	if (!format) {
		format = new Intl.DateTimeFormat("en-GB", {
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
			timeZone: zone,
		});
		clockFormats.set(zone, format);
	}
	return format.format(instant);
}
