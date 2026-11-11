import type { Day } from "~/time/calendar";
import { formatDay, formatRange, formatTime } from "~/time/format";

/**
 * How the Timesheet writes days and times: as every page does, through
 * `app/time/format.ts`. A time is shown in the zone the person's days are
 * counted in, which the loader sends, not the browser's: the same entry reads
 * the same on every device (decision 26). Nothing here reads the browser's
 * locale or zone, so the server's text and the browser's are the same and the
 * page hydrates without a mismatch (audit W06). The `use` names are kept so the
 * components that call them need no change; none of them holds state.
 */

/** Writes an instant as a 24-hour time in `zone`: `09:30`. */
export function useClockFormat(zone: string) {
	return (instant: number) => formatTime(instant, zone);
}

/** Writes a day in full, `Wednesday 11 November`, or briefly, `Wed 11`. */
export function useDayFormat(style: "long" | "short" = "long") {
	return (day: Day) => formatDay(day, style);
}

/** Writes the days of a period, `9–15 November 2026`. */
export function usePeriodFormat() {
	return formatRange;
}

/** A day as a whole number, which grows a day at a time: what the direction of travel is read from. */
export function dayNumber(day: Day): number {
	return Date.parse(`${day}T00:00:00Z`) / 86_400_000;
}
