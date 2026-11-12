import type { Day } from "~/time/calendar";

/**
 * The Leave view's address and its export (TS-084), apart from the database:
 * which leave year it shows, and the cells of its CSV. Figures in the file are
 * days, a half day as .5, so the file's columns add up as the screen's do.
 */

/** The earliest and latest leave year the view will show. */
const FIRST_YEAR = 2000;
const LAST_YEAR = 2100;

/** The leave year `year` asks for, this year when it asks for none, or null for one that is not a year. */
export function leaveYearOf(year: string | null, today: Day): number | null {
	if (year === null || year === "") return Number(today.slice(0, 4));
	if (!/^\d{4}$/.test(year)) return null;
	const value = Number(year);
	return value >= FIRST_YEAR && value <= LAST_YEAR ? value : null;
}

/** The columns of the Leave export, in their order: one row for each person and kind. */
export const LEAVE_CSV_COLUMNS = [
	"person",
	"email",
	"kind",
	"year",
	"allowance_days",
	"taken_days",
	"booked_days",
	"pending_days",
	"remaining_days",
] as const;

/** Half days as days in a CSV cell: 5 is "2.5"; none is empty. */
export function daysCell(halfDays: number | null): string {
	return halfDays === null ? "" : String(halfDays / 2);
}

/** The file's name: "timesifier-acme-leave-2026.csv". */
export function leaveCsvFilename(slug: string, year: number): string {
	return `timesifier-${slug}-leave-${year}.csv`;
}
