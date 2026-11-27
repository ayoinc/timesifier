import { describe, expect, it } from "vitest";

import {
	amountText,
	loadOf,
	OVER_SHARE,
	parseAmount,
	plannedOn,
	plannedOver,
	type Share,
	UNDER_SHARE,
} from "~/allocations/allocations";
import type { LeaveCalendar, LeaveRequestLike } from "~/leave/days";
import { weekly } from "~/schedules/schedules";
import { type Day, daysFrom } from "~/time/calendar";

// What a time share plans (TS-116, docs/decisions.md entry 78): read from the
// person's schedule on each day, less public holidays and approved leave, so
// a schedule changed during the share moves its plan with it.

/** Monday 9 to Sunday 15 November 2026, a week that starts on Monday. */
const WEEK = daysFrom("2026-11-09", "2026-11-15");
const MONDAY = 1;

/** Five days of 7:30, Monday to Friday. */
const FULL_TIME = weekly([450, 450, 450, 450, 450, 0, 0]);
/** Three days of 7:30, Monday to Wednesday. */
const PART_TIME = weekly([450, 450, 450, 0, 0, 0, 0]);

function share(amount: number, unit: Share["unit"], more: Partial<Share> = {}): Share {
	return {
		id: "s",
		userId: "u",
		projectId: "p",
		workPackageId: null,
		startsOn: "2026-01-01",
		endsOn: null,
		amount,
		unit,
		...more,
	};
}

function calendar(
	timetable = FULL_TIME,
	{
		holidays = {},
		leave = [],
	}: { holidays?: Record<Day, string>; leave?: LeaveRequestLike[] } = {},
): LeaveCalendar {
	return { timetable, holidays: new Map(Object.entries(holidays)), leave };
}

function leaveOn(
	startsOn: Day,
	endsOn: Day,
	half: Partial<LeaveRequestLike> = {},
): LeaveRequestLike {
	return {
		userId: "u",
		kindKey: "annual",
		kindName: "Annual leave",
		status: "approved",
		startsOn,
		endsOn,
		startsHalf: false,
		endsHalf: false,
		...half,
	};
}

const weekOf = (s: Share, c: LeaveCalendar) => plannedOver(s, c, WEEK, MONDAY);
const byDay = (s: Share, c: LeaveCalendar) => WEEK.map((day) => plannedOn(s, c, day, MONDAY));

describe("a share on a full-time schedule", () => {
	it("plans 2 days a week as two of its days, spread over the week", () => {
		expect(byDay(share(200, "days"), calendar())).toEqual([180, 180, 180, 180, 180, 0, 0]);
		expect(weekOf(share(200, "days"), calendar())).toBe(2 * 450);
	});

	it("plans 22:30 hours a week as 22:30", () => {
		expect(weekOf(share(2250, "hours"), calendar())).toBe(22 * 60 + 30);
		expect(byDay(share(2250, "hours"), calendar())[0]).toBe(270);
	});

	it("plans 50% as half of each day", () => {
		expect(byDay(share(5000, "percent"), calendar())).toEqual([225, 225, 225, 225, 225, 0, 0]);
	});

	it("plans nothing before its first day or after its last", () => {
		const middle = share(10_000, "percent", { startsOn: "2026-11-10", endsOn: "2026-11-11" });
		expect(byDay(middle, calendar())).toEqual([0, 450, 450, 0, 0, 0, 0]);
	});
});

describe("a share on a part-time schedule", () => {
	it("plans 2 days a week as two of the person's own days", () => {
		expect(weekOf(share(200, "days"), calendar(PART_TIME))).toBe(2 * 450);
		expect(byDay(share(200, "days"), calendar(PART_TIME))).toEqual([300, 300, 300, 0, 0, 0, 0]);
	});

	it("plans hours over the hours the schedule sets, and a percentage of it", () => {
		expect(weekOf(share(1000, "hours"), calendar(PART_TIME))).toBe(600);
		expect(weekOf(share(5000, "percent"), calendar(PART_TIME))).toBe(3 * 225);
	});
});

describe("leave and public holidays reduce what is planned", () => {
	it("a public holiday takes that day's plan", () => {
		const c = calendar(FULL_TIME, { holidays: { "2026-11-13": "A holiday" } });
		expect(byDay(share(200, "days"), c)).toEqual([180, 180, 180, 180, 0, 0, 0]);
		expect(weekOf(share(5000, "percent"), c)).toBe(4 * 225);
	});

	it("half a day of leave halves that day's plan", () => {
		const c = calendar(FULL_TIME, {
			leave: [leaveOn("2026-11-10", "2026-11-10", { startsHalf: true })],
		});
		expect(byDay(share(200, "days"), c)).toEqual([180, 90, 180, 180, 180, 0, 0]);
		expect(weekOf(share(2250, "hours"), c)).toBe(4 * 270 + 135);
	});

	it("a whole day of leave takes it, and leave not approved takes nothing", () => {
		const c = calendar(FULL_TIME, {
			leave: [
				leaveOn("2026-11-09", "2026-11-09"),
				{ ...leaveOn("2026-11-11", "2026-11-11"), status: "pending" },
			],
		});
		expect(byDay(share(10_000, "percent"), c)).toEqual([0, 450, 450, 450, 450, 0, 0]);
	});
});

describe("a schedule changed during the share", () => {
	// Full time to Wednesday 11 November; from Thursday, four days of 6:00, Monday to Thursday.
	const changed = (day: Day) =>
		day < "2026-11-12" ? FULL_TIME(day) : weekly([360, 360, 360, 360, 0, 0, 0])(day);

	it("plans each day from the schedule that holds on it", () => {
		// That week works four days, three of 7:30 and one of 6:00, each by the
		// schedule holding on it: one day a week is a quarter of each.
		const plan = byDay(share(100, "days"), calendar(changed));
		expect(plan).toEqual([113, 113, 113, 90, 0, 0, 0]);
	});

	it("moves the plan of the next weeks with the schedule", () => {
		const next = daysFrom("2026-11-16", "2026-11-22");
		expect(plannedOver(share(200, "days"), calendar(changed), next, MONDAY)).toBe(2 * 360);
		expect(plannedOver(share(2400, "hours"), calendar(changed), next, MONDAY)).toBe(24 * 60);
	});
});

describe("over and under", () => {
	it("over is more than 105% of what is available, under less than 80%", () => {
		expect(OVER_SHARE).toBe(1.05);
		expect(UNDER_SHARE).toBe(0.8);
		const week = 5 * 450;
		expect(loadOf(week, week)).toEqual({ kind: "full", words: "Fully allocated" });
		expect(loadOf(Math.floor(week * 1.05), week).kind).toBe("full");
		expect(loadOf(week + 120, week)).toEqual({ kind: "over", words: "Over-allocated by 2:00" });
		expect(loadOf(Math.ceil(week * 0.8), week).kind).toBe("full");
		expect(loadOf(week - 600, week)).toEqual({
			kind: "under",
			words: "Under-allocated: 10:00 free",
		});
		expect(loadOf(0, week)).toEqual({ kind: "under", words: "Under-allocated: nothing planned" });
		expect(loadOf(0, 0)).toEqual({ kind: "none", words: "Nothing available" });
	});
});

describe("amounts", () => {
	it("are read as typed and said in words", () => {
		expect(parseAmount("2.5", "days")).toBe(250);
		expect(parseAmount("22:30", "hours")).toBe(2250);
		expect(parseAmount("22.5", "hours")).toBe(2250);
		expect(parseAmount("50%", "percent")).toBe(5000);
		expect(parseAmount("0", "days")).toBeNull();
		expect(parseAmount("8", "days")).toBeNull();
		expect(parseAmount("101", "percent")).toBeNull();
		expect(parseAmount("7:20", "hours")).toBeNull();
		expect(parseAmount("two", "days")).toBeNull();
		expect(amountText(share(250, "days"))).toBe("2.5 days a week");
		expect(amountText(share(100, "days"))).toBe("1 day a week");
		expect(amountText(share(2250, "hours"))).toBe("22:30 a week");
		expect(amountText(share(5000, "percent"))).toBe("50% of their schedule");
	});
});
