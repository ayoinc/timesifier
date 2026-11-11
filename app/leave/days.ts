import { type Day, daysFrom, isoWeekday } from "~/time/calendar";

import type { KindKey, LeaveStatus } from "./kinds";

/**
 * Working days, leave and expected time (TS-061), worked out from the data on
 * every request and never stored. Nothing here reads the database or a clock:
 * the server gathers a `LeaveCalendar` and these rules read it, the same in
 * the Worker and the browser.
 *
 * A day is a local date, `YYYY-MM-DD`, in the zone of the person it is for
 * (decision 26). A working week, a public holiday and a request are all dates,
 * so a clock change moves none of them: a day expected to hold 7.5 hours holds
 * 7.5 hours whether the day has 23, 24 or 25.
 *
 * Leave is counted in half days, whole numbers, so that no sum drifts.
 */

/** Minutes expected on each day of the week, Monday first: seven numbers, 0 for a day not worked. */
export type WorkingWeek = readonly number[];

/** Monday to Friday, 7.5 hours a day: what an organisation starts with. */
export const DEFAULT_WORKING_WEEK: WorkingWeek = [450, 450, 450, 450, 450, 0, 0];

/** The days of a request, both included, and which ends are half days. */
export interface LeaveSpan {
	startsOn: Day;
	endsOn: Day;
	/** The first day is a half day; on a request of one day, that day is. */
	startsHalf: boolean;
	/** The last day is a half day. Never set on a request of one day. */
	endsHalf: boolean;
}

/** A request as the rules read it. */
export interface LeaveRequestLike extends LeaveSpan {
	userId: string;
	kindKey: KindKey;
	/** The kind's name in the organisation. */
	kindName: string;
	status: LeaveStatus;
}

/** What decides a person's working days: the organisation's week, its public holidays, and their approved leave. */
export interface LeaveCalendar {
	week: WorkingWeek;
	/** Public holidays by day, with their names. Empty while the organisation has public holidays switched off. */
	holidays: ReadonlyMap<Day, string>;
	/** The person's approved requests. Others are ignored. */
	leave: readonly LeaveRequestLike[];
}

/** The minutes the week expects on `day`, before holidays and leave. */
export function weekMinutes(week: WorkingWeek, day: Day): number {
	return week[isoWeekday(day) - 1] ?? 0;
}

/** The minutes expected on `day` before leave: none on a public holiday or a day not worked. */
export function workingMinutes(
	calendar: Pick<LeaveCalendar, "week" | "holidays">,
	day: Day,
): number {
	return calendar.holidays.has(day) ? 0 : weekMinutes(calendar.week, day);
}

/** Whether `day` is a working day: worked in the week, and no public holiday. */
export function isWorkingDay(
	calendar: Pick<LeaveCalendar, "week" | "holidays">,
	day: Day,
): boolean {
	return workingMinutes(calendar, day) > 0;
}

/**
 * How many half days of `day` the span covers, working day or not: 0, 1 or 2.
 * The first day is a half when `startsHalf` is set, the last when `endsHalf` is.
 */
export function halvesCovered(span: LeaveSpan, day: Day): 0 | 1 | 2 {
	if (day < span.startsOn || day > span.endsOn) return 0;
	if (day === span.startsOn && span.startsHalf) return 1;
	if (day === span.endsOn && span.endsHalf) return 1;
	return 2;
}

/** The half days of working days a span takes, day by day: a day not worked and a public holiday take none. */
export function halfDaysByDay(
	span: LeaveSpan,
	calendar: Pick<LeaveCalendar, "week" | "holidays">,
): Map<Day, number> {
	const taken = new Map<Day, number>();
	for (const day of daysFrom(span.startsOn, span.endsOn)) {
		const halves = isWorkingDay(calendar, day) ? halvesCovered(span, day) : 0;
		if (halves > 0) taken.set(day, halves);
	}
	return taken;
}

/** The half days of working days a span takes in all. */
export function halfDaysTaken(
	span: LeaveSpan,
	calendar: Pick<LeaveCalendar, "week" | "holidays">,
): number {
	let sum = 0;
	for (const halves of halfDaysByDay(span, calendar).values()) sum += halves;
	return sum;
}

/** The half days a span takes in each calendar year it touches: the leave year is the calendar year. */
export function halfDaysByYear(
	span: LeaveSpan,
	calendar: Pick<LeaveCalendar, "week" | "holidays">,
): Map<number, number> {
	const years = new Map<number, number>();
	for (const [day, halves] of halfDaysByDay(span, calendar)) {
		const year = Number(day.slice(0, 4));
		years.set(year, (years.get(year) ?? 0) + halves);
	}
	return years;
}

/** Whether two spans share a day. */
export function overlaps(
	a: Pick<LeaveSpan, "startsOn" | "endsOn">,
	b: Pick<LeaveSpan, "startsOn" | "endsOn">,
): boolean {
	return a.startsOn <= b.endsOn && b.startsOn <= a.endsOn;
}

/** What one day is for one person. */
export type DayKind =
	| { kind: "holiday"; name: string }
	| { kind: "not-a-working-day" }
	| { kind: "leave"; halves: 1 | 2; request: LeaveRequestLike }
	| { kind: "working" };

/** One day of a person: what it is, and the minutes they are expected to work on it. */
export interface DayStatus {
	day: Day;
	is: DayKind;
	expectedMinutes: number;
}

/**
 * What `day` is for the person whose calendar this is. A public holiday comes
 * first, then a day the week does not work, then approved leave, which halves
 * the day's minutes for a half day and takes them all for a whole one.
 */
export function dayStatus(calendar: LeaveCalendar, day: Day): DayStatus {
	const holiday = calendar.holidays.get(day);
	if (holiday !== undefined)
		return { day, is: { kind: "holiday", name: holiday }, expectedMinutes: 0 };
	const minutes = weekMinutes(calendar.week, day);
	if (minutes === 0) return { day, is: { kind: "not-a-working-day" }, expectedMinutes: 0 };
	for (const request of calendar.leave) {
		if (request.status !== "approved") continue;
		const halves = halvesCovered(request, day);
		if (halves !== 0) {
			return {
				day,
				is: { kind: "leave", halves, request },
				expectedMinutes: halves === 2 ? 0 : minutes / 2,
			};
		}
	}
	return { day, is: { kind: "working" }, expectedMinutes: minutes };
}

/** Each of `days` for the person, in order. */
export function dayStatuses(calendar: LeaveCalendar, days: readonly Day[]): DayStatus[] {
	return days.map((day) => dayStatus(calendar, day));
}

/** The minutes the person is expected to work over `days`. */
export function expectedMinutes(calendar: LeaveCalendar, days: readonly Day[]): number {
	return days.reduce((sum, day) => sum + dayStatus(calendar, day).expectedMinutes, 0);
}

/** The half days of approved leave over `days`: what a report shows beside worked time, never in it. */
export function leaveHalfDays(calendar: LeaveCalendar, days: readonly Day[]): number {
	return days.reduce((sum, day) => {
		const { is } = dayStatus(calendar, day);
		return sum + (is.kind === "leave" ? is.halves : 0);
	}, 0);
}

/** The minutes of approved leave over `days`: the week's minutes of each day taken, halved for a half day. */
export function leaveMinutes(calendar: LeaveCalendar, days: readonly Day[]): number {
	return days.reduce((sum, day) => {
		const { is } = dayStatus(calendar, day);
		return sum + (is.kind === "leave" ? (weekMinutes(calendar.week, day) * is.halves) / 2 : 0);
	}, 0);
}

/** Whether nothing is expected of the person on any of `days`: each is leave, a holiday or not worked. */
export function nothingExpected(calendar: LeaveCalendar, days: readonly Day[]): boolean {
	return days.every((day) => dayStatus(calendar, day).expectedMinutes === 0);
}

/** A kind's balance for one leave year. All figures are half days. */
export interface Balance {
	year: number;
	/** The yearly allowance, or null for none. */
	allowance: number | null;
	/** Approved in the year. */
	approved: number;
	/** Waiting for a decision in the year. */
	pending: number;
	/** The allowance less approved and pending; null when there is no allowance. */
	left: number | null;
}

/**
 * The balance of one kind in `year` for one person: their allowance less the
 * approved and the pending half days that fall in the year. Nothing carries
 * over from one year to the next.
 */
export function balance(
	allowance: number | null,
	requests: readonly (LeaveSpan & { status: LeaveStatus })[],
	year: number,
	calendar: Pick<LeaveCalendar, "week" | "holidays">,
): Balance {
	let approved = 0;
	let pending = 0;
	for (const request of requests) {
		if (request.status !== "approved" && request.status !== "pending") continue;
		const halves = halfDaysByYear(request, calendar).get(year) ?? 0;
		if (request.status === "approved") approved += halves;
		else pending += halves;
	}
	return {
		year,
		allowance,
		approved,
		pending,
		left: allowance === null ? null : allowance - approved - pending,
	};
}

/** Where a person is now, as Team, Approvals and Time off show it. */
export type PersonStatus =
	| { kind: "working" }
	| { kind: "on-leave"; halves: 1 | 2; kindName: string | null }
	| { kind: "holiday"; name: string }
	| { kind: "not-a-working-day" }
	| { kind: "available" };

/**
 * Where a person stands on `today`, their own local day: working while their
 * timer runs, whatever the day; else on leave, on a public holiday, on a day
 * the week does not work, or available. The kind of leave is given only when
 * `kindVisible`: a colleague sees "On leave", their manager and an owner or
 * admin see which leave.
 */
export function personStatus(
	calendar: LeaveCalendar,
	today: Day,
	{ running, kindVisible }: { running: boolean; kindVisible: boolean },
): PersonStatus {
	if (running) return { kind: "working" };
	const { is } = dayStatus(calendar, today);
	switch (is.kind) {
		case "leave":
			return {
				kind: "on-leave",
				halves: is.halves,
				kindName: kindVisible ? is.request.kindName : null,
			};
		case "holiday":
			return { kind: "holiday", name: is.name };
		case "not-a-working-day":
			return { kind: "not-a-working-day" };
		case "working":
			return { kind: "available" };
	}
}

/** A person's status in words: "Working", "On leave", "On leave · Annual leave", "Not working today". */
export function personStatusLabel(status: PersonStatus): string {
	switch (status.kind) {
		case "working":
			return "Working";
		case "on-leave": {
			const what = status.halves === 1 ? "On leave for half the day" : "On leave";
			return status.kindName ? `${what} · ${status.kindName}` : what;
		}
		case "holiday":
			return `Not working today · ${status.name}`;
		case "not-a-working-day":
			return "Not working today";
		case "available":
			return "Available";
	}
}

/**
 * A day as the views name it: the leave's kind, the holiday's name, or "Not a
 * working day"; null for a working day. `kindVisible` false names leave only
 * as "On leave".
 */
export function dayLabel(status: DayStatus, kindVisible = true): string | null {
	const { is } = status;
	switch (is.kind) {
		case "leave": {
			const name = kindVisible ? is.request.kindName : "On leave";
			return is.halves === 1 ? `${name} (half day)` : name;
		}
		case "holiday":
			return is.name;
		case "not-a-working-day":
			return "Not a working day";
		case "working":
			return null;
	}
}
