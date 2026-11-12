import { weekdayName } from "~/workspace/general";

import type { Deadline } from "./deadline";

/** A day of the month as a deadline names it: 31 is the month's last day. */
export function monthDayLabel(day: number): string {
	if (day === 31) return "the last day";
	const tens = Math.floor(day / 10) % 10;
	const units = day % 10;
	const suffix =
		tens === 1 ? "th" : units === 1 ? "st" : units === 2 ? "nd" : units === 3 ? "rd" : "th";
	return `the ${day}${suffix}`;
}

/** The deadline in a few words, as settings and the activity log say it. */
export function deadlineLabel(deadline: Deadline): string {
	switch (deadline.kind) {
		case "none":
			return "None";
		case "weekly":
			return `Weekly, ${weekdayName(deadline.weekday)} at ${deadline.time}`;
		case "monthly":
			return `Monthly, on ${monthDayLabel(deadline.day)} at ${deadline.time}`;
	}
}

/** Auto-lock in a few words. */
export function autoLockLabel(days: number | null): string {
	if (days === null) return "Off";
	if (days === 0) return "At each deadline";
	return `${days} ${days === 1 ? "day" : "days"} after each deadline`;
}
