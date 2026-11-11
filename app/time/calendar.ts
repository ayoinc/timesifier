import * as z from "zod";

/**
 * Days and instants in a time zone (docs/decisions.md entry 26).
 *
 * An instant is milliseconds since the Unix epoch, in UTC, as every table
 * stores it. A day is a local date, `YYYY-MM-DD`, in the zone of the person it
 * is for. Nothing about a day is stored: the Worker works out a day's bounds in
 * a zone and passes them to SQL as instants. An entry belongs whole to the
 * local day it starts in.
 *
 * Only `Intl` is used, so the same arithmetic runs in the Worker and in the
 * browser, and a day with a clock change has the 23 or 25 hours it has.
 */

/** A local date, `YYYY-MM-DD`. */
export type Day = string;

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** A local date as a form or an address carries it: `YYYY-MM-DD`, and a date the calendar has. */
export const Day = z
	.string()
	.regex(DAY_PATTERN)
	.refine(
		(value) => DAY_PATTERN.test(value) && formatUtcDate(parseDay(value)) === value,
		"Not a date.",
	);

/** The day as the instant of its midnight in UTC: the arithmetic below works on that. */
function parseDay(day: Day): number {
	const match = DAY_PATTERN.exec(day);
	if (!match) throw new Error(`${day} is not a date written YYYY-MM-DD.`);
	const [, year, month, date] = match;
	return Date.UTC(Number(year), Number(month) - 1, Number(date));
}

function formatUtcDate(instant: number): Day {
	return new Date(instant).toISOString().slice(0, 10);
}

/** The day `count` days after `day`, or before it when `count` is negative. */
export function addDays(day: Day, count: number): Day {
	return formatUtcDate(parseDay(day) + count * MS_PER_DAY);
}

/** The day of the week as ISO counts it: 1 is Monday, 7 is Sunday. */
export function isoWeekday(day: Day): number {
	return new Date(parseDay(day)).getUTCDay() || 7;
}

/** Every day from `first` to `last`, both included. */
export function daysFrom(first: Day, last: Day): Day[] {
	const days: Day[] = [];
	for (let day = first; day <= last; day = addDays(day, 1)) days.push(day);
	return days;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** One formatter per zone: making one is the slow part. */
function formatterFor(zone: string): Intl.DateTimeFormat {
	let formatter = formatters.get(zone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-GB", {
			timeZone: zone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		formatters.set(zone, formatter);
	}
	return formatter;
}

/** The wall clock in `zone` at `instant`, read as if it were UTC: the instant plus the zone's offset. */
function wallClock(instant: number, zone: string): number {
	const parts: Record<string, number> = {};
	for (const { type, value } of formatterFor(zone).formatToParts(new Date(instant))) {
		if (type !== "literal") parts[type] = Number(value);
	}
	return Date.UTC(
		parts.year ?? 0,
		(parts.month ?? 1) - 1,
		parts.day ?? 1,
		parts.hour ?? 0,
		parts.minute ?? 0,
		parts.second ?? 0,
	);
}

/** The zone's offset from UTC at `instant`, in milliseconds. */
function offsetAt(instant: number, zone: string): number {
	// Seconds are dropped from the instant as the wall clock drops its milliseconds.
	return wallClock(instant, zone) - (instant - (((instant % 1000) + 1000) % 1000));
}

/** The local date in `zone` at `instant`. */
export function dayOf(instant: number | Date, zone: string): Day {
	return formatUtcDate(wallClock(Number(instant), zone));
}

/**
 * How many minutes after midnight on `day` the wall clock in `zone` reads at
 * `instant`: 0 to 1440 for an instant on that day, whatever its clock changes
 * do to the length of the day. On the day the clocks go back an instant in
 * the hour they pass twice reads the same as one an hour before it.
 */
export function wallMinutes(instant: number, day: Day, zone: string): number {
	return (wallClock(instant, zone) - parseDay(day)) / 60_000;
}

/**
 * The instant at which the wall clock in `zone` reads `minutes` after midnight
 * on `day`. A time the clock skips, in the hour a clock change jumps over, is
 * read as that many minutes after the change; a time the clock passes twice is
 * the first of the two.
 */
export function instantAt(day: Day, minutes: number, zone: string): number {
	const wall = parseDay(day) + minutes * 60_000;
	// The zone's offsets a day either side: at most one clock change lies
	// between them, so the instant is the wall time less one of the two.
	const offsets = [offsetAt(wall - MS_PER_DAY, zone), offsetAt(wall + MS_PER_DAY, zone)];
	const readable = offsets
		.map((offset) => wall - offset)
		.filter((t) => wallClock(t, zone) === wall);
	// Passed twice: the first. Skipped: as many minutes after the change, which
	// is the wall time less the smaller offset.
	return readable.length > 0 ? Math.min(...readable) : wall - Math.min(...offsets);
}

/**
 * The same instant for a time a person typed: null when the wall clock in
 * `zone` never reads `minutes` after midnight on `day`, because a clock change
 * skips it (TS-012b). A time the clock passes twice is the first of the two.
 */
export function exactInstantAt(day: Day, minutes: number, zone: string): number | null {
	const instant = instantAt(day, minutes, zone);
	return wallClock(instant, zone) === parseDay(day) + minutes * 60_000 ? instant : null;
}

/**
 * The first instant of `day` in `zone`: the earliest instant whose local date
 * is `day`. It is found by search rather than by reading midnight, because in
 * some zones a clock change skips midnight itself.
 */
export function startOfDay(day: Day, zone: string): number {
	// Every zone is within 14 hours of UTC, and its day starts within a day of
	// UTC midnight; the search narrows to the millisecond.
	let low = parseDay(day) - MS_PER_DAY;
	let high = parseDay(day) + MS_PER_DAY;
	while (high - low > 1) {
		const middle = Math.floor((low + high) / 2);
		if (dayOf(middle, zone) >= day) high = middle;
		else low = middle;
	}
	return high;
}

/** The instants of a run of days in `zone`, from the start of `first` up to, not including, the start of the day after `last`. */
export function bounds(first: Day, last: Day, zone: string): { from: number; to: number } {
	return { from: startOfDay(first, zone), to: startOfDay(addDays(last, 1), zone) };
}
