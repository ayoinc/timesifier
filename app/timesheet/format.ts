import { useDateFormatter } from "react-aria";

import type { Day } from "~/time/calendar";

/**
 * How the Timesheet writes days and times. A time is shown in the zone the
 * person's days are counted in, which the loader sends, not the browser's: the
 * same entry reads the same on every device (decision 26). A day is a date
 * with no time, so it is written as UTC writes it.
 */

/** Midnight UTC of `day`: the instant a day is formatted from. */
const asDate = (day: Day) => new Date(`${day}T00:00:00Z`);

/** Writes an instant as a 24-hour time in `zone`: `09:30`. */
export function useClockFormat(zone: string) {
	const format = useDateFormatter({
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZone: zone,
	});
	return (instant: number) => format.format(new Date(instant));
}

/** Writes a day in full, `Wednesday 11 November`, or briefly, `Wed 11`. */
export function useDayFormat(style: "long" | "short" = "long") {
	const format = useDateFormatter(
		style === "long"
			? { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }
			: { weekday: "short", day: "numeric", timeZone: "UTC" },
	);
	return (day: Day) => format.format(asDate(day));
}

/** Writes the days of a period, `9 – 15 November 2026`. */
export function usePeriodFormat() {
	const format = useDateFormatter({
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});
	return (startsOn: Day, endsOn: Day) => format.formatRange(asDate(startsOn), asDate(endsOn));
}

/** A day as a whole number, which grows a day at a time: what the direction of travel is read from. */
export function dayNumber(day: Day): number {
	return Date.parse(`${day}T00:00:00Z`) / 86_400_000;
}
