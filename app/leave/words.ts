import { formatDuration, formatRange } from "~/time/format";

import type { LeaveSpan } from "./days";

// How the pages put leave into words, in the forms every page uses
// (`app/time/format.ts`). Nothing here runs only on the server.

/**
 * A request's days: "14 December 2026, half day", "14–18 December 2026",
 * "14–18 December 2026, half days at the start and the end".
 */
export function spanLabel(span: LeaveSpan): string {
	const days = formatRange(span.startsOn, span.endsOn);
	if (span.startsOn === span.endsOn) return `${days}${span.startsHalf ? ", half day" : ""}`;
	if (span.startsHalf && span.endsHalf) return `${days}, half days at the start and the end`;
	if (span.startsHalf) return `${days}, half day at the start`;
	if (span.endsHalf) return `${days}, half day at the end`;
	return days;
}

/** The days of the week as the working week is listed, Monday first. */
export const WEEKDAY_NAMES = [
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
	"Sunday",
] as const;

/** A working week in words: "Monday to Friday, 7:30 a day", or each day that differs. */
export function workingWeekLabel(week: readonly number[]): string {
	const worked = week.flatMap((minutes, index) => (minutes > 0 ? [{ index, minutes }] : []));
	if (worked.length === 0) return "No working days";
	const same = worked.every((d) => d.minutes === worked[0]?.minutes);
	const consecutive = worked.every(
		(d, i) => i === 0 || d.index === (worked[i - 1]?.index ?? 0) + 1,
	);
	const first = worked[0];
	const last = worked.at(-1);
	if (same && consecutive && first && last && worked.length > 1) {
		return `${WEEKDAY_NAMES[first.index]} to ${WEEKDAY_NAMES[last.index]}, ${formatDuration(first.minutes * 60)} a day`;
	}
	return worked
		.map((d) => `${WEEKDAY_NAMES[d.index]} ${formatDuration(d.minutes * 60)}`)
		.join(", ");
}
