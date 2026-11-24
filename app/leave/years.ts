import * as z from "zod";

import { addDays, type Day } from "~/time/calendar";
import { formatRange } from "~/time/format";

/**
 * The organisation's leave year (TS-098b, decision 76): it starts on one day
 * of every year, 1 January unless an owner or admin chooses another, and runs
 * to the day before that day a year later. A leave year is named by the
 * calendar year it starts in. Nothing here reads the database or a clock.
 */

/** Where every organisation's leave year starts until it chooses another: 1 January, as before. */
export const CALENDAR_YEAR = "01-01";

const MONTH_DAY = /^(\d{2})-(\d{2})$/;

/** A day of the month on which a leave year may start, `MM-DD`: any day of every year, so never 29 February. */
export const LeaveYearStarts = z
	.string()
	.regex(MONTH_DAY)
	.refine((value) => {
		// 2001 was not a leap year: 29 February, and any day a month does not have, comes back as another.
		const day = `2001-${value}`;
		return new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
	}, "Not a day of every year.");

/** A leave year: the calendar year it starts in, and its first and last days. */
export interface LeaveYear {
	year: number;
	first: Day;
	last: Day;
}

/** The leave year named `year`, for an organisation whose leave year starts on `starts`. */
export function leaveYear(starts: string, year: number): LeaveYear {
	return {
		year,
		first: `${year}-${starts}`,
		last: addDays(`${year + 1}-${starts}`, -1),
	};
}

/** The name of the leave year `day` falls in: the calendar year it started in. */
export function leaveYearOf(starts: string, day: Day): number {
	const year = Number(day.slice(0, 4));
	return day.slice(5) >= starts ? year : year - 1;
}

/** A leave year as a heading names it: "2026" for a calendar year, else "1 April 2026 – 31 March 2027". */
export function leaveYearLabel(starts: string, year: number): string {
	if (starts === CALENDAR_YEAR) return String(year);
	const { first, last } = leaveYear(starts, year);
	return formatRange(first, last);
}

/** Where a leave year starts, in words: "1 January", "6 April". */
export function startsLabel(starts: string): string {
	const label = formatRange(`2001-${starts}`, `2001-${starts}`);
	return label.replace(/ 2001$/, "");
}
