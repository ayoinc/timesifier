import { describe, expect, it } from "vitest";
import { DEFAULT_WORKING_WEEK, type LeaveRequestLike, type WorkingWeek } from "~/leave/days";
import { KIND_KEYS, type KindKey, type LeaveStatus } from "~/leave/kinds";
import {
	closedReason,
	type DayLimit,
	DEFAULT_NOTICE_DAYS,
	dayLimit,
	dayRules,
	earliestNoticed,
	isShortNotice,
	leftMessage,
	MOST_WORK_MINUTES_A_DAY,
	mayStart,
	mayWrite,
	minutesLeft,
	minutesOver,
	noticeGiven,
	noticeLabel,
	overLabel,
	type RulesCalendar,
	type TimesheetRules,
	type WorkKind,
	type WorkRequestLike,
	type WorkRule,
	wholeMinutes,
} from "~/leave/rules";
import { addDays, bounds, type Day, dayOf, daysFrom } from "~/time/calendar";

// The rules of leave and tracked time together (TS-090) without the database:
// how much time a day of a person takes, whether a change or a timer fits in
// it, and whether leave was asked for in good time.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LONDON = "Europe/London";
/** Every day of the week worked, 7.5 hours: Sundays are working days. */
const EVERY_DAY: WorkingWeek = [450, 450, 450, 450, 450, 450, 450];

// A week of November 2026: Monday the 9th to Sunday the 15th.
const MONDAY = "2026-11-09";
const TUESDAY = "2026-11-10";
const WEDNESDAY = "2026-11-11";
const SATURDAY = "2026-11-14";
const SUNDAY = "2026-11-15";
const CHRISTMAS = "2026-12-25";

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
		startsOn,
		endsOn,
		startsHalf,
		endsHalf,
		userId: "ada",
		kindKey: "annual",
		kindName,
		status,
	};
}

function work(
	kind: WorkKind,
	startsOn: Day,
	endsOn: Day,
	minutesPerDay: number,
	status: LeaveStatus = "approved",
): WorkRequestLike {
	return { userId: "ada", kind, startsOn, endsOn, minutesPerDay, status };
}

function calendar({
	week = DEFAULT_WORKING_WEEK,
	holidays = {},
	requests = [],
	overtime = "free",
	weekend = "free",
	approved = [],
}: {
	week?: WorkingWeek;
	holidays?: Record<Day, string>;
	requests?: LeaveRequestLike[];
	overtime?: WorkRule;
	weekend?: WorkRule;
	approved?: WorkRequestLike[];
} = {}): RulesCalendar {
	return {
		week,
		holidays: new Map(Object.entries(holidays)),
		leave: requests,
		rules: { overtime, weekend },
		work: approved,
	};
}

/** The limit of `day` alone, without the status it was read from. */
function limitOf(theirs: RulesCalendar, day: Day) {
	const { limitMinutes, closed, approvedMinutes } = dayLimit(theirs, day);
	return { limitMinutes, closed, approvedMinutes };
}

const RULES: WorkRule[] = ["free", "approval", "none"];

describe("the limit of a working day", () => {
	it("is none while overtime is allowed freely", () => {
		expect(limitOf(calendar(), TUESDAY)).toEqual({
			limitMinutes: null,
			closed: null,
			approvedMinutes: 0,
		});
		// Approved overtime changes nothing where none is needed.
		expect(
			limitOf(calendar({ approved: [work("overtime", TUESDAY, TUESDAY, 60)] }), TUESDAY)
				.limitMinutes,
		).toBeNull();
	});

	it.each(["approval", "none"] as const)(
		"is the expected 7:30 while overtime is %s",
		(overtime) => {
			expect(limitOf(calendar({ overtime }), TUESDAY)).toEqual({
				limitMinutes: 450,
				closed: null,
				approvedMinutes: 0,
			});
		},
	);

	it("is raised by approved overtime, two requests that cover the day added up", () => {
		const theirs = calendar({
			overtime: "approval",
			approved: [work("overtime", MONDAY, WEDNESDAY, 60), work("overtime", TUESDAY, TUESDAY, 90)],
		});
		expect(limitOf(theirs, MONDAY)).toEqual({
			limitMinutes: 510,
			closed: null,
			approvedMinutes: 60,
		});
		expect(limitOf(theirs, TUESDAY)).toEqual({
			limitMinutes: 600,
			closed: null,
			approvedMinutes: 150,
		});
		// The day after the span is the week's alone.
		expect(limitOf(theirs, "2026-11-12").limitMinutes).toBe(450);
	});

	it.each(["pending", "refused", "withdrawn", "cancelled"] as const)(
		"ignores %s overtime, and weekend work on a working day",
		(status) => {
			const theirs = calendar({
				overtime: "approval",
				approved: [
					work("overtime", TUESDAY, TUESDAY, 120, status),
					work("weekend", TUESDAY, TUESDAY, 120),
				],
			});
			expect(limitOf(theirs, TUESDAY)).toEqual({
				limitMinutes: 450,
				closed: null,
				approvedMinutes: 0,
			});
		},
	);

	it("follows the week: a longer day expects more, odd minutes stay whole", () => {
		const theirs = calendar({ week: [480, 465, 451, 450, 450, 0, 0], overtime: "approval" });
		expect(daysFrom(MONDAY, WEDNESDAY).map((day) => limitOf(theirs, day).limitMinutes)).toEqual([
			480, 465, 451,
		]);
	});
});

describe("the limit of a day of half-day leave", () => {
	const half = leave(TUESDAY, TUESDAY, { startsHalf: true });

	it.each(RULES)("is the other half, 3:45 of 7:30, whatever overtime is (%s)", (overtime) => {
		expect(limitOf(calendar({ requests: [half], overtime }), TUESDAY)).toEqual({
			limitMinutes: 225,
			closed: null,
			approvedMinutes: 0,
		});
	});

	it.each(RULES)("is raised only by approved overtime (%s)", (overtime) => {
		const theirs = calendar({
			requests: [half],
			overtime,
			approved: [
				work("overtime", MONDAY, WEDNESDAY, 60),
				work("overtime", TUESDAY, TUESDAY, 30),
				work("overtime", TUESDAY, TUESDAY, 120, "pending"),
				work("overtime", TUESDAY, TUESDAY, 120, "refused"),
				work("weekend", TUESDAY, TUESDAY, 120),
			],
		});
		expect(limitOf(theirs, TUESDAY)).toEqual({
			limitMinutes: 315,
			closed: null,
			approvedMinutes: 90,
		});
	});

	it("is the half of the last day of a longer span, and an odd day's half is floored", () => {
		const theirs = calendar({
			week: [451, 451, 451, 451, 451, 0, 0],
			requests: [leave(MONDAY, TUESDAY, { endsHalf: true })],
		});
		expect(limitOf(theirs, MONDAY).limitMinutes).toBe(0);
		expect(limitOf(theirs, TUESDAY).limitMinutes).toBe(225);
		expect(limitOf(theirs, WEDNESDAY).limitMinutes).toBeNull();
	});

	it("is not leave while the request is not approved", () => {
		const pending = leave(TUESDAY, TUESDAY, { startsHalf: true, status: "pending" });
		expect(limitOf(calendar({ requests: [pending] }), TUESDAY).limitMinutes).toBeNull();
	});
});

describe("a closed day", () => {
	it.each(RULES)("is whole-day leave, with its kind named (overtime %s)", (overtime) => {
		const theirs = calendar({
			requests: [leave(MONDAY, WEDNESDAY, { kindName: "Study leave" })],
			overtime,
			// Approved overtime does not open it.
			approved: [work("overtime", TUESDAY, TUESDAY, 120)],
		});
		const limit = dayLimit(theirs, TUESDAY);
		expect(limit).toMatchObject({
			limitMinutes: 0,
			closed: { why: "leave", kindName: "Study leave" },
			approvedMinutes: 0,
		});
		expect(closedReason(limit.closed ?? { why: "weekend-not-allowed" }, TUESDAY)).toBe(
			"You are on study leave that day: no time can be tracked on it.",
		);
	});

	it.each(RULES)("is a public holiday, by its name (weekend %s)", (weekend) => {
		const theirs = calendar({
			holidays: { [CHRISTMAS]: "Christmas Day", "2026-12-26": "Boxing Day" },
			weekend,
			approved: [work("weekend", "2026-12-26", "2026-12-26", 240)],
		});
		for (const [day, name] of [
			[CHRISTMAS, "Christmas Day"],
			// A Saturday, and the holiday comes before the weekend.
			["2026-12-26", "Boxing Day"],
		] as const) {
			const limit = dayLimit(theirs, day);
			expect(limit).toMatchObject({ limitMinutes: 0, closed: { why: "holiday", name } });
			expect(closedReason({ why: "holiday", name }, day)).toBe(
				`${name} is a public holiday: no time can be tracked on it.`,
			);
		}
	});

	it("says why in each case", () => {
		expect(closedReason({ why: "weekend-needs-approval" }, SATURDAY)).toBe(
			"Saturday is not a working day: time on it needs approved weekend work. Request it on Time off.",
		);
		expect(closedReason({ why: "weekend-not-allowed" }, SUNDAY)).toBe(
			"Sunday is not a working day, and this organisation does not allow time on it.",
		);
		expect(closedReason({ why: "leave", kindName: "Annual leave" }, MONDAY)).toBe(
			"You are on annual leave that day: no time can be tracked on it.",
		);
	});
});

describe("a day the week does not work", () => {
	it("takes any time while weekend work is allowed freely", () => {
		for (const day of [SATURDAY, SUNDAY]) {
			expect(limitOf(calendar({ overtime: "none" }), day)).toEqual({
				limitMinutes: null,
				closed: null,
				approvedMinutes: 0,
			});
		}
	});

	it("with pre-approval, is closed without approved weekend work and takes what was approved with it", () => {
		const theirs = calendar({
			weekend: "approval",
			approved: [
				work("weekend", SATURDAY, SATURDAY, 240),
				work("weekend", SATURDAY, SUNDAY, 60),
				work("weekend", SUNDAY, SUNDAY, 600, "pending"),
				work("overtime", SUNDAY, SUNDAY, 600),
			],
		});
		expect(limitOf(theirs, SATURDAY)).toEqual({
			limitMinutes: 300,
			closed: null,
			approvedMinutes: 300,
		});
		expect(limitOf(theirs, SUNDAY)).toEqual({
			limitMinutes: 60,
			closed: null,
			approvedMinutes: 60,
		});
		expect(limitOf(theirs, "2026-11-21")).toEqual({
			limitMinutes: 0,
			closed: { why: "weekend-needs-approval" },
			approvedMinutes: 0,
		});
	});

	it("is closed when weekend work is not allowed, approved work or not", () => {
		const theirs = calendar({
			weekend: "none",
			approved: [work("weekend", SATURDAY, SATURDAY, 240)],
		});
		expect(limitOf(theirs, SATURDAY)).toEqual({
			limitMinutes: 0,
			closed: { why: "weekend-not-allowed" },
			approvedMinutes: 0,
		});
	});

	it("is any day the week does not work, a weekday too", () => {
		const theirs = calendar({ week: [450, 450, 0, 450, 450, 0, 0], weekend: "none" });
		expect(limitOf(theirs, WEDNESDAY).closed).toEqual({ why: "weekend-not-allowed" });
		expect(closedReason({ why: "weekend-not-allowed" }, WEDNESDAY)).toBe(
			"Wednesday is not a working day, and this organisation does not allow time on it.",
		);
	});
});

describe("the days around a clock change in London", () => {
	/** An entry from `from`, as an instant, for `minutes`. */
	const entry = (from: string, minutes: number) => ({
		startedAt: Date.parse(from),
		endedAt: Date.parse(from) + minutes * MINUTE,
	});
	/** What the Timesheet adds up on `day`: entries that start on it in London. */
	const trackedIn =
		(entries: { startedAt: number; endedAt: number }[]) =>
		(day: Day): number =>
			entries
				.filter((each) => dayOf(each.startedAt, LONDON) === day)
				.reduce((sum, each) => sum + each.endedAt - each.startedAt, 0);

	it.each([
		// The clocks go forward at 01:00 GMT: the 29th has 23 hours.
		["forward", "2026-03-29", 23, "2026-03-28T23:30:00Z", "2026-03-29T23:30:00Z"],
		// The clocks go back at 01:00 GMT: the 25th has 25 hours.
		["back", "2026-10-25", 25, "2026-10-24T23:30:00Z", "2026-10-25T23:30:00Z"],
	])(
		"the clocks going %s on %s leave its limit 7:30, and each entry on the day it starts there",
		(_, day, hours, aroundStart, aroundEnd) => {
			const { from, to } = bounds(day, day, LONDON);
			expect((to - from) / HOUR).toBe(hours);
			const theirs = calendar({ week: EVERY_DAY, overtime: "approval" });

			// 23:30 UTC is 00:30 the next day in summer time, and 23:30 the same day in winter.
			const before = dayOf(Date.parse(aroundStart), LONDON);
			const after = dayOf(Date.parse(aroundEnd), LONDON);
			expect([before, after]).toEqual(
				day === "2026-03-29" ? [addDays(day, -1), addDays(day, 1)] : [day, day],
			);

			// 7:30 from the day's first instant: the whole limit, whatever the day's length.
			const entries = [
				entry(new Date(from).toISOString(), 450),
				entry(aroundStart, 60),
				entry(aroundEnd, 60),
			];
			const rules = dayRules(theirs, [addDays(day, -1), day, addDays(day, 1)], trackedIn(entries));
			const onDay = (each: Day) => rules.find((rule) => rule.day === each);
			const extra = (each: Day) =>
				(before === each ? 60 : 0) + (after === each ? 60 : 0) + (each === day ? 450 : 0);
			for (const each of [addDays(day, -1), day, addDays(day, 1)]) {
				expect(onDay(each)?.limitMinutes, each).toBe(450);
				expect(onDay(each)?.trackedMinutes, each).toBe(extra(each));
				expect(onDay(each)?.overMinutes, each).toBe(Math.max(0, extra(each) - 450));
			}
		},
	);
});

describe("the rules of each day as the Timesheet shows them", () => {
	it("hold the limit, the reason, what is tracked, left and over, and approved work", () => {
		const theirs = calendar({
			holidays: { "2026-11-13": "Founders' Day" },
			requests: [
				leave(TUESDAY, TUESDAY, { startsHalf: true }),
				leave("2026-11-12", "2026-11-12", { kindName: "Sick leave" }),
			],
			overtime: "approval",
			weekend: "approval",
			approved: [work("overtime", TUESDAY, TUESDAY, 30)],
		});
		const tracked: Record<Day, number> = {
			[MONDAY]: 8 * HOUR + 59_999,
			[TUESDAY]: 3 * HOUR,
			[WEDNESDAY]: 0,
		};
		expect(dayRules(theirs, daysFrom(MONDAY, SATURDAY), (day) => tracked[day] ?? 0)).toEqual([
			{
				day: MONDAY,
				limitMinutes: 450,
				closedReason: null,
				trackedMinutes: 480,
				leftMinutes: 0,
				overMinutes: 30,
				approvedMinutes: 0,
			},
			{
				day: TUESDAY,
				limitMinutes: 255,
				closedReason: null,
				trackedMinutes: 180,
				leftMinutes: 75,
				overMinutes: 0,
				approvedMinutes: 30,
			},
			{
				day: WEDNESDAY,
				limitMinutes: 450,
				closedReason: null,
				trackedMinutes: 0,
				leftMinutes: 450,
				overMinutes: 0,
				approvedMinutes: 0,
			},
			{
				day: "2026-11-12",
				limitMinutes: 0,
				closedReason: "You are on sick leave that day: no time can be tracked on it.",
				trackedMinutes: 0,
				leftMinutes: 0,
				overMinutes: 0,
				approvedMinutes: 0,
			},
			{
				day: "2026-11-13",
				limitMinutes: 0,
				closedReason: "Founders' Day is a public holiday: no time can be tracked on it.",
				trackedMinutes: 0,
				leftMinutes: 0,
				overMinutes: 0,
				approvedMinutes: 0,
			},
			{
				day: SATURDAY,
				limitMinutes: 0,
				closedReason:
					"Saturday is not a working day: time on it needs approved weekend work. Request it on Time off.",
				trackedMinutes: 0,
				leftMinutes: 0,
				overMinutes: 0,
				approvedMinutes: 0,
			},
		]);
	});

	it("show a day without a limit with nothing left to count and never over", () => {
		expect(dayRules(calendar(), [MONDAY], () => 20 * HOUR)).toEqual([
			{
				day: MONDAY,
				limitMinutes: null,
				closedReason: null,
				trackedMinutes: 1200,
				leftMinutes: null,
				overMinutes: 0,
				approvedMinutes: 0,
			},
		]);
	});
});

describe("minutes left and over", () => {
	const half = { limitMinutes: 225 };

	it("drop the seconds, as the Timesheet does", () => {
		expect(wholeMinutes(59_999)).toBe(0);
		expect(wholeMinutes(60_000)).toBe(1);
		expect(wholeMinutes(-5 * MINUTE)).toBe(0);
		// 225 minutes and 59 seconds is not over 225, and leaves nothing.
		expect(minutesOver(half, 225 * MINUTE + 59_999)).toBe(0);
		expect(minutesLeft(half, 225 * MINUTE + 59_999)).toBe(0);
		// A whole minute more is.
		expect(minutesOver(half, 226 * MINUTE)).toBe(1);
		expect(minutesLeft(half, 226 * MINUTE)).toBe(0);
		// Left is what remains, floored: 124 minutes 30 seconds is 124.
		expect(minutesLeft(half, 100 * MINUTE + 30_000)).toBe(124);
		expect(minutesLeft(half, 0)).toBe(225);
	});

	it("are none on a day without a limit", () => {
		expect(minutesLeft({ limitMinutes: null }, 30 * HOUR)).toBeNull();
		expect(minutesOver({ limitMinutes: null }, 30 * HOUR)).toBe(0);
	});

	it("read as words", () => {
		expect(leftMessage(225)).toBe("This day has 3:45 left.");
		expect(leftMessage(0)).toBe("This day has 0:00 left.");
		expect(overLabel(15)).toBe("Over by 0:15");
		expect(overLabel(75)).toBe("Over by 1:15");
	});
});

describe("whether a change may be written", () => {
	const halfDay = dayLimit(
		calendar({ requests: [leave(TUESDAY, TUESDAY, { startsHalf: true })] }),
		TUESDAY,
	);
	const wholeDay = dayLimit(calendar({ requests: [leave(TUESDAY, TUESDAY)] }), TUESDAY);
	const free = dayLimit(calendar(), TUESDAY);
	const capped = dayLimit(calendar({ overtime: "approval" }), TUESDAY);

	it("always allows a change that adds nothing, even on a closed day or one over", () => {
		for (const limit of [halfDay, wholeDay, free, capped]) {
			expect(mayWrite(limit, { othersMs: 0, beforeMs: 0, afterMs: 0 })).toEqual({ ok: true });
			expect(mayWrite(limit, { othersMs: 0, beforeMs: HOUR, afterMs: 30 * MINUTE })).toEqual({
				ok: true,
			});
			expect(mayWrite(limit, { othersMs: 10 * HOUR, beforeMs: HOUR, afterMs: HOUR })).toEqual({
				ok: true,
			});
		}
	});

	it("refuses any time on a closed day with the reason", () => {
		expect(mayWrite(wholeDay, { othersMs: 0, beforeMs: 0, afterMs: MINUTE })).toEqual({
			ok: false,
			message: "You are on annual leave that day: no time can be tracked on it.",
		});
	});

	it("allows exactly filling the limit, and refuses one minute more with what is left", () => {
		expect(mayWrite(halfDay, { othersMs: 0, beforeMs: 0, afterMs: 225 * MINUTE })).toEqual({
			ok: true,
		});
		expect(mayWrite(halfDay, { othersMs: 0, beforeMs: 0, afterMs: 226 * MINUTE })).toEqual({
			ok: false,
			message: "This day has 3:45 left.",
		});
		expect(
			mayWrite(halfDay, { othersMs: 60 * MINUTE, beforeMs: 0, afterMs: 165 * MINUTE }),
		).toEqual({ ok: true });
		expect(
			mayWrite(halfDay, { othersMs: 60 * MINUTE, beforeMs: 0, afterMs: 166 * MINUTE }),
		).toEqual({ ok: false, message: "This day has 2:45 left." });
		expect(mayWrite(capped, { othersMs: 7 * HOUR, beforeMs: 0, afterMs: 31 * MINUTE })).toEqual({
			ok: false,
			message: "This day has 0:30 left.",
		});
		// A full day says it has nothing left.
		expect(mayWrite(halfDay, { othersMs: 225 * MINUTE, beforeMs: 0, afterMs: MINUTE })).toEqual({
			ok: false,
			message: "This day has 0:00 left.",
		});
	});

	it("counts whole minutes: seconds within the last minute fit", () => {
		expect(mayWrite(halfDay, { othersMs: 0, beforeMs: 0, afterMs: 225 * MINUTE + 59_999 })).toEqual(
			{ ok: true },
		);
	});

	it("lets an entry grow into what is left, the entry itself not counted as other time", () => {
		expect(
			mayWrite(halfDay, { othersMs: 0, beforeMs: 200 * MINUTE, afterMs: 225 * MINUTE }),
		).toEqual({ ok: true });
		expect(
			mayWrite(halfDay, { othersMs: 30 * MINUTE, beforeMs: 100 * MINUTE, afterMs: 200 * MINUTE }),
		).toEqual({ ok: false, message: "This day has 3:15 left." });
	});

	it("takes anything on a day without a limit", () => {
		expect(mayWrite(free, { othersMs: 20 * HOUR, beforeMs: 0, afterMs: 4 * HOUR })).toEqual({
			ok: true,
		});
	});
});

describe("whether a timer may start", () => {
	it("refuses a closed day with its reason", () => {
		const holiday = dayLimit(calendar({ holidays: { [CHRISTMAS]: "Christmas Day" } }), CHRISTMAS);
		expect(mayStart(holiday, 0)).toEqual({
			ok: false,
			message: "Christmas Day is a public holiday: no time can be tracked on it.",
		});
	});

	it("refuses a day with nothing left, a part of a minute being nothing", () => {
		const halfDay = dayLimit(
			calendar({ requests: [leave(TUESDAY, TUESDAY, { startsHalf: true })] }),
			TUESDAY,
		);
		expect(mayStart(halfDay, 224 * MINUTE)).toEqual({ ok: true });
		expect(mayStart(halfDay, 224 * MINUTE + 30_000)).toEqual({
			ok: false,
			message: "This day has 0:00 left.",
		});
		expect(mayStart(halfDay, 225 * MINUTE)).toEqual({
			ok: false,
			message: "This day has 0:00 left.",
		});
		expect(mayStart(halfDay, 300 * MINUTE)).toEqual({
			ok: false,
			message: "This day has 0:00 left.",
		});
	});

	it("allows any day without a limit, whatever it holds", () => {
		expect(mayStart(dayLimit(calendar(), TUESDAY), 20 * HOUR)).toEqual({ ok: true });
		expect(mayStart(dayLimit(calendar(), SATURDAY), 0)).toEqual({ ok: true });
	});
});

describe("notice for leave", () => {
	const kind = (key: KindKey, noticeDays = DEFAULT_NOTICE_DAYS[key]) => ({ key, noticeDays });

	it("asks by default 14 days for annual and unpaid, 28 for study, 56 for parental, none for sick and holidays", () => {
		expect(DEFAULT_NOTICE_DAYS).toEqual({
			annual: 14,
			sick: 0,
			study: 28,
			parental: 56,
			unpaid: 14,
			holiday: 0,
		});
	});

	it("counts the days from the day asked to the first day, negative once it has begun", () => {
		expect(noticeGiven(WEDNESDAY, WEDNESDAY)).toBe(0);
		expect(noticeGiven(WEDNESDAY, "2026-11-25")).toBe(14);
		expect(noticeGiven(WEDNESDAY, TUESDAY)).toBe(-1);
		// Across a clock change and a year's end, days are days.
		expect(noticeGiven("2026-03-20", "2026-04-03")).toBe(14);
		expect(noticeGiven("2026-10-20", "2026-11-03")).toBe(14);
		expect(noticeGiven("2026-12-31", "2027-01-01")).toBe(1);
	});

	it.each([
		["annual", 14],
		["unpaid", 14],
		["study", 28],
		["parental", 56],
	] as const)("is short for %s leave a day under %i days, and not at it", (key, days) => {
		expect(isShortNotice(kind(key), WEDNESDAY, addDays(WEDNESDAY, days - 1))).toBe(true);
		expect(isShortNotice(kind(key), WEDNESDAY, addDays(WEDNESDAY, days))).toBe(false);
		expect(isShortNotice(kind(key), WEDNESDAY, addDays(WEDNESDAY, days + 30))).toBe(false);
		// Leave already begun is short notice too.
		expect(isShortNotice(kind(key), WEDNESDAY, TUESDAY)).toBe(true);
	});

	it.each(["sick", "holiday"] as const)(
		"is never short for %s, whatever notice is stored for it",
		(key) => {
			for (const noticeDays of [0, 14, 365]) {
				for (const startsOn of [TUESDAY, WEDNESDAY, "2026-11-12"]) {
					expect(isShortNotice(kind(key, noticeDays), WEDNESDAY, startsOn)).toBe(false);
				}
				expect(earliestNoticed(kind(key, noticeDays), WEDNESDAY)).toBe(WEDNESDAY);
			}
		},
	);

	it("is never short for a kind that asks for none", () => {
		expect(isShortNotice(kind("annual", 0), WEDNESDAY, WEDNESDAY)).toBe(false);
	});

	it("gives the earliest well-noticed first day", () => {
		expect(earliestNoticed(kind("annual"), WEDNESDAY)).toBe("2026-11-25");
		expect(earliestNoticed(kind("unpaid"), WEDNESDAY)).toBe("2026-11-25");
		expect(earliestNoticed(kind("study"), WEDNESDAY)).toBe("2026-12-09");
		expect(earliestNoticed(kind("parental"), WEDNESDAY)).toBe("2027-01-06");
		for (const key of KIND_KEYS) {
			const earliest = earliestNoticed(kind(key), WEDNESDAY);
			expect(isShortNotice(kind(key), WEDNESDAY, earliest), key).toBe(false);
			if (earliest > WEDNESDAY) {
				expect(isShortNotice(kind(key), WEDNESDAY, addDays(earliest, -1)), key).toBe(true);
			}
		}
	});

	it("reads as an approver reads it", () => {
		expect(noticeLabel({ noticeDays: 3, shortNotice: true })).toBe("Short notice (3 days)");
		expect(noticeLabel({ noticeDays: 1, shortNotice: true })).toBe("Short notice (1 day)");
		expect(noticeLabel({ noticeDays: -2, shortNotice: true })).toBe("Short notice (0 days)");
		expect(noticeLabel({ noticeDays: 14, shortNotice: false })).toBe("14 days' notice");
		expect(noticeLabel({ noticeDays: 1, shortNotice: false })).toBe("1 day's notice");
		expect(noticeLabel({ noticeDays: 0, shortNotice: false })).toBe("0 days' notice");
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

describe("a property of every calendar, rule and day", () => {
	const CASES = 600;
	const WEEK_MINUTES = [0, 0, 240, 450, 451, 465, 480];
	const STATUSES: LeaveStatus[] = ["approved", "approved", "pending", "refused", "withdrawn"];
	const ORIGIN = "2026-03-01";
	const SPAN_DAYS = 300;

	/** One random person's calendar and one of their days, from `seed`. */
	function scenario(seed: number) {
		const next = random(seed);
		const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)] as T;
		const int = (below: number) => Math.floor(next() * below);
		const dayIn = () => addDays(ORIGIN, int(SPAN_DAYS));
		const week = Array.from({ length: 7 }, () => pick(WEEK_MINUTES));
		const holidays: Record<Day, string> = {};
		for (let i = int(10); i > 0; i--) holidays[dayIn()] = "Holiday";
		const requests = Array.from({ length: int(6) }, () => {
			const startsOn = dayIn();
			const endsOn = addDays(startsOn, int(12));
			return leave(startsOn, endsOn, {
				status: pick(STATUSES),
				startsHalf: next() < 0.4,
				endsHalf: endsOn > startsOn && next() < 0.4,
			});
		});
		const approved = Array.from({ length: int(8) }, () => {
			const startsOn = dayIn();
			return work(
				pick(["overtime", "weekend"] as const),
				startsOn,
				addDays(startsOn, int(10)),
				15 + int(MOST_WORK_MINUTES_A_DAY - 14),
				pick(STATUSES),
			);
		});
		const rules: Pick<TimesheetRules, "overtime" | "weekend"> = {
			overtime: pick(RULES),
			weekend: pick(RULES),
		};
		const theirs = calendar({ week, holidays, requests, approved, ...rules });
		// Mostly days near the requests, so that many are leave or approved work.
		const near = [...requests, ...approved].map((request) => request.startsOn);
		const day = next() < 0.5 && near.length > 0 ? pick(near) : dayIn();
		/** Up to 20 hours, with seconds. */
		const ms = () => int(20 * HOUR);
		return { theirs, day, ms, int, next };
	}

	/** Runs `check` for each seed, naming the seed of a failure. */
	function forEverySeed(check: (seed: number) => void) {
		for (let seed = 0; seed < CASES; seed++) {
			try {
				check(seed);
			} catch (error) {
				throw new Error(`seed ${seed}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	it("a day's limit is 0 exactly when it is closed, and never below 0", () => {
		forEverySeed((seed) => {
			const { theirs, day } = scenario(seed);
			const limit = dayLimit(theirs, day);
			expect(limit.limitMinutes === 0).toBe(limit.closed !== null);
			if (limit.limitMinutes !== null) expect(limit.limitMinutes).toBeGreaterThanOrEqual(0);
			expect(limit.approvedMinutes).toBeGreaterThanOrEqual(0);
			if (limit.limitMinutes !== null) {
				expect(limit.approvedMinutes).toBeLessThanOrEqual(limit.limitMinutes);
			}
			const [rule] = dayRules(theirs, [day], () => 0);
			expect(rule?.closedReason === null).toBe(limit.closed === null);
		});
	});

	it("what is left and over is never below 0, and what is left and tracked fit in the limit", () => {
		forEverySeed((seed) => {
			const { theirs, day, ms } = scenario(10_000 + seed);
			const limit = dayLimit(theirs, day);
			const tracked = ms();
			const left = minutesLeft(limit, tracked);
			const over = minutesOver(limit, tracked);
			expect(over).toBeGreaterThanOrEqual(0);
			if (limit.limitMinutes === null) {
				expect(left).toBeNull();
				expect(over).toBe(0);
				return;
			}
			expect(left).not.toBeNull();
			expect(left ?? -1).toBeGreaterThanOrEqual(0);
			if (over === 0) {
				expect((left ?? 0) + wholeMinutes(tracked)).toBeLessThanOrEqual(limit.limitMinutes);
			} else {
				expect(left).toBe(0);
				expect(wholeMinutes(tracked)).toBe(limit.limitMinutes + over);
			}
		});
	});

	it("a change that adds time is never accepted when it leaves the day over", () => {
		forEverySeed((seed) => {
			const { theirs, day, ms } = scenario(20_000 + seed);
			const limit: DayLimit = dayLimit(theirs, day);
			const othersMs = ms();
			const beforeMs = ms();
			const afterMs = beforeMs + 1 + ms();
			const verdict = mayWrite(limit, { othersMs, beforeMs, afterMs });
			if (verdict.ok) {
				expect(limit.closed).toBeNull();
				expect(minutesOver(limit, othersMs + afterMs)).toBe(0);
			} else {
				expect(verdict.message).toBe(
					limit.closed
						? closedReason(limit.closed, day)
						: leftMessage(minutesLeft(limit, othersMs) ?? 0),
				);
			}
		});
	});

	it("a change that adds nothing is always accepted", () => {
		forEverySeed((seed) => {
			const { theirs, day, ms, int } = scenario(30_000 + seed);
			const limit = dayLimit(theirs, day);
			const beforeMs = ms();
			const afterMs = Math.max(0, beforeMs - int(beforeMs + 1));
			expect(mayWrite(limit, { othersMs: ms(), beforeMs, afterMs })).toEqual({ ok: true });
		});
	});

	it("a timer starts only where one more whole minute fits", () => {
		forEverySeed((seed) => {
			const { theirs, day, ms } = scenario(40_000 + seed);
			const limit = dayLimit(theirs, day);
			const tracked = ms();
			const started = mayStart(limit, tracked).ok;
			if (limit.limitMinutes === null) expect(started).toBe(!limit.closed);
			else expect(started).toBe(!limit.closed && (minutesLeft(limit, tracked) ?? 0) > 0);
		});
	});
});
