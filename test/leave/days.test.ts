import { describe, expect, it } from "vitest";
import {
	balance,
	dayLabel,
	dayStatus,
	expectedMinutes,
	halfDaysByDay,
	halfDaysByYear,
	halfDaysTaken,
	halvesCovered,
	isWorkingDay,
	type LeaveCalendar,
	type LeaveRequestLike,
	type LeaveSpan,
	leaveHalfDays,
	leaveMinutes,
	nothingExpected,
	overlaps,
	personStatus,
	personStatusLabel,
	workingMinutes,
} from "~/leave/days";
import {
	DEFAULT_KINDS,
	HOLDING_STATUSES,
	HOLIDAY_KIND,
	halfDaysLabel,
	inKindOrder,
	KIND_KEYS,
	type LeaveKind,
	type LeaveStatus,
	requestableKinds,
} from "~/leave/kinds";
import { DEFAULT_NOTICE_DAYS } from "~/leave/rules";
import { STANDARD_WEEK, weekly, weekMinutesOf } from "~/schedules/schedules";
import { addDays, bounds, type Day, daysFrom } from "~/time/calendar";

/** Minutes a day, Monday first: a week of a schedule as these tests write it. */
type WorkingWeek = readonly number[];
/** The Standard schedule every organisation starts with (TS-097): Monday to Friday, 7:30 a day. */
const DEFAULT_WORKING_WEEK: WorkingWeek = weekMinutesOf(STANDARD_WEEK);

// The rules of leave (TS-061) without the database: working days, half days,
// public holidays, the leave year, a person's status now, and what is expected
// of them. Every day is a local date, so a clock change moves nothing.

const HOUR = 3_600_000;
const LONDON = "Europe/London";
/** Every day of the week worked, 7.5 hours: Sundays are working days. */
const EVERY_DAY: WorkingWeek = [450, 450, 450, 450, 450, 450, 450];

const span = (
	startsOn: Day,
	endsOn: Day,
	{ startsHalf = false, endsHalf = false } = {},
): LeaveSpan => ({ startsOn, endsOn, startsHalf, endsHalf });

function leave(
	startsOn: Day,
	endsOn: Day,
	{
		status = "approved" as LeaveStatus,
		kindName = "Annual leave",
		startsHalf = false,
		endsHalf = false,
	} = {},
): LeaveRequestLike {
	return {
		...span(startsOn, endsOn, { startsHalf, endsHalf }),
		userId: "linus",
		kindKey: "annual",
		kindName,
		status,
	};
}

function calendar(
	{
		week = DEFAULT_WORKING_WEEK,
		holidays = {},
	}: { week?: WorkingWeek; holidays?: Record<Day, string> } = {},
	...requests: LeaveRequestLike[]
): LeaveCalendar {
	return { timetable: weekly(week), holidays: new Map(Object.entries(holidays)), leave: requests };
}

describe("the working week", () => {
	it("starts as Monday to Friday, 7:30 a day", () => {
		expect(DEFAULT_WORKING_WEEK).toEqual([450, 450, 450, 450, 450, 0, 0]);
		// 2026-11-09 is a Monday.
		expect(
			daysFrom("2026-11-09", "2026-11-15").map((d) => weekly(DEFAULT_WORKING_WEEK)(d).minutes),
		).toEqual([450, 450, 450, 450, 450, 0, 0]);
	});

	it("expects nothing on a public holiday, which is no working day", () => {
		const christmas = calendar({ holidays: { "2026-12-25": "Christmas Day" } });
		expect(workingMinutes(christmas, "2026-12-25")).toBe(0);
		expect(isWorkingDay(christmas, "2026-12-25")).toBe(false);
		expect(isWorkingDay(christmas, "2026-12-24")).toBe(true);
		// A Saturday is not one either.
		expect(isWorkingDay(christmas, "2026-12-26")).toBe(false);
	});

	it.each([
		["the clocks go forward", "2026-03-29", 23],
		["the clocks go back", "2026-10-25", 25],
	])("still expects 7:30 on the Sunday %s in London, a day of %i hours", (_, day, hours) => {
		const { from, to } = bounds(day, day, LONDON);
		expect((to - from) / HOUR).toBe(hours);
		const sundays = calendar({ week: EVERY_DAY });
		expect(dayStatus(sundays, day)).toMatchObject({
			day,
			is: { kind: "working" },
			expectedMinutes: 450,
		});
		// The week around it expects seven days of 7:30, neither an hour more nor less.
		expect(expectedMinutes(sundays, daysFrom(addDays(day, -6), day))).toBe(7 * 450);
		// And a day of leave on it takes one day, whatever its length.
		expect(halfDaysTaken(span(day, day), sundays)).toBe(2);
		expect(leaveMinutes(calendar({ week: EVERY_DAY }, leave(day, day)), [day])).toBe(450);
	});
});

describe("half days", () => {
	it("a request of one day is half a day when its first day is a half", () => {
		const half = span("2026-11-11", "2026-11-11", { startsHalf: true });
		expect(halvesCovered(half, "2026-11-11")).toBe(1);
		expect(halfDaysTaken(half, calendar())).toBe(1);
		expect(halfDaysLabel(halfDaysTaken(half, calendar()))).toBe("half a day");
	});

	it("halves the first and the last day of a longer request, and no other", () => {
		const week = span("2026-11-09", "2026-11-13", { startsHalf: true, endsHalf: true });
		expect(daysFrom("2026-11-08", "2026-11-14").map((d) => halvesCovered(week, d))).toEqual([
			0, 1, 2, 2, 2, 1, 0,
		]);
		expect(halfDaysTaken(week, calendar())).toBe(8);
		expect(halfDaysTaken({ ...week, startsHalf: false }, calendar())).toBe(9);
		expect(halfDaysTaken({ ...week, endsHalf: false }, calendar())).toBe(9);
	});

	it("halves the day's minutes for a half day of approved leave, and takes them all for a whole one", () => {
		const theirs = calendar(
			{},
			leave("2026-11-09", "2026-11-10", { endsHalf: true }),
			leave("2026-11-12", "2026-11-12", { startsHalf: true }),
		);
		const days = daysFrom("2026-11-09", "2026-11-15");
		expect(days.map((d) => dayStatus(theirs, d).expectedMinutes)).toEqual([
			0, 225, 450, 225, 450, 0, 0,
		]);
		expect(expectedMinutes(theirs, days)).toBe(1350);
		expect(leaveHalfDays(theirs, days)).toBe(4);
		expect(leaveMinutes(theirs, days)).toBe(900);
		expect(dayLabel(dayStatus(theirs, "2026-11-10"))).toBe("Annual leave (half day)");
		expect(dayLabel(dayStatus(theirs, "2026-11-09"))).toBe("Annual leave");
	});
});

describe("a request over weekends and public holidays", () => {
	const christmas = calendar({
		holidays: { "2026-12-25": "Christmas Day", "2026-12-28": "Boxing Day (substitute day)" },
	});

	it("takes only working days", () => {
		// Friday 18 December to Tuesday 29 December: 18, 21–24 and 29 are worked.
		const winter = span("2026-12-18", "2026-12-29");
		expect([...halfDaysByDay(winter, christmas).keys()]).toEqual([
			"2026-12-18",
			"2026-12-21",
			"2026-12-22",
			"2026-12-23",
			"2026-12-24",
			"2026-12-29",
		]);
		expect(halfDaysTaken(winter, christmas)).toBe(12);
	});

	it("takes nothing when its days hold no working day", () => {
		expect(halfDaysTaken(span("2026-12-26", "2026-12-28"), christmas)).toBe(0);
		// A half day on a holiday is no half day either.
		expect(halfDaysTaken(span("2026-12-25", "2026-12-25", { startsHalf: true }), christmas)).toBe(
			0,
		);
	});

	it("names a public holiday before any leave on it, and ignores leave that is not approved", () => {
		const theirs = calendar(
			{ holidays: { "2026-12-25": "Christmas Day" } },
			leave("2026-12-21", "2026-12-25"),
			leave("2026-12-28", "2026-12-28", { status: "pending" }),
			leave("2026-12-29", "2026-12-29", { status: "refused" }),
			leave("2026-12-30", "2026-12-30", { status: "withdrawn" }),
			leave("2026-12-31", "2026-12-31", { status: "cancelled" }),
		);
		expect(dayStatus(theirs, "2026-12-25").is).toEqual({ kind: "holiday", name: "Christmas Day" });
		expect(dayLabel(dayStatus(theirs, "2026-12-25"))).toBe("Christmas Day");
		expect(dayLabel(dayStatus(theirs, "2026-12-26"))).toBe("Not a working day");
		expect(dayStatus(theirs, "2026-12-24").is.kind).toBe("leave");
		for (const day of daysFrom("2026-12-28", "2026-12-31")) {
			expect(dayStatus(theirs, day)).toMatchObject({
				day,
				is: { kind: "working" },
				expectedMinutes: 450,
			});
			expect(dayLabel(dayStatus(theirs, day))).toBeNull();
		}
		expect(leaveHalfDays(theirs, daysFrom("2026-12-21", "2026-12-31"))).toBe(8);
	});
});

describe("the leave year, which is the calendar year", () => {
	// Monday 28 December 2026 to Tuesday 5 January 2027, New Year's Day a public holiday.
	const winter = span("2026-12-28", "2027-01-05");
	const newYear = calendar({ holidays: { "2027-01-01": "New Year's Day" } });

	it("counts a request's days in the year each falls in", () => {
		expect(halfDaysByYear(winter, newYear)).toEqual(
			new Map([
				[2026, 8],
				[2027, 4],
			]),
		);
		expect(halfDaysByYear(winter, calendar())).toEqual(
			new Map([
				[2026, 8],
				[2027, 6],
			]),
		);
		expect(halfDaysTaken(winter, newYear)).toBe(12);
	});

	it("takes each year's days from that year's allowance alone, with nothing carried over", () => {
		const requests = [
			{ ...winter, endsHalf: true, status: "approved" as const },
			{ ...span("2026-12-01", "2026-12-02"), status: "pending" as const },
			{ ...span("2026-12-03", "2026-12-03"), status: "refused" as const },
			{ ...span("2026-12-04", "2026-12-04"), status: "withdrawn" as const },
			{ ...span("2026-12-07", "2026-12-07"), status: "cancelled" as const },
		];
		expect(balance(50, requests, 2026, newYear)).toEqual({
			year: 2026,
			allowance: 50,
			approved: 8,
			pending: 4,
			left: 38,
		});
		expect(balance(50, requests, 2027, newYear)).toEqual({
			year: 2027,
			allowance: 50,
			approved: 3,
			pending: 0,
			left: 47,
		});
		// A year it does not touch has the whole allowance.
		expect(balance(50, requests, 2028, newYear).left).toBe(50);
	});

	it("has nothing left to give when the kind has no allowance", () => {
		const requests = [{ ...winter, status: "approved" as const }];
		expect(balance(null, requests, 2026, newYear)).toEqual({
			year: 2026,
			allowance: null,
			approved: 8,
			pending: 0,
			left: null,
		});
	});

	it("can go below nothing, when the allowance is lowered after the leave was approved", () => {
		const requests = [{ ...span("2026-12-14", "2026-12-18"), status: "approved" as const }];
		expect(balance(4, requests, 2026, calendar()).left).toBe(-6);
	});
});

describe("two requests", () => {
	it.each([
		[span("2026-11-09", "2026-11-13"), span("2026-11-13", "2026-11-20"), true],
		[span("2026-11-09", "2026-11-13"), span("2026-11-10", "2026-11-11"), true],
		[span("2026-11-09", "2026-11-13"), span("2026-11-14", "2026-11-20"), false],
		[span("2026-11-09", "2026-11-09"), span("2026-11-09", "2026-11-09"), true],
	])("%j and %j overlap: %s, either way round", (a, b, both) => {
		expect(overlaps(a, b)).toBe(both);
		expect(overlaps(b, a)).toBe(both);
	});
});

describe("where a person stands now", () => {
	const theirs = calendar(
		{ holidays: { "2026-12-25": "Christmas Day" } },
		leave("2026-11-11", "2026-11-12", { endsHalf: true }),
	);
	const status = (day: Day, running = false, kindVisible = true) =>
		personStatusLabel(personStatus(theirs, day, { running, kindVisible }));

	it("is working while their timer runs, whatever the day", () => {
		for (const day of ["2026-11-11", "2026-12-25", "2026-11-14", "2026-11-10"]) {
			expect(personStatus(theirs, day, { running: true, kindVisible: true })).toEqual({
				kind: "working",
			});
			expect(status(day, true)).toBe("Working");
		}
	});

	it("is on leave, naming the kind only to whoever may see it", () => {
		expect(personStatus(theirs, "2026-11-11", { running: false, kindVisible: true })).toEqual({
			kind: "on-leave",
			halves: 2,
			kindName: "Annual leave",
		});
		expect(status("2026-11-11")).toBe("On leave · Annual leave");
		expect(personStatus(theirs, "2026-11-11", { running: false, kindVisible: false })).toEqual({
			kind: "on-leave",
			halves: 2,
			kindName: null,
		});
		expect(status("2026-11-11", false, false)).toBe("On leave");
		expect(status("2026-11-12")).toBe("On leave for half the day · Annual leave");
		expect(status("2026-11-12", false, false)).toBe("On leave for half the day");
	});

	it("is not working on a public holiday or a day the week does not work, and available otherwise", () => {
		expect(status("2026-12-25")).toBe("Not working today · Christmas Day");
		expect(status("2026-11-14")).toBe("Not working today");
		expect(status("2026-11-13")).toBe("Available");
	});

	it("names a day of leave as On leave to whoever may not see the kind", () => {
		expect(dayLabel(dayStatus(theirs, "2026-11-11"), false)).toBe("On leave");
		expect(dayLabel(dayStatus(theirs, "2026-11-12"), false)).toBe("On leave (half day)");
	});
});

describe("whether anything is expected of a person", () => {
	const week = daysFrom("2026-12-21", "2026-12-27");
	const holidays = { "2026-12-25": "Christmas Day" };

	it("is nothing over a week of leave, a public holiday and the weekend", () => {
		expect(nothingExpected(calendar({ holidays }, leave("2026-12-21", "2026-12-24")), week)).toBe(
			true,
		);
		expect(nothingExpected(calendar({ holidays }, leave("2026-12-21", "2026-12-25")), week)).toBe(
			true,
		);
		expect(nothingExpected(calendar(), daysFrom("2026-12-26", "2026-12-27"))).toBe(true);
	});

	it("is something when a day of it is worked, even half of one", () => {
		expect(nothingExpected(calendar({ holidays }, leave("2026-12-21", "2026-12-23")), week)).toBe(
			false,
		);
		expect(
			nothingExpected(
				calendar({ holidays }, leave("2026-12-21", "2026-12-24", { endsHalf: true })),
				week,
			),
		).toBe(false);
		expect(
			nothingExpected(
				calendar({ holidays }, leave("2026-12-21", "2026-12-24", { status: "pending" })),
				week,
			),
		).toBe(false);
	});
});

describe("the kinds of leave", () => {
	const kinds: LeaveKind[] = [...KIND_KEYS].reverse().map((key) => ({
		id: `k-${key}`,
		key,
		name: DEFAULT_KINDS[key].name,
		enabled: key !== "study",
		needsApproval: DEFAULT_KINDS[key].needsApproval,
		allowanceHalfDays: DEFAULT_KINDS[key].allowanceHalfDays,
		noticeDays: DEFAULT_NOTICE_DAYS[key],
	}));

	it("are six, Annual with 25 days a year, Sick and Public holiday approved at once", () => {
		expect(KIND_KEYS).toEqual(["annual", "sick", "study", "parental", "unpaid", "holiday"]);
		expect(DEFAULT_KINDS.annual).toEqual({
			name: "Annual leave",
			needsApproval: true,
			allowanceHalfDays: 50,
		});
		expect(KIND_KEYS.filter((key) => !DEFAULT_KINDS[key].needsApproval)).toEqual([
			"sick",
			"holiday",
		]);
		expect(KIND_KEYS.filter((key) => DEFAULT_KINDS[key].allowanceHalfDays !== null)).toEqual([
			"annual",
		]);
		expect(HOLIDAY_KIND).toBe("holiday");
		expect(HOLDING_STATUSES).toEqual(["pending", "approved"]);
	});

	it("are listed in their order, and asked for when on and not public holidays", () => {
		expect(inKindOrder(kinds).map((k) => k.key)).toEqual([...KIND_KEYS]);
		expect(requestableKinds(kinds).map((k) => k.key)).toEqual([
			"annual",
			"sick",
			"parental",
			"unpaid",
		]);
	});

	it.each([
		[1, "half a day"],
		[2, "1 day"],
		[3, "1.5 days"],
		[5, "2.5 days"],
		[50, "25 days"],
		[0, "0 days"],
	])("%i half days are %s", (halves, words) => {
		expect(halfDaysLabel(halves)).toBe(words);
	});
});

/** A small, seeded generator (mulberry32), so a failing case can be run again. */
function random(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

describe("a property of every request and calendar", () => {
	const MINUTES = [0, 0, 240, 450, 465, 480];

	function scenario(seed: number) {
		const next = random(seed);
		const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)] as T;
		const int = (below: number) => Math.floor(next() * below);
		const week = Array.from({ length: 7 }, () => pick(MINUTES));
		// Around a year's end, so that many requests cross it.
		const origin = "2026-11-01";
		const holidays: Record<Day, string> = {};
		for (let i = int(8); i > 0; i--) holidays[addDays(origin, int(120))] = "Holiday";
		const randomSpan = (): LeaveSpan => {
			const startsOn = addDays(origin, int(110));
			const endsOn = addDays(startsOn, int(30));
			return span(startsOn, endsOn, {
				startsHalf: next() < 0.4,
				endsHalf: endsOn > startsOn && next() < 0.4,
			});
		};
		return { next, pick, int, week, holidays, randomSpan, origin };
	}

	it.each(Array.from({ length: 80 }, (_, seed) => seed))(
		"seed %i: a span's half days are those of its years added up, between none and two a day",
		(seed) => {
			const { week, holidays, randomSpan } = scenario(seed);
			const theirs = calendar({ week, holidays });
			const each = randomSpan();
			const taken = halfDaysTaken(each, theirs);
			const byYear = [...halfDaysByYear(each, theirs).values()];
			expect(byYear.reduce((sum, halves) => sum + halves, 0)).toBe(taken);
			expect(taken).toBeGreaterThanOrEqual(0);
			expect(taken).toBeLessThanOrEqual(2 * daysFrom(each.startsOn, each.endsOn).length);
			// No day counts a half day that is not worked.
			for (const [day, halves] of halfDaysByDay(each, theirs)) {
				expect(isWorkingDay(theirs, day)).toBe(true);
				expect([1, 2]).toContain(halves);
			}
			// A year's balance counts that year's half days alone.
			for (const [year, halves] of halfDaysByYear(each, theirs)) {
				expect(balance(50, [{ ...each, status: "pending" }], year, theirs)).toEqual({
					year,
					allowance: 50,
					approved: 0,
					pending: halves,
					left: 50 - halves,
				});
			}
		},
	);

	it.each(Array.from({ length: 80 }, (_, seed) => seed))(
		"seed %i: with approved leave alone, the time expected and the leave add up to the working time",
		(seed) => {
			const { week, holidays, randomSpan, int, origin } = scenario(1000 + seed);
			const requests = Array.from({ length: int(5) }, () => {
				const { startsOn, endsOn, startsHalf, endsHalf } = randomSpan();
				return leave(startsOn, endsOn, { startsHalf, endsHalf });
			});
			const theirs = calendar({ week, holidays }, ...requests);
			const days = daysFrom(origin, addDays(origin, 139));
			const working = days.reduce((sum, day) => sum + workingMinutes(theirs, day), 0);
			expect(expectedMinutes(theirs, days) + leaveMinutes(theirs, days)).toBe(working);
			// Each day on its own, too, and leave never exceeds the day.
			for (const day of days) {
				const { expectedMinutes: expected } = dayStatus(theirs, day);
				expect(expected + leaveMinutes(theirs, [day])).toBe(workingMinutes(theirs, day));
				expect(expected).toBeGreaterThanOrEqual(0);
			}
			expect(nothingExpected(theirs, days)).toBe(expectedMinutes(theirs, days) === 0);
		},
	);
});
