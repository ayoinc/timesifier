import * as z from "zod";

import type { Day } from "~/time/calendar";

/**
 * When a recurring invoice is issued (TS-078). Each issue date is counted
 * from the first one, by whole months, so a template that starts on the 31st
 * is issued on the last day of a shorter month and on the 31st again in the
 * next long one: the day never drifts.
 */

export const Frequency = z.enum(["monthly", "quarterly", "yearly"]);
export type Frequency = z.infer<typeof Frequency>;

export const FREQUENCY_LABELS: Record<Frequency, string> = {
	monthly: "Every month",
	quarterly: "Every three months",
	yearly: "Every year",
};

const MONTHS: Record<Frequency, number> = { monthly: 1, quarterly: 3, yearly: 12 };

/** The days in `month` (1 to 12) of `year`. */
function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The `count`th issue date after `startsOn` (0 is `startsOn` itself): the same
 * day of the month, or the month's last day when it has fewer days.
 */
export function occurrence(startsOn: Day, frequency: Frequency, count: number): Day {
	const [year = 0, month = 1, day = 1] = startsOn.split("-").map(Number);
	const months = month - 1 + count * MONTHS[frequency];
	const y = year + Math.floor(months / 12);
	const m = (months % 12) + 1;
	const d = Math.min(day, daysInMonth(y, m));
	return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The first issue date of the series from `startsOn` that is later than `after`. */
export function nextIssueAfter(startsOn: Day, frequency: Frequency, after: Day): Day {
	// Roughly where `after` falls in the series, then forward to the first later date.
	const [y1 = 0, m1 = 1] = startsOn.split("-").map(Number);
	const [y2 = 0, m2 = 1] = after.split("-").map(Number);
	let count = Math.max(0, Math.floor(((y2 - y1) * 12 + (m2 - m1)) / MONTHS[frequency]) - 1);
	while (occurrence(startsOn, frequency, count) <= after) count++;
	return occurrence(startsOn, frequency, count);
}
