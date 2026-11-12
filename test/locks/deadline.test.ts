import { describe, expect, it } from "vitest";

import {
	type AutoLockState,
	autoLock,
	deadlineOf,
	isDeadlineDay,
	latestDeadlinePassed,
} from "~/locks/deadline";

// The timesheet deadline and auto-lock (TS-065, B22), on a fake clock: the
// instants below stand for "now".

const LONDON = "Europe/London";
const weekly = { kind: "weekly", weekday: 5, time: "17:00" } as const; // Fridays at 17:00
const monthly = { kind: "monthly", day: 31, time: "18:00" } as const; // the last day at 18:00

describe("the deadline", () => {
	it("is read from the organisation's columns, and none when they do not make one", () => {
		expect(deadlineOf({ deadlineKind: "weekly", deadlineDay: 5, deadlineTime: "17:00" })).toEqual(
			weekly,
		);
		expect(deadlineOf({ deadlineKind: "monthly", deadlineDay: 15, deadlineTime: "09:00" })).toEqual(
			{
				kind: "monthly",
				day: 15,
				time: "09:00",
			},
		);
		expect(deadlineOf({ deadlineKind: "weekly", deadlineDay: 9, deadlineTime: "17:00" })).toEqual({
			kind: "none",
		});
		expect(deadlineOf({ deadlineKind: "none", deadlineDay: null, deadlineTime: null })).toEqual({
			kind: "none",
		});
	});

	it("falls on the weekday of a weekly one", () => {
		expect(isDeadlineDay(weekly, "2026-11-13")).toBe(true);
		expect(isDeadlineDay(weekly, "2026-11-12")).toBe(false);
	});

	it("falls on the month's last day for the 31st, the 30th or the 29th in a short month", () => {
		expect(isDeadlineDay(monthly, "2026-02-28")).toBe(true);
		expect(isDeadlineDay(monthly, "2028-02-29")).toBe(true);
		expect(isDeadlineDay(monthly, "2026-04-30")).toBe(true);
		expect(isDeadlineDay(monthly, "2026-04-29")).toBe(false);
		expect(isDeadlineDay({ kind: "monthly", day: 30, time: "09:00" }, "2026-02-28")).toBe(true);
		expect(isDeadlineDay({ kind: "monthly", day: 15, time: "09:00" }, "2026-02-15")).toBe(true);
	});

	it("has passed at its time in the organisation's zone, not before", () => {
		// Friday 13 November 2026, 16:59 and 17:00 in London (GMT).
		expect(latestDeadlinePassed(weekly, LONDON, Date.parse("2026-11-13T16:59:00Z"))).toBe(
			"2026-11-06",
		);
		expect(latestDeadlinePassed(weekly, LONDON, Date.parse("2026-11-13T17:00:00Z"))).toBe(
			"2026-11-13",
		);
		// In New York the same instant is 12:00, before the deadline.
		expect(
			latestDeadlinePassed(weekly, "America/New_York", Date.parse("2026-11-13T17:00:00Z")),
		).toBe("2026-11-06");
	});
});

describe("auto-lock", () => {
	const off: AutoLockState = {
		deadline: weekly,
		autoLockDays: null,
		lockedThrough: null,
		autoLockedThrough: null,
	};
	const on: AutoLockState = { ...off, autoLockDays: 2 };

	it("does nothing while it is off, or with no deadline", () => {
		expect(autoLock(off, LONDON, Date.parse("2026-11-20T12:00:00Z"))).toBeNull();
		expect(
			autoLock({ ...on, deadline: { kind: "none" } }, LONDON, Date.parse("2026-11-20T12:00:00Z")),
		).toBeNull();
	});

	it("moves the lock date up to the deadline N days after it, and not a minute before", () => {
		// The deadline of Friday 13th, two days on: Sunday 15th at 17:00.
		expect(autoLock(on, LONDON, Date.parse("2026-11-15T16:59:00Z"))).toEqual({
			deadline: "2026-11-06",
			lockedThrough: "2026-11-06",
		});
		expect(autoLock(on, LONDON, Date.parse("2026-11-15T17:00:00Z"))).toEqual({
			deadline: "2026-11-13",
			lockedThrough: "2026-11-13",
		});
	});

	it("never moves the lock date backward", () => {
		const later = { ...on, lockedThrough: "2026-11-14" };
		expect(autoLock(later, LONDON, Date.parse("2026-11-15T17:00:00Z"))).toEqual({
			deadline: "2026-11-13",
			lockedThrough: "2026-11-14",
		});
	});

	it("acts on each deadline once, so a date moved back by hand stays back until the next", () => {
		const done = { ...on, lockedThrough: "2026-11-01", autoLockedThrough: "2026-11-13" };
		expect(autoLock(done, LONDON, Date.parse("2026-11-16T09:00:00Z"))).toBeNull();
		expect(autoLock(done, LONDON, Date.parse("2026-11-22T17:00:00Z"))).toEqual({
			deadline: "2026-11-20",
			lockedThrough: "2026-11-20",
		});
	});

	it("moves forward month by month on a monthly deadline", () => {
		const month = { ...on, deadline: monthly, autoLockDays: 0 };
		expect(autoLock(month, LONDON, Date.parse("2026-11-30T18:00:00Z"))?.lockedThrough).toBe(
			"2026-11-30",
		);
		expect(autoLock(month, LONDON, Date.parse("2026-11-30T17:59:00Z"))?.lockedThrough).toBe(
			"2026-10-31",
		);
	});
});
