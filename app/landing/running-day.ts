import { DAYS, type Entry, LOGGED_ENTRIES, length, RUNNING, TODAY } from "./example-week";

// The day the home page shows, with its timer running. Before script takes the
// page over, and without script, it is the still example: Wednesday 11 November,
// running since 10:45. Afterwards it is the visitor's own today: the timer
// started a believable while ago by their clock and counts their seconds.
// Everything here is arithmetic on a time; the component that keeps the time is
// RunningDay.tsx. test/running-day.test.ts holds the arithmetic in place.

export interface RunningDay {
	/** "Wednesday" */
	weekday: string;
	/** "Wednesday 11 November" */
	date: string;
	/** When the running entry started, in minutes after midnight. */
	since: number;
	/** The entries finished before it, in the order they were worked: always as many as the example has. */
	logged: readonly Entry[];
	/** How long the running entry has run, in seconds. */
	elapsed: number;
	/** The day so far, in seconds: what is logged and what is running, added together. */
	total: number;
}

export interface Clock {
	/** When the running entry started, in milliseconds since the epoch, moved on by any time it stood stopped. */
	startedAt: number;
	/** When the timer was stopped, while it is. */
	pausedAt: number | null;
	/** When it was last started again after a stop. */
	resumedAt: number | null;
	/**
	 * The day as it was laid out when the page opened: its date, when the timer
	 * first started, and the entries finished before that.
	 */
	placed: Pick<RunningDay, "weekday" | "date" | "since" | "logged">;
}

const exampleDay = DAYS[TODAY];
const EXAMPLE = {
	weekday: exampleDay.name,
	date: `${exampleDay.name} ${exampleDay.date} November`,
	since: RUNNING.entry.start,
	logged: LOGGED_ENTRIES,
};

const secondsOf = (entries: readonly Entry[]) =>
	entries.reduce((total, entry) => total + length(entry), 0) * 60;

export const EXAMPLE_DAY: RunningDay = {
	...EXAMPLE,
	elapsed: RUNNING.elapsedSeconds,
	total: secondsOf(LOGGED_ENTRIES) + RUNNING.elapsedSeconds,
};

function midnightBefore(time: number): number {
	const day = new Date(time);
	day.setHours(0, 0, 0, 0);
	return day.getTime();
}

/** The time of day at `time`, in minutes after midnight. */
export function timeOfDay(time: number): number {
	return Math.floor((time - midnightBefore(time)) / 60_000);
}

const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "long" });
const MONTH = new Intl.DateTimeFormat("en-GB", { month: "long" });

/** A working day is taken to begin at six, unless the page is opened before half past. */
const EARLY = { start: 6 * 60, from: 6 * 60 + 30 };

/** Entries are whole numbers of this many minutes when the day has to be made shorter. */
const STEP = 5;

/** From the first entry's start to the running entry's start in the example, in minutes. */
const HISTORY = RUNNING.entry.start - (LOGGED_ENTRIES[0] as Entry).start;

/**
 * Starts the clock for somebody who opened the page at `now`.
 *
 * Where their day is long enough, it is the example moved to their time: the
 * timer has run as long as it has in the example and started on a whole minute.
 * Earlier in the day the example is made shorter in proportion, so that nothing
 * on the sheet happened before the day began: the same entries in the same
 * order, each a shorter whole number of minutes. Too early for even that, and
 * the sheet stays the dated example; its timer still runs.
 */
export function begin(now: number): Clock {
	const minutesToday = (now - midnightBefore(now)) / 60_000;
	const dayStart = minutesToday >= EARLY.from ? EARLY.start : 0;
	const room = minutesToday - dayStart;
	const share = Math.min(1, room / (HISTORY + RUNNING.elapsedSeconds / 60));

	const elapsed = Math.max(60, Math.floor(RUNNING.elapsedSeconds * share));
	const startedAt = Math.floor((now - elapsed * 1000) / 60_000) * 60_000;

	// Laid out backwards from the timer's start, keeping the gaps between entries.
	const scaled = (minutes: number, least: number) =>
		share === 1 ? minutes : Math.max(least, Math.floor((minutes * share) / STEP) * STEP);
	let end = timeOfDay(startedAt);
	let before = RUNNING.entry.start;
	const logged: Entry[] = [];
	for (const entry of [...LOGGED_ENTRIES].reverse()) {
		end -= scaled(before - entry.end, 0);
		const start = end - scaled(length(entry), STEP);
		logged.unshift({ ...entry, start, end });
		end = start;
		before = entry.start;
	}

	const still: Clock = {
		startedAt: now - RUNNING.elapsedSeconds * 1000,
		pausedAt: null,
		resumedAt: null,
		placed: EXAMPLE,
	};
	if (end < dayStart || startedAt < midnightBefore(now)) return still;

	const today = new Date(now);
	const weekday = WEEKDAY.format(today);
	return {
		startedAt,
		pausedAt: null,
		resumedAt: null,
		placed: {
			weekday,
			date: `${weekday} ${today.getDate()} ${MONTH.format(today)}`,
			since: timeOfDay(startedAt),
			logged,
		},
	};
}

/** Stops a running clock, or starts a stopped one from where it stopped. */
export function toggled(clock: Clock, now: number): Clock {
	if (clock.pausedAt === null) return { ...clock, pausedAt: now };
	return {
		...clock,
		startedAt: clock.startedAt + (now - clock.pausedAt),
		pausedAt: null,
		resumedAt: now,
	};
}

/** The day as it stands at `now`. */
export function dayAt(clock: Clock, now: number): RunningDay {
	const elapsed = Math.floor(((clock.pausedAt ?? now) - clock.startedAt) / 1000);
	return { ...clock.placed, elapsed, total: secondsOf(clock.placed.logged) + elapsed };
}

// The week in its year: the largest scale the page shows. Weeks are counted as
// ISO 8601 counts them, the way a planner or a payroll does: a week runs Monday
// to Sunday and belongs to the year, and the month, its Thursday falls in.

export interface YearWeek {
	year: number;
	/** This week's number in the year, from 1. */
	week: number;
	/** How many weeks each month of the year has, January first: 4 or 5 each, 52 or 53 in all. */
	months: readonly number[];
}

const DAY = 86_400_000;

/** The Thursday of the week `date` is in, at noon, so that no change of the clocks moves it. */
function thursdayOf(date: Date): Date {
	const sinceMonday = (date.getDay() + 6) % 7;
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() - sinceMonday + 3, 12);
}

/** The week `time` falls in, by the visitor's own calendar. */
export function yearWeek(time: number): YearWeek {
	const thursday = thursdayOf(new Date(time));
	const year = thursday.getFullYear();
	// 4 January is always in the first week.
	const first = thursdayOf(new Date(year, 0, 4));
	const week = 1 + Math.round((thursday.getTime() - first.getTime()) / (7 * DAY));

	const months = Array.from({ length: 12 }, () => 0);
	for (
		let each = first;
		each.getFullYear() === year;
		each = new Date(each.getFullYear(), each.getMonth(), each.getDate() + 7, 12)
	) {
		months[each.getMonth()] = (months[each.getMonth()] ?? 0) + 1;
	}
	return { year, week, months };
}

/** The week of the still example: Wednesday 11 November 2026. */
export const EXAMPLE_WEEK = yearWeek(new Date(2026, 10, exampleDay.date, 12).getTime());

/** The week the clock's day is in. Where the sheet stays the dated example, so does its week. */
export function weekAt(clock: Clock, now: number): YearWeek {
	return clock.placed === EXAMPLE ? EXAMPLE_WEEK : yearWeek(now);
}
