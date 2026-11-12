import { type Day, dayOf } from "./calendar";

/**
 * How every page writes a day, a period, a time and a length of time: one form
 * for each (docs/design-system.md, "Dates and times").
 *
 * The text depends on nothing about where it runs. The locale is fixed, every
 * instant is read in a zone the caller names, and a `Day`, a date with no time,
 * is read as UTC reads its midnight. Nor does it depend on the engine's own
 * patterns: V8 writes `{ weekday: "short", day: "numeric" }` as "9 Mon" and
 * JavaScriptCore as "Mon 9", which once made the server's text and Safari's
 * differ (audit W06). So Intl is asked only for the names and numbers, through
 * `formatToParts`, and this module puts them in their order itself.
 */

/** The locale the names of days and months are taken from. */
export const LOCALE = "en-GB";

type Parts = Partial<Record<Intl.DateTimeFormatPartTypes, string>>;

/** The named parts of `instant` as `format` writes them; the literals between them dropped. */
function partsOf(format: Intl.DateTimeFormat, instant: number): Parts {
	const parts: Parts = {};
	for (const { type, value } of format.formatToParts(instant)) {
		if (type !== "literal") parts[type] = value;
	}
	return parts;
}

// Made on first use, not when the module loads: making one is the slow part,
// and most pages need one or two of them.
let longDay: Intl.DateTimeFormat | undefined;
let shortWeekday: Intl.DateTimeFormat | undefined;
const clocks = new Map<string, Intl.DateTimeFormat>();

/** The weekday, day, month and year of `day`, by name where they have one. */
function dayParts(day: Day): { weekday: string; day: string; month: string; year: string } {
	longDay ??= new Intl.DateTimeFormat(LOCALE, {
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});
	const parts = partsOf(longDay, midnightOf(day));
	return {
		weekday: parts.weekday ?? "",
		day: parts.day ?? String(Number(day.slice(8, 10))),
		month: parts.month ?? "",
		year: parts.year ?? day.slice(0, 4),
	};
}

/** Midnight UTC of `day`: the instant a day is read from. */
function midnightOf(day: Day): number {
	return Date.parse(`${day}T00:00:00Z`);
}

/** A day in full, "Wednesday 11 November", or briefly, where a week's seven share a row, "Wed 11". */
export function formatDay(day: Day, style: "long" | "short" = "long"): string {
	if (style === "short") {
		shortWeekday ??= new Intl.DateTimeFormat(LOCALE, { weekday: "short", timeZone: "UTC" });
		const { weekday = "" } = partsOf(shortWeekday, midnightOf(day));
		return `${weekday} ${Number(day.slice(8, 10))}`;
	}
	const parts = dayParts(day);
	return `${parts.weekday} ${parts.day} ${parts.month}`;
}

/** A day in full with its year, for a day that may be in another year: "Wednesday 11 November 2026". */
export function formatDayWithYear(day: Day): string {
	const parts = dayParts(day);
	return `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}`;
}

/**
 * The days from `first` to `last`, naming each month and year once: "9–15
 * November 2026", "30 November – 6 December 2026", "28 December 2026 – 3
 * January 2027", and a single day as "11 November 2026". Between two numbers the
 * dash is closed up; between two dates with words in them it is spaced.
 */
export function formatRange(first: Day, last: Day): string {
	const from = dayParts(first);
	const to = dayParts(last);
	const end = `${to.day} ${to.month} ${to.year}`;
	if (first === last) return end;
	if (from.year !== to.year) return `${from.day} ${from.month} ${from.year} – ${end}`;
	if (from.month !== to.month) return `${from.day} ${from.month} – ${end}`;
	return `${from.day}–${end}`;
}

/** The month `day` is in, with its year: "November 2026". */
export function formatMonth(day: Day): string {
	const parts = dayParts(day);
	return `${parts.month} ${parts.year}`;
}

const weekdays = new Map<string, Intl.DateTimeFormat>();

/** The name of `day`'s weekday: "W", "Wed" or "Wednesday", for the heads of a calendar's columns. */
export function formatWeekday(day: Day, style: "narrow" | "short" | "long"): string {
	let format = weekdays.get(style);
	if (!format) {
		format = new Intl.DateTimeFormat(LOCALE, { weekday: style, timeZone: "UTC" });
		weekdays.set(style, format);
	}
	return partsOf(format, midnightOf(day)).weekday ?? "";
}

/** A day of a month without its weekday or year: "11 November". */
export function formatDayOfMonth(day: Day): string {
	const parts = dayParts(day);
	return `${parts.day} ${parts.month}`;
}

/** The time of day at `instant` on the clock in `zone`, 24-hour: "09:30", and midnight "00:00". */
export function formatTime(instant: number, zone: string): string {
	let clock = clocks.get(zone);
	if (!clock) {
		clock = new Intl.DateTimeFormat(LOCALE, {
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
			timeZone: zone,
		});
		clocks.set(zone, clock);
	}
	const { hour = "00", minute = "00" } = partsOf(clock, instant);
	// `h23` counts 00 to 23; an engine that still says 24 at midnight is read as 00.
	return `${hour === "24" ? "00" : hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

/** From a start to an end on the clock in `zone`: "21:33–02:33"; still running, "21:33–now". */
export function formatTimeRange(start: number, end: number | null, zone: string): string {
	return `${formatTime(start, zone)}–${end === null ? "now" : formatTime(end, zone)}`;
}

/**
 * A moment, as a record of when something was done: the day and the time on the
 * clock in `zone`, "Wednesday 11 November at 09:30".
 */
export function formatDayAndTime(instant: number, zone: string): string {
	return `${formatDay(dayOf(instant, zone))} at ${formatTime(instant, zone)}`;
}

/** A length of time as hours and whole minutes, the seconds dropped: 18000 is "5:00", 420 is "0:07". */
export function formatDuration(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}
