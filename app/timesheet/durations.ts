import * as z from "zod";

/**
 * Lengths of time as the Timesheet shows and takes them. Every length is
 * whole milliseconds in the tables; the pages show hours and minutes, and a
 * running timer hours, minutes and seconds.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** `ms` as hours and minutes, `7:05`. Whole minutes: the seconds are dropped, never rounded up. */
export function formatDuration(ms: number): string {
	const minutes = Math.floor(Math.max(0, ms) / MINUTE);
	return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** `seconds` as hours, minutes and seconds, `1:02:03`: a running timer's elapsed time. */
export function formatElapsed(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	const h = Math.floor(whole / 3600);
	const m = Math.floor((whole % 3600) / 60);
	const s = whole % 60;
	return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** The most a cell of the week's grid takes: a day. */
export const MOST_HOURS_IN_A_CELL = 24;

/**
 * Hours as a person types them into a cell of the week's grid (TS-052): `1.5`,
 * `1,5`, `1:30` or `2`. Empty is no hours, which removes the cell's time. The
 * result is whole minutes, at most a day.
 */
export const TypedHours = z
	.string()
	.trim()
	.transform((text, context) => {
		if (text === "") return 0;
		const clock = /^(\d{1,2}):([0-5]\d)$/.exec(text);
		const decimal = /^(\d{1,2})(?:[.,](\d{1,2}))?$/.exec(text);
		let minutes: number | null = null;
		if (clock) minutes = Number(clock[1]) * 60 + Number(clock[2]);
		else if (decimal) minutes = Math.round(Number(`${decimal[1]}.${decimal[2] ?? "0"}`) * 60);
		if (minutes === null || minutes > MOST_HOURS_IN_A_CELL * 60) {
			context.addIssue({ code: "custom", message: "Type hours as 1.5 or 1:30, at most 24." });
			return z.NEVER;
		}
		return minutes;
	});

/** A cell's time as the grid shows it in its field: `1:30`, or nothing for none. */
export function cellText(ms: number): string {
	return ms > 0 ? formatDuration(ms) : "";
}

/** Minutes as milliseconds. */
export function minutesToMs(minutes: number): number {
	return minutes * MINUTE;
}

export { HOUR, MINUTE };
