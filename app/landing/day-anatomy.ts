import { type Entry, type PROJECTS, week, weekTotal } from "./example-week";
import type { RunningDay } from "./running-day";

// The anatomy of a working day, as a bench instrument (DayAnatomy.tsx draws it).
//
// The timer feeds time out as a strip, and a strip's length is its time. On the
// first rail the day lies as it went: distance from the timer is time ago, so
// the stretch still running is at the slot, each finished stretch lies where it
// happened, and a break is bare rail. On the second rail the same strips are
// closed up end to end, and a rider at the far end stands at the day's total:
// the breaks have dropped out and nothing recorded has. In the week each project
// has a lane, each day's strips join the lane of their project, and a feeler
// reaches back from the totaliser to the end of each lane: what it shows is the
// four lengths added.
//
// Nothing here is drawn to look right. Every length is minutes from the same
// example the tables on the page are added up from; test/day-anatomy.test.ts
// holds it so. The two rails of the day share one scale and the lanes of the
// week another, because a day beside a week at one scale would be a sliver.

/** The length of an hour on the two rails of the day, in the figure's world units. */
export const DAY_HOUR = 90;
/** The length of an hour in the lanes of the week. */
export const WEEK_HOUR = 40;

/** How much time each rail has room for. What is longer stops at the rail's end. */
export const WENT_RAIL_HOURS = 3;
export const ADDED_RAIL_HOURS = 2.5;
export const WEEK_RAIL_HOURS = 16;

export interface Strip {
	/** Where it starts and ends along its rail, from the rail's zero. */
	from: number;
	to: number;
}

export interface DayRails {
	/** The day as it went. The newest is nearest the timer. */
	went: {
		/** The stretch still feeding out of the timer. */
		running: Strip;
		/** The finished stretches, newest first: always one for each entry, of no length once off the rail's end. */
		entries: readonly Strip[];
		/** The bare rail before each finished stretch, newest first: the break that followed it. */
		breaks: readonly Strip[];
	};
	/** The same strips closed up. */
	added: {
		running: Strip;
		entries: readonly Strip[];
		/** Where the rider stands: the length of everything recorded. */
		total: number;
	};
}

const onDay = (minutes: number) => (minutes / 60) * DAY_HOUR;

/** A day on its two rails. */
export function dayRails(day: Pick<RunningDay, "logged" | "elapsed" | "since">): DayRails {
	const running = day.elapsed / 60;
	const newestFirst: readonly Entry[] = [...day.logged].reverse();

	const wentEnd = WENT_RAIL_HOURS * DAY_HOUR;
	/** How far from the timer a time of day lies: as long ago as it was. */
	const ago = (time: number) => Math.min(wentEnd, onDay(running + (day.since - time)));
	const went = newestFirst.map((entry) => ({ from: ago(entry.end), to: ago(entry.start) }));
	const wentRunning = { from: 0, to: Math.min(wentEnd, onDay(running)) };
	const breaks = went.map((strip, index) => ({
		from: (went[index - 1] ?? wentRunning).to,
		to: strip.from,
	}));

	const addedEnd = ADDED_RAIL_HOURS * DAY_HOUR;
	const addedRunning = { from: 0, to: Math.min(addedEnd, onDay(running)) };
	const added: Strip[] = [];
	let reached = addedRunning.to;
	for (const entry of newestFirst) {
		const to = Math.min(addedEnd, reached + onDay(entry.end - entry.start));
		added.push({ from: reached, to });
		reached = to;
	}

	return {
		went: { running: wentRunning, entries: went, breaks },
		added: { running: addedRunning, entries: added, total: reached },
	};
}

const onWeek = (minutes: number) => (minutes / 60) * WEEK_HOUR;

export interface Lane {
	project: (typeof PROJECTS)[number];
	/** A strip for each day that has time on the project, Monday first. `day` is the day's place in the week. */
	strips: readonly (Strip & { day: number })[];
	/** Where the lane's strips end, and the feeler touches. */
	total: number;
}

/** The example week in its lanes, one for each project in the order the report lists them. */
export const WEEK_LANES: readonly Lane[] = week.map((row) => {
	const strips: (Strip & { day: number })[] = [];
	let reached = 0;
	for (const [day, minutes] of row.days.entries()) {
		if (minutes === 0) continue;
		strips.push({ day, from: reached, to: reached + onWeek(minutes) });
		reached += onWeek(minutes);
	}
	return { project: row.project, strips, total: reached };
});

/** The length the totaliser has added up: every lane's, end to end. */
export const WEEK_LENGTH = onWeek(weekTotal);
