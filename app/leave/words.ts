import { periodLabel } from "~/teams/words";
import type { Day } from "~/time/calendar";

import type { LeaveSpan } from "./days";

// How the pages put leave into words. Nothing here runs only on the server.

/** A day with its year: "14 December 2026". */
function dateWords(day: Day): string {
	return new Intl.DateTimeFormat("en-GB", {
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${day}T00:00:00Z`));
}

/**
 * A request's days: "14 December 2026, half day", "14 to 18 December 2026",
 * "14 to 18 December 2026, half days at the start and the end".
 */
export function spanLabel(span: LeaveSpan): string {
	if (span.startsOn === span.endsOn) {
		return `${dateWords(span.startsOn)}${span.startsHalf ? ", half day" : ""}`;
	}
	const days = periodLabel({ startsOn: span.startsOn, endsOn: span.endsOn });
	if (span.startsHalf && span.endsHalf) return `${days}, half days at the start and the end`;
	if (span.startsHalf) return `${days}, half day at the start`;
	if (span.endsHalf) return `${days}, half day at the end`;
	return days;
}

/** Minutes as hours and minutes, as the Timesheet writes a duration: 450 is "7:30". */
export function minutesLabel(minutes: number): string {
	const whole = Math.round(minutes);
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
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
		return `${WEEKDAY_NAMES[first.index]} to ${WEEKDAY_NAMES[last.index]}, ${minutesLabel(first.minutes)} a day`;
	}
	return worked.map((d) => `${WEEKDAY_NAMES[d.index]} ${minutesLabel(d.minutes)}`).join(", ");
}

/** A day briefly: "Mon 9". */
export function shortDay(day: Day): string {
	return new Intl.DateTimeFormat("en-GB", {
		weekday: "short",
		day: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${day}T00:00:00Z`));
}
