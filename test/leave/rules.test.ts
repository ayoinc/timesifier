import { describe, expect, it } from "vitest";
import { DEFAULT_WORKING_WEEK, type LeaveRequestLike, type WorkingWeek } from "~/leave/days";
import { KIND_KEYS, type KindKey, type LeaveStatus } from "~/leave/kinds";
import {
	closedReason,
	DEFAULT_NOTICE_DAYS,
	DEFAULT_RULES,
	dayLimit,
	dayRules,
	earliestNoticed,
	isShortNotice,
	type KindsMs,
	kindOfNewTime,
	leftMessage,
	MOST_WORK_MINUTES_A_DAY,
	mayAskFor,
	mayStart,
	mayWrite,
	minutesLeft,
	minutesOver,
	NON_WORKING_RULES,
	type NonWorkingRule,
	noticeGiven,
	noticeLabel,
	OVERTIME_RULES,
	type OvertimeRule,
	overLabel,
	overtimeAllowance,
	type RulesCalendar,
	splitAtLimit,
	type WorkKind,
	type WorkRequestLike,
	wholeMinutes,
} from "~/leave/rules";
import { addDays, bounds, type Day, dayOf, instantAt } from "~/time/calendar";

// The rules of leave and tracked time together (TS-090), with a day's
// expected hours as its ceiling and overtime recorded as such (TS-095),
// without the database: how much regular time and overtime a day of a person
// takes, whether a change or a timer fits in it, where a timer is cut at the
// limit, and whether leave was asked for in good time.

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
	overtime = "none",
	weekend = "overtime",
	dayCap = null,
	weekCap = null,
	approved = [],
}: {
	week?: WorkingWeek;
	holidays?: Record<Day, string>;
	requests?: LeaveRequestLike[];
	overtime?: OvertimeRule;
	weekend?: NonWorkingRule;
	dayCap?: number | null;
	weekCap?: number | null;
	approved?: WorkRequestLike[];
} = {}): RulesCalendar {
	return {
		week,
		holidays: new Map(Object.entries(holidays)),
		leave: requests,
		rules: { overtime, weekend, overtimeDayCap: dayCap, overtimeWeekCap: weekCap, weekStartsOn: 1 },
		work: approved,
	};
}

/** The limit of `day` alone, without the status it was read from. */
function limitOf(theirs: RulesCalendar, day: Day) {
	const { regularMinutes, overtimeMinutes, noOvertime, closed, approvedMinutes } = dayLimit(
		theirs,
		day,
	);
	return { regularMinutes, overtimeMinutes, noOvertime, closed, approvedMinutes };
}

/** Time of each kind, in whole minutes. */
const kinds = (regular: number, overtime = 0): KindsMs => ({
	regularMs: regular * MINUTE,
	overtimeMs: overtime * MINUTE,
});

/** A change of one kind on a day, with nothing else in its week. */
function change(
	overtime: boolean,
	othersMinutes: number,
	afterMinutes: number,
	week: { before?: number; after?: number; beforeMinutes?: number } = {},
) {
	return {
		overtime,
		othersMs: othersMinutes * MINUTE,
		beforeMs: (week.beforeMinutes ?? 0) * MINUTE,
		afterMs: afterMinutes * MINUTE,
		weekOvertimeBefore: week.before ?? 0,
		weekOvertimeAfter: week.after ?? 0,
	};
}

describe("what an organisation starts with", () => {
	it("is no overtime, time on a day not worked counted as overtime, no caps", () => {
		expect(DEFAULT_RULES).toEqual({
			overtime: "none",
			weekend: "overtime",
			overtimeDayCap: null,
			overtimeWeekCap: null,
			shortNotice: "with-reason",
		});
	});
});

describe("a working day", () => {
	it("takes its expected hours as regular time and, by default, no overtime", () => {
		expect(limitOf(calendar(), TUESDAY)).toEqual({
			regularMinutes: 450,
			overtimeMinutes: 0,
			noOvertime: "not-allowed",
			closed: null,
			approvedMinutes: 0,
		});
		// Approved overtime changes nothing while overtime is not allowed.
		expect(
			limitOf(calendar({ approved: [work("overtime", TUESDAY, TUESDAY, 60)] }), TUESDAY),
		).toMatchObject({ overtimeMinutes: 0, noOvertime: "not-allowed", approvedMinutes: 60 });
	});

	it("takes any overtime while it is allowed, or up to the day's cap", () => {
		expect(limitOf(calendar({ overtime: "allowed" }), TUESDAY)).toMatchObject({
			regularMinutes: 450,
			overtimeMinutes: null,
			noOvertime: null,
		});
		expect(limitOf(calendar({ overtime: "allowed", dayCap: 120 }), TUESDAY)).toMatchObject({
			regularMinutes: 450,
			overtimeMinutes: 120,
			noOvertime: null,
		});
	});

	it("with pre-approval, takes the approved overtime, two requests added up, held by the day's cap", () => {
		expect(limitOf(calendar({ overtime: "approval" }), TUESDAY)).toMatchObject({
			overtimeMinutes: 0,
			noOvertime: "needs-approval",
		});
		const approved = [
			work("overtime", MONDAY, WEDNESDAY, 60),
			work("overtime", TUESDAY, TUESDAY, 30),
			// Weekend work is for days the week does not work.
			work("weekend", TUESDAY, TUESDAY, 240),
		];
		expect(limitOf(calendar({ overtime: "approval", approved }), TUESDAY)).toMatchObject({
			regularMinutes: 450,
			overtimeMinutes: 90,
			noOvertime: null,
			approvedMinutes: 90,
		});
		expect(
			limitOf(calendar({ overtime: "approval", approved, dayCap: 60 }), TUESDAY).overtimeMinutes,
		).toBe(60);
		expect(limitOf(calendar({ overtime: "approval", approved }), MONDAY).overtimeMinutes).toBe(60);
	});

	it.each(["pending", "refused", "withdrawn", "cancelled"] as const)(
		"counts no %s overtime",
		(status) => {
			const theirs = calendar({
				overtime: "approval",
				approved: [work("overtime", TUESDAY, TUESDAY, 60, status)],
			});
			expect(limitOf(theirs, TUESDAY)).toMatchObject({
				overtimeMinutes: 0,
				noOvertime: "needs-approval",
				approvedMinutes: 0,
			});
		},
	);

	it("follows the week: a longer day expects more", () => {
		const week: WorkingWeek = [465, 450, 450, 450, 450, 0, 0];
		expect(dayLimit(calendar({ week }), MONDAY).regularMinutes).toBe(465);
	});
});

describe("a day of half-day leave", () => {
	const halfDay = [leave(TUESDAY, TUESDAY, { startsHalf: true })];

	it.each(OVERTIME_RULES)(
		"takes the other half, 3:45 of 7:30, as regular time (overtime %s)",
		(overtime) => {
			expect(dayLimit(calendar({ requests: halfDay, overtime }), TUESDAY).regularMinutes).toBe(225);
		},
	);

	it("takes overtime as a working day does", () => {
		expect(limitOf(calendar({ requests: halfDay }), TUESDAY).noOvertime).toBe("not-allowed");
		expect(
			limitOf(calendar({ requests: halfDay, overtime: "allowed" }), TUESDAY).overtimeMinutes,
		).toBeNull();
		expect(
			limitOf(
				calendar({
					requests: halfDay,
					overtime: "approval",
					approved: [work("overtime", TUESDAY, TUESDAY, 45)],
				}),
				TUESDAY,
			).overtimeMinutes,
		).toBe(45);
	});

	it("is the half of the last day of a longer span, and an odd day's half is floored", () => {
		const week: WorkingWeek = [451, 451, 451, 451, 451, 0, 0];
		const span = [leave(MONDAY, WEDNESDAY, { endsHalf: true })];
		expect(dayLimit(calendar({ week, requests: span }), WEDNESDAY).regularMinutes).toBe(225);
		expect(dayLimit(calendar({ week, requests: span }), TUESDAY).closed).toEqual({
			why: "leave",
			kindName: "Annual leave",
		});
	});

	it("is not leave while the request is not approved", () => {
		const pending = [leave(TUESDAY, TUESDAY, { startsHalf: true, status: "pending" })];
		expect(dayLimit(calendar({ requests: pending }), TUESDAY).regularMinutes).toBe(450);
	});
});

describe("a closed day", () => {
	it.each(OVERTIME_RULES)("is whole-day leave, with its kind named (overtime %s)", (overtime) => {
		const theirs = calendar({
			overtime,
			requests: [leave(TUESDAY, TUESDAY, { kindName: "Sick leave" })],
			approved: [work("overtime", TUESDAY, TUESDAY, 120)],
		});
		expect(limitOf(theirs, TUESDAY)).toEqual({
			regularMinutes: 0,
			overtimeMinutes: 0,
			noOvertime: null,
			closed: { why: "leave", kindName: "Sick leave" },
			approvedMinutes: 0,
		});
	});

	it.each(NON_WORKING_RULES)("is a public holiday, by its name (weekend %s)", (weekend) => {
		const theirs = calendar({
			weekend,
			overtime: "allowed",
			holidays: { [CHRISTMAS]: "Christmas Day" },
		});
		expect(limitOf(theirs, CHRISTMAS)).toMatchObject({
			regularMinutes: 0,
			overtimeMinutes: 0,
			closed: { why: "holiday", name: "Christmas Day" },
		});
	});

	it("is a day the week does not work, where the organisation allows no time on it", () => {
		for (const overtime of OVERTIME_RULES) {
			const theirs = calendar({
				overtime,
				weekend: "none",
				approved: [work("weekend", SATURDAY, SATURDAY, 240)],
			});
			expect(limitOf(theirs, SATURDAY).closed).toEqual({ why: "weekend-not-allowed" });
		}
	});

	it("says why in each case", () => {
		expect(closedReason({ why: "holiday", name: "Christmas Day" }, CHRISTMAS)).toBe(
			"Christmas Day is a public holiday: no time can be tracked on it.",
		);
		expect(closedReason({ why: "leave", kindName: "Annual leave" }, TUESDAY)).toBe(
			"You are on annual leave that day: no time can be tracked on it.",
		);
		expect(closedReason({ why: "weekend-not-allowed" }, SATURDAY)).toBe(
			"Saturday is not a working day, and this organisation does not allow time on it.",
		);
	});
});

describe("a day the week does not work", () => {
	it("takes no regular time: all its time is overtime, as the overtime rule says", () => {
		expect(limitOf(calendar(), SATURDAY)).toMatchObject({
			regularMinutes: 0,
			overtimeMinutes: 0,
			noOvertime: "not-allowed",
			closed: null,
		});
		expect(limitOf(calendar({ overtime: "allowed", dayCap: 300 }), SUNDAY)).toMatchObject({
			regularMinutes: 0,
			overtimeMinutes: 300,
			noOvertime: null,
		});
	});

	it("with pre-approval, takes the approved weekend work and not approved overtime", () => {
		const theirs = (approved: WorkRequestLike[]) => calendar({ overtime: "approval", approved });
		expect(limitOf(theirs([work("overtime", SATURDAY, SATURDAY, 120)]), SATURDAY)).toMatchObject({
			overtimeMinutes: 0,
			noOvertime: "weekend-needs-approval",
		});
		expect(limitOf(theirs([work("weekend", SATURDAY, SUNDAY, 240)]), SUNDAY)).toMatchObject({
			overtimeMinutes: 240,
			noOvertime: null,
			approvedMinutes: 240,
		});
	});

	it("is any day the week does not work, a weekday too", () => {
		const week: WorkingWeek = [450, 450, 0, 450, 450, 0, 0];
		expect(limitOf(calendar({ week, overtime: "allowed" }), WEDNESDAY)).toMatchObject({
			regularMinutes: 0,
			overtimeMinutes: null,
		});
	});
});

describe("the days around a clock change in London", () => {
	/** An entry from `from`, as an instant, for `minutes`, regular or overtime. */
	const entry = (from: string, minutes: number, overtime = false) => ({
		startedAt: Date.parse(from),
		endedAt: Date.parse(from) + minutes * MINUTE,
		overtime,
	});
	/** What the Timesheet adds up on `day`: entries that start on it in London, by kind. */
	const trackedIn =
		(entries: { startedAt: number; endedAt: number; overtime: boolean }[]) =>
		(day: Day): KindsMs => {
			const sum = { regularMs: 0, overtimeMs: 0 };
			for (const each of entries) {
				if (dayOf(each.startedAt, LONDON) !== day) continue;
				if (each.overtime) sum.overtimeMs += each.endedAt - each.startedAt;
				else sum.regularMs += each.endedAt - each.startedAt;
			}
			return sum;
		};

	it.each([
		// The clocks go forward at 01:00 GMT: the 29th has 23 hours.
		["forward", "2026-03-29", 23, "2026-03-28T23:30:00Z", "2026-03-29T23:30:00Z"],
		// The clocks go back at 01:00 GMT: the 25th has 25 hours.
		["back", "2026-10-25", 25, "2026-10-24T23:30:00Z", "2026-10-25T23:30:00Z"],
	])(
		"the clocks going %s on %s leave its regular time 7:30, and each entry on the day it starts there",
		(_, day, hours, aroundStart, aroundEnd) => {
			const { from, to } = bounds(day, day, LONDON);
			expect((to - from) / HOUR).toBe(hours);
			const theirs = calendar({ week: EVERY_DAY, overtime: "allowed", dayCap: 60 });

			// 23:30 UTC is 00:30 the next day in summer time, and 23:30 the same day in winter.
			const before = dayOf(Date.parse(aroundStart), LONDON);
			const after = dayOf(Date.parse(aroundEnd), LONDON);
			expect([before, after]).toEqual(
				day === "2026-03-29" ? [addDays(day, -1), addDays(day, 1)] : [day, day],
			);

			// 7:30 from the day's first instant: the whole of its regular time,
			// whatever the day's length, then an hour of overtime each side.
			const entries = [
				entry(new Date(from).toISOString(), 450),
				entry(aroundStart, 60, true),
				entry(aroundEnd, 60, true),
			];
			const rules = dayRules(theirs, [addDays(day, -1), day, addDays(day, 1)], trackedIn(entries));
			const onDay = (each: Day) => rules.find((rule) => rule.day === each);
			const overtime = (each: Day) => (before === each ? 60 : 0) + (after === each ? 60 : 0);
			for (const each of [addDays(day, -1), day, addDays(day, 1)]) {
				expect(onDay(each)?.limitMinutes, each).toBe(450);
				expect(onDay(each)?.regularMinutes, each).toBe(each === day ? 450 : 0);
				expect(onDay(each)?.overtimeMinutes, each).toBe(overtime(each));
				expect(onDay(each)?.overMinutes, each).toBe(Math.max(0, overtime(each) - 60));
			}
		},
	);
});

describe("the rules of each day as the Timesheet shows them", () => {
	it("hold the limits, the reasons, what is tracked of each kind, left and over, and approved work", () => {
		const theirs = calendar({
			overtime: "approval",
			holidays: { [MONDAY]: "Company Day" },
			requests: [leave(WEDNESDAY, WEDNESDAY, { startsHalf: true })],
			approved: [work("overtime", TUESDAY, TUESDAY, 60)],
		});
		const tracked: Record<Day, KindsMs> = {
			[TUESDAY]: kinds(450, 90),
			[WEDNESDAY]: kinds(200),
			[SATURDAY]: kinds(0, 30),
		};
		const rules = dayRules(
			theirs,
			[MONDAY, TUESDAY, WEDNESDAY, SATURDAY],
			(day) => tracked[day] ?? kinds(0),
		);
		expect(rules).toEqual([
			{
				day: MONDAY,
				limitMinutes: 0,
				closedReason: "Company Day is a public holiday: no time can be tracked on it.",
				trackedMinutes: 0,
				regularMinutes: 0,
				overtimeMinutes: 0,
				leftMinutes: 0,
				overtimeOpen: false,
				overtimeLeftMinutes: 0,
				noOvertimeReason: null,
				overMinutes: 0,
				approvedMinutes: 0,
			},
			{
				day: TUESDAY,
				limitMinutes: 450,
				closedReason: null,
				trackedMinutes: 540,
				regularMinutes: 450,
				overtimeMinutes: 90,
				leftMinutes: 0,
				overtimeOpen: true,
				overtimeLeftMinutes: 0,
				noOvertimeReason: null,
				overMinutes: 30,
				approvedMinutes: 60,
			},
			{
				day: WEDNESDAY,
				limitMinutes: 225,
				closedReason: null,
				trackedMinutes: 200,
				regularMinutes: 200,
				overtimeMinutes: 0,
				leftMinutes: 25,
				overtimeOpen: false,
				overtimeLeftMinutes: 0,
				noOvertimeReason: "Overtime on this day needs pre-approval. Request it on Time off.",
				overMinutes: 0,
				approvedMinutes: 0,
			},
			{
				day: SATURDAY,
				limitMinutes: 0,
				closedReason: null,
				trackedMinutes: 30,
				regularMinutes: 0,
				overtimeMinutes: 30,
				leftMinutes: 0,
				overtimeOpen: false,
				overtimeLeftMinutes: 0,
				noOvertimeReason:
					"Saturday is not a working day: time on it needs approved weekend work. Request it on Time off.",
				overMinutes: 30,
				approvedMinutes: 0,
			},
		]);
	});

	it("count the week's cap from the first day of the organisation's week", () => {
		const theirs = calendar({ overtime: "allowed", dayCap: 120, weekCap: 180 });
		const tracked: Record<Day, KindsMs> = {
			[MONDAY]: kinds(450, 120),
			[TUESDAY]: kinds(450, 90),
			[WEDNESDAY]: kinds(450, 30),
		};
		const rules = dayRules(theirs, [TUESDAY, WEDNESDAY], (day) => tracked[day] ?? kinds(0));
		// Tuesday may take 60 of the week's 180 after Monday's 120: it holds 90.
		expect(rules[0]).toMatchObject({ overtimeLeftMinutes: 0, overMinutes: 30 });
		// Wednesday may take none after Monday's and Tuesday's 210.
		expect(rules[1]).toMatchObject({ overtimeLeftMinutes: 0, overMinutes: 30 });
		// The next week starts afresh.
		const next = dayRules(theirs, ["2026-11-16"], () => kinds(450, 60));
		expect(next[0]).toMatchObject({ overtimeLeftMinutes: 60, overMinutes: 0 });
	});

	it("never flag a day over for overtime while it has no cap", () => {
		const [rule] = dayRules(calendar({ overtime: "allowed" }), [TUESDAY], () => kinds(450, 600));
		expect(rule).toMatchObject({ overtimeLeftMinutes: null, overMinutes: 0, leftMinutes: 0 });
	});
});

describe("minutes left and over", () => {
	const limit = { regularMinutes: 450 };

	it("drop the seconds, as the Timesheet does", () => {
		expect(minutesLeft(limit, 449 * MINUTE + 59_999)).toBe(0);
		expect(minutesLeft(limit, 449 * MINUTE)).toBe(1);
		expect(minutesOver(limit, { regularMs: 450 * MINUTE + 59_999, overtimeMs: 0 }, 0)).toBe(0);
		expect(minutesOver(limit, { regularMs: 451 * MINUTE, overtimeMs: 0 }, 0)).toBe(1);
	});

	it("count overtime past the day's allowance, and none while there is no limit", () => {
		expect(minutesOver(limit, kinds(460, 70), 60)).toBe(20);
		expect(minutesOver(limit, kinds(450, 700), null)).toBe(0);
		expect(minutesOver({ regularMinutes: 0 }, kinds(0, 30), 0)).toBe(30);
	});

	it("read as words", () => {
		expect(leftMessage(225)).toBe("This day has 3:45 left.");
		expect(leftMessage(0)).toBe("This day has 0:00 left.");
		expect(overLabel(15)).toBe("Over by 0:15");
	});
});

describe("whether a change may be written", () => {
	const rules = { overtimeWeekCap: null };

	it("always allows a change that adds nothing, even on a closed day or one over", () => {
		const closed = dayLimit(calendar({ holidays: { [TUESDAY]: "Company Day" } }), TUESDAY);
		const open = dayLimit(calendar(), TUESDAY);
		expect(mayWrite(closed, rules, change(false, 0, 60, { beforeMinutes: 60 }))).toEqual({
			ok: true,
		});
		expect(mayWrite(open, rules, change(false, 600, 30, { beforeMinutes: 60 }))).toEqual({
			ok: true,
		});
		expect(mayWrite(open, rules, change(true, 600, 30, { beforeMinutes: 60 }))).toEqual({
			ok: true,
		});
	});

	it("refuses any time on a closed day with the reason", () => {
		const closed = dayLimit(
			calendar({ requests: [leave(TUESDAY, TUESDAY)], overtime: "allowed" }),
			TUESDAY,
		);
		for (const overtime of [false, true]) {
			expect(mayWrite(closed, rules, change(overtime, 0, 1))).toEqual({
				ok: false,
				message: "You are on annual leave that day: no time can be tracked on it.",
			});
		}
	});

	it("takes regular time exactly up to the expected hours, and refuses a minute more with what is left", () => {
		const none = dayLimit(calendar(), TUESDAY);
		expect(mayWrite(none, rules, change(false, 400, 50))).toEqual({ ok: true });
		expect(mayWrite(none, rules, change(false, 400, 51))).toEqual({
			ok: false,
			message: "This day has 0:50 left.",
		});
		expect(mayWrite(none, rules, change(false, 450, 1))).toEqual({
			ok: false,
			message: "This day has 0:00 left.",
		});
		// Where overtime is to be had, the refusal says where more goes.
		const allowed = dayLimit(calendar({ overtime: "allowed" }), TUESDAY);
		expect(mayWrite(allowed, rules, change(false, 450, 1))).toEqual({
			ok: false,
			message: "This day has 0:00 left. Track more as overtime.",
		});
		const approval = dayLimit(calendar({ overtime: "approval" }), TUESDAY);
		expect(mayWrite(approval, rules, change(false, 390, 61))).toEqual({
			ok: false,
			message:
				"This day has 1:00 left. Overtime on this day needs pre-approval. Request it on Time off.",
		});
	});

	it("counts whole minutes: seconds within the last minute fit", () => {
		const limit = dayLimit(calendar(), TUESDAY);
		const tight = { ...change(false, 0, 0), othersMs: 449 * MINUTE + 30_000, afterMs: 30_000 };
		expect(mayWrite(limit, rules, tight)).toEqual({ ok: true });
	});

	it("lets an entry grow into what is left, the entry itself not counted as other time", () => {
		const limit = dayLimit(calendar(), TUESDAY);
		expect(mayWrite(limit, rules, change(false, 300, 150, { beforeMinutes: 100 }))).toEqual({
			ok: true,
		});
	});

	it("refuses overtime where it is not allowed or not approved, with the reason", () => {
		expect(mayWrite(dayLimit(calendar(), TUESDAY), rules, change(true, 0, 1))).toEqual({
			ok: false,
			message: "This organisation does not allow overtime.",
		});
		expect(
			mayWrite(dayLimit(calendar({ overtime: "approval" }), TUESDAY), rules, change(true, 0, 1)),
		).toEqual({
			ok: false,
			message: "Overtime on this day needs pre-approval. Request it on Time off.",
		});
		expect(mayWrite(dayLimit(calendar(), SATURDAY), rules, change(false, 0, 1))).toEqual({
			ok: false,
			message: "Saturday is not a working day, and this organisation does not allow overtime.",
		});
		expect(
			mayWrite(dayLimit(calendar({ overtime: "allowed" }), SATURDAY), rules, change(false, 0, 1)),
		).toEqual({ ok: false, message: "Saturday is not a working day: track its time as overtime." });
	});

	it("takes overtime up to the approved hours, the day's cap and the week's cap", () => {
		const approved = dayLimit(
			calendar({ overtime: "approval", approved: [work("overtime", TUESDAY, TUESDAY, 90)] }),
			TUESDAY,
		);
		expect(mayWrite(approved, rules, change(true, 30, 60))).toEqual({ ok: true });
		expect(mayWrite(approved, rules, change(true, 30, 61))).toEqual({
			ok: false,
			message: "This day has 1:00 of overtime left.",
		});
		const capped = dayLimit(calendar({ overtime: "allowed", dayCap: 120 }), TUESDAY);
		expect(mayWrite(capped, rules, change(true, 0, 120))).toEqual({ ok: true });
		expect(mayWrite(capped, rules, change(true, 0, 121)).ok).toBe(false);
		// The week's 300 less 200 before the day and 40 after it leaves 60.
		const weekly = { overtimeWeekCap: 300 };
		expect(mayWrite(capped, weekly, change(true, 0, 60, { before: 200, after: 40 }))).toEqual({
			ok: true,
		});
		expect(mayWrite(capped, weekly, change(true, 0, 61, { before: 200, after: 40 }))).toEqual({
			ok: false,
			message: "This week has 1:00 of overtime left.",
		});
		// No cap at all takes anything.
		const free = dayLimit(calendar({ overtime: "allowed" }), TUESDAY);
		expect(mayWrite(free, rules, change(true, 600, 600))).toEqual({ ok: true });
	});
});

describe("whether a timer may start", () => {
	it("refuses a closed day with its reason", () => {
		const limit = dayLimit(calendar({ holidays: { [TUESDAY]: "Company Day" } }), TUESDAY);
		expect(mayStart(limit, 0, null)).toEqual({
			ok: false,
			message: "Company Day is a public holiday: no time can be tracked on it.",
		});
	});

	it("starts while regular time is left, a part of a minute being nothing", () => {
		const limit = dayLimit(calendar(), TUESDAY);
		expect(mayStart(limit, 449 * MINUTE, 0)).toEqual({ ok: true });
		expect(mayStart(limit, 449 * MINUTE + 1, 0)).toEqual({
			ok: false,
			message: "This day has 0:00 left.",
		});
	});

	it("starts with no regular time left only where overtime is still to be had", () => {
		const allowed = dayLimit(calendar({ overtime: "allowed" }), TUESDAY);
		expect(mayStart(allowed, 450 * MINUTE, null)).toEqual({ ok: true });
		expect(mayStart(allowed, 450 * MINUTE, 30)).toEqual({ ok: true });
		expect(mayStart(allowed, 450 * MINUTE, 0).ok).toBe(false);
		const weekend = dayLimit(calendar({ overtime: "allowed" }), SATURDAY);
		expect(mayStart(weekend, 0, null)).toEqual({ ok: true });
		expect(mayStart(dayLimit(calendar(), SATURDAY), 0, 0)).toEqual({
			ok: false,
			message: "Saturday is not a working day, and this organisation does not allow overtime.",
		});
	});
});

describe("a timer cut at the day's limit", () => {
	const at = (iso: string) => Date.parse(iso);

	it("is not cut while it fits", () => {
		const entry = { startedAt: at("2026-11-10T09:00:00Z"), endedAt: at("2026-11-10T16:30:00Z") };
		expect(splitAtLimit(entry, 450 * MINUTE, true)).toEqual({
			overtime: false,
			overtimeFrom: null,
		});
	});

	it("is cut where the regular time was used, the rest overtime, where the day takes overtime", () => {
		const entry = { startedAt: at("2026-11-10T09:00:00Z"), endedAt: at("2026-11-10T18:00:00Z") };
		expect(splitAtLimit(entry, 450 * MINUTE, true)).toEqual({
			overtime: false,
			overtimeFrom: at("2026-11-10T16:30:00Z"),
		});
		// With an hour already tracked, the cut comes an hour sooner.
		expect(splitAtLimit(entry, 390 * MINUTE, true).overtimeFrom).toBe(at("2026-11-10T15:30:00Z"));
	});

	it("is all overtime once the day had no regular time left when it started", () => {
		const entry = { startedAt: at("2026-11-10T17:00:00Z"), endedAt: at("2026-11-10T18:00:00Z") };
		expect(splitAtLimit(entry, 0, true)).toEqual({ overtime: true, overtimeFrom: null });
		expect(splitAtLimit(entry, -30 * MINUTE, true)).toEqual({ overtime: true, overtimeFrom: null });
	});

	it("is kept whole as regular time where the day takes no overtime, and the day flagged over", () => {
		const entry = { startedAt: at("2026-11-10T09:00:00Z"), endedAt: at("2026-11-10T18:00:00Z") };
		expect(splitAtLimit(entry, 450 * MINUTE, false)).toEqual({
			overtime: false,
			overtimeFrom: null,
		});
		const [rule] = dayRules(calendar(), [TUESDAY], () => ({ regularMs: 9 * HOUR, overtimeMs: 0 }));
		expect(rule?.overMinutes).toBe(90);
	});

	it("is cut by elapsed time across midnight and the clocks changing", () => {
		// 20:00 to 04:00 the next day: 7:30 of it is regular, to 03:30.
		const night = { startedAt: at("2026-11-10T20:00:00Z"), endedAt: at("2026-11-11T04:00:00Z") };
		expect(splitAtLimit(night, 450 * MINUTE, true).overtimeFrom).toBe(at("2026-11-11T03:30:00Z"));
		// From midnight on the day the clocks go forward: 7:30 elapsed is 08:30 on the clock.
		const spring = instantAt("2026-03-29", 0, LONDON);
		const forward = { startedAt: spring, endedAt: spring + 9 * HOUR };
		const cut = splitAtLimit(forward, 450 * MINUTE, true).overtimeFrom ?? 0;
		expect(cut - spring).toBe(450 * MINUTE);
		expect(new Date(cut).toLocaleTimeString("en-GB", { timeZone: LONDON })).toBe("08:30:00");
		// And on the day they go back, 06:30 on the clock.
		const autumn = instantAt("2026-10-25", 0, LONDON);
		const back = splitAtLimit(
			{ startedAt: autumn, endedAt: autumn + 9 * HOUR },
			450 * MINUTE,
			true,
		);
		expect(new Date(back.overtimeFrom ?? 0).toLocaleTimeString("en-GB", { timeZone: LONDON })).toBe(
			"06:30:00",
		);
	});

	it("on a day of half-day leave, is cut after the other half", () => {
		const theirs = calendar({
			overtime: "allowed",
			requests: [leave(TUESDAY, TUESDAY, { endsHalf: true })],
		});
		const limit = dayLimit(theirs, TUESDAY);
		const entry = { startedAt: at("2026-11-10T09:00:00Z"), endedAt: at("2026-11-10T14:00:00Z") };
		expect(splitAtLimit(entry, limit.regularMinutes * MINUTE, true).overtimeFrom).toBe(
			at("2026-11-10T12:45:00Z"),
		);
	});
});

describe("of which kind new time is, as an import reads a row", () => {
	it("is regular while it fits, overtime past it where allowed, and refused otherwise", () => {
		const nothing = () => kinds(0);
		const full = (day: Day) => (day === TUESDAY ? kinds(450) : kinds(0));
		expect(kindOfNewTime(calendar(), TUESDAY, 450 * MINUTE, nothing)).toEqual({
			ok: true,
			overtime: false,
		});
		expect(kindOfNewTime(calendar(), TUESDAY, 60 * MINUTE, full)).toEqual({
			ok: false,
			message: "This day has 0:00 left.",
		});
		expect(kindOfNewTime(calendar({ overtime: "allowed" }), TUESDAY, 60 * MINUTE, full)).toEqual({
			ok: true,
			overtime: true,
		});
		// A row is never cut: one that does not fit whole is overtime whole.
		expect(
			kindOfNewTime(calendar({ overtime: "allowed" }), TUESDAY, 451 * MINUTE, nothing),
		).toEqual({ ok: true, overtime: true });
	});

	it("is held by the week's cap, counting the days before and after", () => {
		const theirs = calendar({ overtime: "allowed", weekCap: 120 });
		const tracked = (day: Day) =>
			day === MONDAY
				? kinds(450, 60)
				: day === WEDNESDAY
					? kinds(450, 30)
					: day === TUESDAY
						? kinds(450)
						: kinds(0);
		expect(kindOfNewTime(theirs, TUESDAY, 30 * MINUTE, tracked)).toEqual({
			ok: true,
			overtime: true,
		});
		expect(kindOfNewTime(theirs, TUESDAY, 31 * MINUTE, tracked)).toEqual({
			ok: false,
			message: "This week has 0:30 of overtime left.",
		});
	});
});

describe("asking for overtime and weekend work", () => {
	it("is open only while overtime needs pre-approval, and weekend work only while it counts as overtime", () => {
		expect(mayAskFor({ overtime: "approval", weekend: "overtime" }, "overtime")).toBe(true);
		expect(mayAskFor({ overtime: "approval", weekend: "overtime" }, "weekend")).toBe(true);
		expect(mayAskFor({ overtime: "approval", weekend: "none" }, "weekend")).toBe(false);
		for (const overtime of ["none", "allowed"] as const) {
			expect(mayAskFor({ overtime, weekend: "overtime" }, "overtime")).toBe(false);
			expect(mayAskFor({ overtime, weekend: "overtime" }, "weekend")).toBe(false);
		}
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
	const CAPS = [null, null, 0, 30, 60, 120, 600];
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
				endsHalf: next() < 0.4,
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
		const dayCap = pick(CAPS);
		const theirs = calendar({
			week,
			holidays,
			requests,
			approved,
			overtime: pick(OVERTIME_RULES),
			weekend: pick(NON_WORKING_RULES),
			dayCap: dayCap === 0 ? null : dayCap,
			weekCap: pick(CAPS) || null,
		});
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

	it("a closed day, or a day not worked, takes no regular time; a day taking no overtime has a reason or is closed", () => {
		forEverySeed((seed) => {
			const { theirs, day } = scenario(seed);
			const limit = dayLimit(theirs, day);
			expect(limit.regularMinutes).toBeGreaterThanOrEqual(0);
			if (limit.closed || limit.status.is.kind === "not-a-working-day") {
				expect(limit.regularMinutes).toBe(0);
			}
			if (limit.closed) expect(limit.overtimeMinutes).toBe(0);
			if (limit.noOvertime) expect(limit.overtimeMinutes).toBe(0);
			if (limit.overtimeMinutes === 0)
				expect(limit.closed !== null || limit.noOvertime !== null).toBe(true);
			if (theirs.rules.overtime === "none") expect(limit.overtimeMinutes).toBe(0);
			if (limit.overtimeMinutes !== null && theirs.rules.overtimeDayCap !== null) {
				expect(limit.overtimeMinutes).toBeLessThanOrEqual(theirs.rules.overtimeDayCap);
			}
			if (theirs.rules.overtime === "approval" && limit.overtimeMinutes !== null) {
				expect(limit.overtimeMinutes).toBeLessThanOrEqual(limit.approvedMinutes);
			}
			const [rule] = dayRules(theirs, [day], () => kinds(0));
			expect(rule?.closedReason === null).toBe(limit.closed === null);
			expect(rule?.overMinutes).toBe(0);
		});
	});

	it("what is left and over is never below 0, and a day not over holds no more regular time than it takes", () => {
		forEverySeed((seed) => {
			const { theirs, day, ms, int } = scenario(10_000 + seed);
			const limit = dayLimit(theirs, day);
			const tracked = { regularMs: ms(), overtimeMs: ms() };
			const allowance = overtimeAllowance(limit, theirs.rules, int(600));
			const left = minutesLeft(limit, tracked.regularMs);
			const over = minutesOver(limit, tracked, allowance);
			expect(left).toBeGreaterThanOrEqual(0);
			expect(over).toBeGreaterThanOrEqual(0);
			if (over === 0) {
				expect(left + wholeMinutes(tracked.regularMs)).toBeLessThanOrEqual(limit.regularMinutes);
				if (allowance !== null)
					expect(wholeMinutes(tracked.overtimeMs)).toBeLessThanOrEqual(allowance);
			}
			if (wholeMinutes(tracked.regularMs) > limit.regularMinutes) expect(left).toBe(0);
			expect(over).toBe(
				Math.max(0, wholeMinutes(tracked.regularMs) - limit.regularMinutes) +
					(allowance === null ? 0 : Math.max(0, wholeMinutes(tracked.overtimeMs) - allowance)),
			);
		});
	});

	it("a change that adds time is accepted only when its kind still fits, and never on a closed day", () => {
		forEverySeed((seed) => {
			const { theirs, day, ms, int, next } = scenario(20_000 + seed);
			const limit = dayLimit(theirs, day);
			const overtime = next() < 0.5;
			const othersMs = ms();
			const beforeMs = ms();
			const afterMs = beforeMs + 1 + ms();
			const before = int(600);
			const after = int(600);
			const verdict = mayWrite(limit, theirs.rules, {
				overtime,
				othersMs,
				beforeMs,
				afterMs,
				weekOvertimeBefore: before,
				weekOvertimeAfter: after,
			});
			if (!verdict.ok) {
				expect(verdict.message.length).toBeGreaterThan(0);
				return;
			}
			expect(limit.closed).toBeNull();
			const total = wholeMinutes(othersMs + afterMs);
			if (!overtime) {
				expect(total).toBeLessThanOrEqual(limit.regularMinutes);
				return;
			}
			expect(limit.noOvertime).toBeNull();
			if (limit.overtimeMinutes !== null) expect(total).toBeLessThanOrEqual(limit.overtimeMinutes);
			if (theirs.rules.overtimeWeekCap !== null) {
				expect(before + after + total).toBeLessThanOrEqual(theirs.rules.overtimeWeekCap);
			}
		});
	});

	it("a change that adds nothing is always accepted", () => {
		forEverySeed((seed) => {
			const { theirs, day, ms, int, next } = scenario(30_000 + seed);
			const limit = dayLimit(theirs, day);
			const beforeMs = ms();
			const afterMs = Math.max(0, beforeMs - int(beforeMs + 1));
			expect(
				mayWrite(limit, theirs.rules, {
					overtime: next() < 0.5,
					othersMs: ms(),
					beforeMs,
					afterMs,
					weekOvertimeBefore: int(900),
					weekOvertimeAfter: int(900),
				}),
			).toEqual({ ok: true });
		});
	});

	it("a timer starts only where a whole minute of regular time is left, or overtime is to be had", () => {
		forEverySeed((seed) => {
			const { theirs, day, ms, int, next } = scenario(40_000 + seed);
			const limit = dayLimit(theirs, day);
			const tracked = ms();
			const overtimeLeft = next() < 0.3 ? null : int(120);
			const started = mayStart(limit, tracked, overtimeLeft).ok;
			const regularLeft = !limit.closed && minutesLeft(limit, tracked) > 0;
			const overtimeOpen = !limit.closed && !limit.noOvertime && overtimeLeft !== 0;
			expect(started).toBe(regularLeft || overtimeOpen);
		});
	});

	it("a cut timer keeps all its time, its regular part no more than was left", () => {
		forEverySeed((seed) => {
			const { ms, int, next } = scenario(50_000 + seed);
			const startedAt = Date.parse("2026-03-28T20:00:00Z") + int(3 * 24) * HOUR + int(HOUR);
			const entry = { startedAt, endedAt: startedAt + ms() };
			const regularLeftMs = ms() - 4 * HOUR;
			const open = next() < 0.7;
			const cut = splitAtLimit(entry, regularLeftMs, open);
			const length = entry.endedAt - entry.startedAt;
			if (cut.overtimeFrom !== null) {
				expect(open).toBe(true);
				expect(cut.overtime).toBe(false);
				expect(cut.overtimeFrom).toBeGreaterThan(entry.startedAt);
				expect(cut.overtimeFrom).toBeLessThan(entry.endedAt);
				expect(cut.overtimeFrom - entry.startedAt).toBe(Math.max(0, regularLeftMs));
			} else if (cut.overtime) {
				expect(open).toBe(true);
				expect(regularLeftMs).toBeLessThanOrEqual(0);
				expect(length).toBeGreaterThan(0);
			} else {
				expect(!open || length <= Math.max(0, regularLeftMs)).toBe(true);
			}
		});
	});

	it("new time an import takes is of a kind that may be written", () => {
		forEverySeed((seed) => {
			const { theirs, day, ms } = scenario(60_000 + seed);
			const ofDay = { regularMs: ms(), overtimeMs: ms() };
			const added = 1 + ms();
			const kind = kindOfNewTime(theirs, day, added, (each) => (each === day ? ofDay : kinds(0)));
			if (!kind.ok) return;
			const verdict = mayWrite(dayLimit(theirs, day), theirs.rules, {
				overtime: kind.overtime,
				othersMs: kind.overtime ? ofDay.overtimeMs : ofDay.regularMs,
				beforeMs: 0,
				afterMs: added,
				weekOvertimeBefore: 0,
				weekOvertimeAfter: 0,
			});
			expect(verdict).toEqual({ ok: true });
		});
	});
});
