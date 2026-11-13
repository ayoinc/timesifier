import { periodContaining } from "~/periods/periods";
import { addDays, type Day, daysFrom, startOfDay, wallMinutes } from "~/time/calendar";

import { type SheetEntry, weekSheet } from "./sheets";
import { type CalendarScale, calendarPath, dayPath, type Zoom } from "./views";

/**
 * What the calendar of Timesheet adds up and where it draws each entry
 * (TS-062). Like `sheets.ts`, nothing here reads the database or the clock.
 * The totals are `weekSheet`'s, so a day, a week and a month read the same as
 * in the Day and Week views: an entry belongs whole to the local day it starts
 * in. Where it is drawn is another matter: an entry that runs past midnight is
 * drawn on each day it covers, cut at midnight on the person's wall clock.
 */

/** Minutes in a day on the wall clock, which the hour axis shows whatever the clocks do. */
export const MINUTES_PER_DAY = 24 * 60;
/** The week calendar places entries to five minutes: a day is this many rows of its grid. */
export const ROW_MINUTES = 5;
export const ROWS_PER_DAY = MINUTES_PER_DAY / ROW_MINUTES;

/**
 * Something a day is besides the time on it: leave, a public holiday or a
 * day not worked, as leave names it (TS-061, `weekAway`), and whether nothing
 * is expected on it, which mutes it. The calendar shows it on the day.
 */
export interface DayStatus {
	label: string;
	quiet: boolean;
}

/** The first day of the month `day` is in. */
export function monthOf(day: Day): Day {
	return `${day.slice(0, 7)}-01`;
}

/** The first day of the month `step` months after the one starting on `month`, or before it when `step` is negative. */
export function monthAfter(month: Day, step: number): Day {
	const [year = 1970, number = 1] = month.split("-").map(Number);
	return new Date(Date.UTC(year, number - 1 + step, 1)).toISOString().slice(0, 10);
}

/** The days a calendar shows. */
export interface CalendarDays {
	/** The period that holds the day, or whole periods from the one that holds the month's first day to the one that holds its last. */
	days: Day[];
	/** The first day of the month shown, on the month's scale; null on the week's. */
	month: Day | null;
}

/** The days the calendar of `scale` shows around `date`, for an organisation whose weeks start on `weekStartsOn`. */
export function calendarDays(scale: CalendarScale, date: Day, weekStartsOn: number): CalendarDays {
	if (scale === "week") {
		const period = periodContaining(date, weekStartsOn);
		return { days: daysFrom(period.startsOn, period.endsOn), month: null };
	}
	const month = monthOf(date);
	const first = periodContaining(month, weekStartsOn).startsOn;
	const last = periodContaining(addDays(monthAfter(month, 1), -1), weekStartsOn).endsOn;
	return { days: daysFrom(first, last), month };
}

/** One day of the month calendar. */
export interface MonthDay {
	day: Day;
	/** The time of the entries that start on it: the Day view's total. */
	total: number;
	/** How much of that is overtime (TS-095). */
	overtime: number;
	/** Whether it is a day of the month shown; the days of the first and last weeks that are not are muted. */
	inMonth: boolean;
}

export interface MonthSheet {
	/** A row for each period, with its seven days and the period's total: the Week view's. */
	weeks: { days: MonthDay[]; total: number }[];
	/** The sum of the days of the month. */
	total: number;
	/** The most time on any day shown: what each day's bar is a share of. */
	busiest: number;
}

/**
 * The month calendar's figures. `days` are whole periods (`calendarDays`), so
 * each row is a period of the Week view and its total is that period's. The
 * month's total counts only the month's own days, so a week that crosses into
 * the next month is in both months' rows but in one month's total.
 */
export function monthSheet(
	entries: readonly SheetEntry[],
	days: readonly Day[],
	month: Day,
	now: number,
): MonthSheet {
	const prefix = month.slice(0, 7);
	const weeks: MonthSheet["weeks"] = [];
	for (let at = 0; at < days.length; at += 7) {
		const sheet = weekSheet(entries, days.slice(at, at + 7), now);
		weeks.push({
			days: sheet.days.map((each) => ({ ...each, inMonth: each.day.startsWith(prefix) })),
			total: sheet.total,
		});
	}
	const all = weeks.flatMap((week) => week.days);
	return {
		weeks,
		total: all.filter((each) => each.inMonth).reduce((sum, each) => sum + each.total, 0),
		busiest: Math.max(0, ...all.map((each) => each.total)),
	};
}

/** The part of an entry drawn on one day of the week calendar. */
export interface Segment {
	entry: SheetEntry;
	day: Day;
	/** Where the part starts and ends, in minutes after midnight on the day's wall clock: 0 to 1440. */
	from: number;
	to: number;
	/** The instants it covers: the entry cut at the day's start and end. */
	startsAt: number;
	endsAt: number;
	/** Whether the entry started on an earlier day, and this part is what ran past midnight. */
	continued: boolean;
	/** Whether the entry runs on past the end of this day. */
	goesOn: boolean;
}

/**
 * The parts of `entries` on each of `days` in `zone`: an entry is cut at each
 * midnight it runs through, and a running one runs to `now`. A day's start
 * and end are its first instants and the next day's (`startOfDay`), so a day
 * of 23 or 25 hours is cut where its clock says.
 */
export function daySegments(
	entries: readonly SheetEntry[],
	days: readonly Day[],
	zone: string,
	now: number,
): Map<Day, Segment[]> {
	const byDay = new Map<Day, Segment[]>();
	for (const day of days) {
		const dayStart = startOfDay(day, zone);
		const dayEnd = startOfDay(addDays(day, 1), zone);
		const parts: Segment[] = [];
		for (const entry of entries) {
			const start = entry.startedAt;
			const end = Math.max(start, entry.endedAt ?? now);
			const inDay =
				end === start ? dayStart <= start && start < dayEnd : start < dayEnd && end > dayStart;
			if (!inDay) continue;
			const startsAt = Math.max(start, dayStart);
			const endsAt = Math.min(end, dayEnd);
			// An instant of the day reads 0 to 1440 on its wall clock (`wallMinutes`).
			const from = start <= dayStart ? 0 : wallMinutes(startsAt, day, zone);
			const to = end >= dayEnd ? MINUTES_PER_DAY : wallMinutes(endsAt, day, zone);
			parts.push({
				entry,
				day,
				from,
				// The hour the clocks go back is passed twice: an entry that ends in the
				// second pass can read earlier than it started.
				to: Math.max(from, to),
				startsAt,
				endsAt,
				continued: start < dayStart,
				goesOn: end > dayEnd,
			});
		}
		byDay.set(
			day,
			parts.sort((a, b) => a.from - b.from || b.to - a.to),
		);
	}
	return byDay;
}

/** A part placed on the rows of its day and in a lane beside the parts it overlaps. */
export interface PlacedSegment extends Segment {
	/** The first row it covers, from 0, and the row after its last. */
	row: number;
	rowEnd: number;
	/** Its lane, from 0, among `lanes` lanes shared by the parts it overlaps. */
	lane: number;
	lanes: number;
}

/**
 * Places a day's parts on its rows of five minutes, each at least `leastRows`
 * tall so that it can be read and pressed, and side by side where they would
 * overlap as drawn: each part takes the first lane free at its start, and a
 * run of parts that overlap one another shares the number of lanes the run
 * needs.
 */
export function placeSegments(segments: readonly Segment[], leastRows: number): PlacedSegment[] {
	const sized = segments
		.map((segment) => {
			const rowEnd = Math.min(
				ROWS_PER_DAY,
				Math.max(
					Math.ceil(segment.to / ROW_MINUTES),
					Math.floor(segment.from / ROW_MINUTES) + leastRows,
				),
			);
			const row = Math.max(0, Math.min(Math.floor(segment.from / ROW_MINUTES), rowEnd - leastRows));
			return { ...segment, row, rowEnd, lane: 0, lanes: 1 };
		})
		.sort((a, b) => a.row - b.row || b.rowEnd - a.rowEnd);

	let run: PlacedSegment[] = [];
	let laneEnds: number[] = [];
	let runEnd = 0;
	const close = () => {
		for (const each of run) each.lanes = laneEnds.length;
		run = [];
		laneEnds = [];
	};
	for (const each of sized) {
		if (each.row >= runEnd) close();
		const free = laneEnds.findIndex((end) => end <= each.row);
		each.lane = free === -1 ? laneEnds.length : free;
		laneEnds[each.lane] = each.rowEnd;
		runEnd = Math.max(runEnd, each.rowEnd);
		run.push(each);
	}
	close();
	return sized;
}

/**
 * The starts, in minutes after midnight, of the slots of `slotMinutes` on a
 * day that no part drawn on it covers: where an empty stretch can be chosen
 * to track time from.
 */
export function freeSlots(placed: readonly PlacedSegment[], slotMinutes: number): number[] {
	const slotRows = slotMinutes / ROW_MINUTES;
	const free: number[] = [];
	for (let row = 0; row < ROWS_PER_DAY; row += slotRows) {
		const end = row + slotRows;
		if (!placed.some((each) => each.row < end && each.rowEnd > row)) free.push(row * ROW_MINUTES);
	}
	return free;
}

/** How the week calendar is drawn at each zoom: the rows a part takes at least, and the length of an empty slot. */
export const ZOOM_GEOMETRY: Record<Zoom, { leastRows: number; slotMinutes: number }> = {
	// An hour is 24px: a part is never shorter than an hour's row, which is as small as a target may be.
	compact: { leastRows: 60 / ROW_MINUTES, slotMinutes: 60 },
	// An hour is 96px: a quarter of an hour is 24px, a line of text.
	detailed: { leastRows: 15 / ROW_MINUTES, slotMinutes: 30 },
};

/** The levels of the zoom, from the farthest out: the month, the week whole, the week in detail, and the Day view. */
export const ZOOM_LEVELS = ["month", "compact", "detailed", "day"] as const;
export type ZoomLevel = (typeof ZOOM_LEVELS)[number];

export const ZOOM_LABELS: Record<ZoomLevel, string> = {
	month: "Month",
	compact: "Week",
	detailed: "Week in detail",
	day: "Day",
};

/** The zoom level of a calendar of `scale` at `zoom`. */
export function zoomLevel(scale: CalendarScale, zoom: Zoom): ZoomLevel {
	return scale === "month" ? "month" : zoom;
}

/** The address of `level` around `date`: a calendar, or the Day view of `date`. */
export function zoomPath(slug: string, level: ZoomLevel, date: Day): string {
	if (level === "day") return dayPath(slug, date);
	if (level === "month") return calendarPath(slug, { scale: "month", date });
	return calendarPath(slug, { scale: "week", date, zoom: level });
}

/** The level one step in or out from `level`, or null past either end: there is nothing out from the month. */
export function zoomStep(level: ZoomLevel, step: 1 | -1): ZoomLevel | null {
	return ZOOM_LEVELS[ZOOM_LEVELS.indexOf(level) + step] ?? null;
}
