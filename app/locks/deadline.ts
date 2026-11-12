import * as z from "zod";

import { addDays, type Day, dayOf, instantAt, isoWeekday } from "~/time/calendar";

/**
 * The timesheet deadline and auto-lock (TS-065, research B22). An
 * organisation has no deadline, a weekly one (a weekday and a time) or a
 * monthly one (a day of the month and a time), in its own time zone. A
 * monthly deadline on a day the month does not have, the 31st of April or
 * the 30th of February, falls on the month's last day; 31 is "the last day of
 * the month".
 *
 * With auto-lock on, `autoLockDays` days after each deadline the lock date
 * moves forward to the deadline's day. It never moves backward, and each
 * deadline moves it once: when an owner or admin has moved it back since,
 * the same deadline does not move it again (`autoLockedThrough`).
 *
 * Nothing here reads the database or the clock.
 */

export const DeadlineKind = z.enum(["none", "weekly", "monthly"]);
export type DeadlineKind = z.infer<typeof DeadlineKind>;

/** The most days auto-lock may wait after a deadline. */
export const LONGEST_AUTO_LOCK_DAYS = 60;

/** A time of day as a form sends it, `HH:MM`, 24-hour. */
export const DeadlineTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Type a time as 17:00.");

export type Deadline =
	| { kind: "none" }
	| { kind: "weekly"; weekday: number; time: string }
	| { kind: "monthly"; day: number; time: string };

/** The deadline an organisation's columns hold, or none when they do not make one. */
export function deadlineOf(row: {
	deadlineKind: string;
	deadlineDay: number | null;
	deadlineTime: string | null;
}): Deadline {
	const { deadlineKind, deadlineDay, deadlineTime } = row;
	if (deadlineDay === null || deadlineTime === null) return { kind: "none" };
	if (deadlineKind === "weekly" && deadlineDay >= 1 && deadlineDay <= 7) {
		return { kind: "weekly", weekday: deadlineDay, time: deadlineTime };
	}
	if (deadlineKind === "monthly" && deadlineDay >= 1 && deadlineDay <= 31) {
		return { kind: "monthly", day: deadlineDay, time: deadlineTime };
	}
	return { kind: "none" };
}

const minutesOf = (time: string) => {
	const [hours, minutes] = time.split(":").map(Number) as [number, number];
	return hours * 60 + minutes;
};

/** The last day of the month `day` is in. */
function lastOfMonth(day: Day): Day {
	const next = addDays(`${day.slice(0, 8)}28`, 4);
	return addDays(`${next.slice(0, 8)}01`, -1);
}

/** Whether a deadline falls on `day`. */
export function isDeadlineDay(deadline: Deadline, day: Day): boolean {
	switch (deadline.kind) {
		case "none":
			return false;
		case "weekly":
			return isoWeekday(day) === deadline.weekday;
		case "monthly": {
			const last = lastOfMonth(day);
			return Number(day.slice(8)) === Math.min(deadline.day, Number(last.slice(8)));
		}
	}
}

/** The most days between two deadlines, and so the furthest back the latest one can be. */
const LONGEST_GAP_DAYS = 31;

/**
 * The day of the latest deadline that has passed `waitDays` days ago at `now`,
 * in `zone`: the latest deadline day D whose time, `waitDays` days after D,
 * is at or before `now`. Null for no deadline.
 */
export function latestDeadlinePassed(
	deadline: Deadline,
	zone: string,
	now: number,
	waitDays = 0,
): Day | null {
	if (deadline.kind === "none") return null;
	const minutes = minutesOf(deadline.time);
	const today = dayOf(now, zone);
	for (let back = 0; back <= waitDays + LONGEST_GAP_DAYS + 1; back++) {
		const day = addDays(today, -back);
		if (!isDeadlineDay(deadline, day)) continue;
		if (instantAt(addDays(day, waitDays), minutes, zone) <= now) return day;
	}
	return null;
}

/** The next deadline at or after `now`, as its day, for the settings page to say when it falls. */
export function nextDeadline(deadline: Deadline, zone: string, now: number): Day | null {
	if (deadline.kind === "none") return null;
	const minutes = minutesOf(deadline.time);
	const today = dayOf(now, zone);
	for (let ahead = 0; ahead <= LONGEST_GAP_DAYS + 1; ahead++) {
		const day = addDays(today, ahead);
		if (isDeadlineDay(deadline, day) && instantAt(day, minutes, zone) >= now) return day;
	}
	return null;
}

/** What an organisation's lock holds for auto-lock to read. */
export interface AutoLockState {
	deadline: Deadline;
	/** Days after each deadline; null when auto-lock is off. */
	autoLockDays: number | null;
	lockedThrough: Day | null;
	autoLockedThrough: Day | null;
}

/**
 * What auto-lock does at `now`: nothing (null), or the deadline it acts on
 * and the lock date that results. The lock date moves only forward; a
 * deadline already acted on is not acted on again, so a lock date an owner or
 * admin moved back stays back until the next deadline.
 */
export function autoLock(
	state: AutoLockState,
	zone: string,
	now: number,
): { deadline: Day; lockedThrough: Day } | null {
	if (state.autoLockDays === null) return null;
	const deadline = latestDeadlinePassed(state.deadline, zone, now, state.autoLockDays);
	if (deadline === null) return null;
	if (state.autoLockedThrough !== null && deadline <= state.autoLockedThrough) return null;
	const lockedThrough =
		state.lockedThrough !== null && state.lockedThrough >= deadline
			? state.lockedThrough
			: deadline;
	return { deadline, lockedThrough };
}
