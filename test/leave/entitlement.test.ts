import { describe, expect, it } from "vitest";

import type { Contract, ContractVersion } from "~/contracts/contracts";
import { balance, type LeaveSpan } from "~/leave/days";
import {
	type ContractLeave,
	contractBalance,
	contractBalanceWords,
	entitlementOf,
	type LeaveYearSettings,
	leaveAmount,
	leavesGap,
	minutesFrom,
	shownInDays,
	USUAL_SETTINGS,
} from "~/leave/entitlement";
import type { LeaveStatus } from "~/leave/kinds";
import {
	CALENDAR_YEAR,
	LeaveYearStarts,
	leaveYear,
	leaveYearLabel,
	leaveYearOf,
} from "~/leave/years";
import { weekly } from "~/schedules/schedules";
import { addDays, type Day, daysFrom } from "~/time/calendar";
import { balanceOnMain } from "./main-balance";

// Annual leave from the contract (TS-098b, research/contracts-model.md
// section 3, decision 76), without the database: the leave year, the year's
// entitlement pro rata by version, minutes shown in days or hours, carry-over,
// and the days no contract covers. The server and the pages are
// test/pages/time-off.test.ts and test/pages/contracts.test.ts.

/** A seeded generator (mulberry32), so a failing case can be run again. */
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

/** Monday to Friday, 7:30 a day: 37:30 a week. */
const FULL_TIME = [450, 450, 450, 450, 450, 0, 0];
/** Monday to Wednesday, 7:30 a day: 22:30 a week. */
const THREE_DAYS = [450, 450, 450, 0, 0, 0, 0];
const DAY = 450;
/** The kind's allowance as every organisation starts: 25 days, in half days. */
const ALLOWANCE = 50;

function version(effectiveFrom: Day, more: Partial<ContractVersion> = {}): ContractVersion {
	return {
		id: `v-${effectiveFrom}`,
		effectiveFrom,
		jobTitle: null,
		scheduleId: null,
		payBasis: "yearly",
		payMinor: 3_000_000,
		currency: "GBP",
		overtimePay: "unpaid",
		overtimeMultiplierBp: null,
		restDayMultiplierBp: null,
		leaveDays: 25,
		carryOverDays: 0,
		carryOverExpiresAfterDays: null,
		...more,
	};
}

function contract(
	startsOn: Day,
	endsOn: Day | null,
	versions: ContractVersion[] = [version(startsOn)],
	more: Partial<Contract> = {},
): Contract {
	return {
		id: `c-${startsOn}`,
		userId: "bea",
		kind: "permanent",
		startsOn,
		endsOn,
		endReason: null,
		worksNumber: null,
		priorDaysAtAllowance: false,
		versions,
		...more,
	};
}

type Request = LeaveSpan & { status: LeaveStatus };

function request(startsOn: Day, endsOn: Day, status: LeaveStatus = "approved"): Request {
	return { startsOn, endsOn, startsHalf: false, endsHalf: false, status };
}

function leaveOf(
	contracts: Contract[],
	{
		week = FULL_TIME,
		settings = USUAL_SETTINGS,
		requests = [],
		adjustments = [],
		holidays = [],
		allowanceHalfDays = ALLOWANCE,
	}: {
		week?: readonly number[];
		settings?: Partial<LeaveYearSettings>;
		requests?: Request[];
		adjustments?: { leaveYear: number; minutes: number }[];
		holidays?: Day[];
		allowanceHalfDays?: number | null;
	} = {},
): ContractLeave {
	return {
		contracts,
		settings: { ...USUAL_SETTINGS, ...settings },
		allowanceHalfDays,
		calendar: { timetable: weekly(week), holidays: new Map(holidays.map((d) => [d, "Holiday"])) },
		requests,
		adjustments,
	};
}

/** A random day of 2026. */
const dayOf2026 = (next: () => number): Day => addDays("2026-01-01", Math.floor(next() * 365));

/** Random requests in and around 2026, each a few days, some pending, some half days, some withdrawn. */
function randomRequests(next: () => number, count: number): Request[] {
	const statuses: LeaveStatus[] = ["approved", "pending", "withdrawn", "refused", "cancelled"];
	return Array.from({ length: count }, () => {
		const startsOn = addDays("2025-12-20", Math.floor(next() * 390));
		const endsOn = addDays(startsOn, Math.floor(next() * 6));
		return {
			startsOn,
			endsOn,
			startsHalf: next() < 0.2,
			endsHalf: endsOn > startsOn && next() < 0.2,
			status: statuses[Math.floor(next() * statuses.length)] ?? "approved",
		};
	});
}

describe("leave year", () => {
	it("starts on the organisation's chosen day and runs to the day before it a year later", () => {
		expect(leaveYear(CALENDAR_YEAR, 2026)).toEqual({
			year: 2026,
			first: "2026-01-01",
			last: "2026-12-31",
		});
		expect(leaveYear("04-06", 2026)).toEqual({
			year: 2026,
			first: "2026-04-06",
			last: "2027-04-05",
		});
		// A day before the start falls in the year named for the year before.
		expect(leaveYearOf("04-06", "2027-04-05")).toBe(2026);
		expect(leaveYearOf("04-06", "2027-04-06")).toBe(2027);
		expect(leaveYearOf(CALENDAR_YEAR, "2026-11-24")).toBe(2026);
		expect(leaveYearLabel(CALENDAR_YEAR, 2026)).toBe("2026");
		expect(leaveYearLabel("04-06", 2026)).toBe("6 April 2026 – 5 April 2027");
	});

	it("starts on a day every year has: never 29 February", () => {
		expect(LeaveYearStarts.safeParse("04-06").success).toBe(true);
		expect(LeaveYearStarts.safeParse("02-28").success).toBe(true);
		expect(LeaveYearStarts.safeParse("02-29").success).toBe(false);
		expect(LeaveYearStarts.safeParse("04-31").success).toBe(false);
		expect(LeaveYearStarts.safeParse("4-6").success).toBe(false);
	});

	it("counts a contract's year from its own start: a year from 6 April holds that year's days", () => {
		const leave = leaveOf([contract("2026-04-06", null)], {
			settings: { leaveYearStarts: "04-06" },
		});
		const year = entitlementOf(leave, 2026);
		expect(year.year).toEqual(leaveYear("04-06", 2026));
		expect(year.minutes).toBe(25 * DAY);
	});
});

describe("entitlement", () => {
	it("is leave days ÷ 5 × weekly hours: 25 days on 22:30 a week is 112:30, 15 of her days", () => {
		const leave = leaveOf([contract("2026-01-01", null)], { week: THREE_DAYS });
		const year = entitlementOf(leave, 2026);
		expect(year.minutes).toBe(112 * 60 + 30);
		expect(year.dayLength).toBe(DAY);
		expect(leaveAmount(year.minutes, year.dayLength)).toBe("15 days");
		// And 187:30 on the full week.
		expect(entitlementOf(leaveOf([contract("2026-01-01", null)]), 2026).minutes).toBe(
			187 * 60 + 30,
		);
	});

	it("gives a starter on 13 January the days left, and gov.uk's 2.5 days for January when the month counts whole", () => {
		// gov.uk, Holiday entitlement: "Someone works a 5-day week and is entitled
		// to 28 days' annual leave a year. The leave year starts on 1 January but
		// they start their job on 13 January. They're entitled to 2.5 days' leave
		// for January (28 days ÷ 12 = 2.33), rounding up to the nearest half day."
		// https://www.gov.uk/holiday-entitlement-rights
		const twentyEight = (endsOn: Day | null) =>
			contract("2026-01-13", endsOn, [version("2026-01-13", { leaveDays: 28 })]);
		const whole = { starterMonth: "whole" as const };
		expect(
			entitlementOf(leaveOf([twentyEight("2026-01-31")], { settings: whole }), 2026).minutes,
		).toBe(2.5 * DAY);
		// From their first day: 19 of 365 days of 28 is 1.46 days, rounded up to 1.5.
		expect(entitlementOf(leaveOf([twentyEight("2026-01-31")]), 2026).minutes).toBe(1.5 * DAY);
		// The year from 13 January: 353 of 365 days of 28 is 27.08, rounded up to 27.5.
		expect(entitlementOf(leaveOf([twentyEight(null)]), 2026).minutes).toBe(27.5 * DAY);
		expect(entitlementOf(leaveOf([twentyEight(null)], { settings: whole }), 2026).minutes).toBe(
			28 * DAY,
		);
	});

	it("counts each part of a version change mid-year", () => {
		const changed = contract("2026-01-01", null, [
			version("2026-01-01", { leaveDays: 20 }),
			version("2026-07-01", { leaveDays: 30 }),
		]);
		// 20 × 181 ÷ 365 + 30 × 184 ÷ 365 = 25.04 days, rounded up to 25.5.
		expect(entitlementOf(leaveOf([changed]), 2026).minutes).toBe(25.5 * DAY);
		// A move from five days to three counts each part in its own hours: the
		// schedule that holds that day gives the week.
		const days = daysFrom("2026-01-01", "2026-12-31");
		const july = days.indexOf("2026-07-01");
		const timetable = (day: Day) => weekly(day < "2026-07-01" ? FULL_TIME : THREE_DAYS)(day);
		const mixed = {
			...leaveOf([contract("2026-01-01", null)]),
			calendar: { timetable, holidays: new Map() },
		};
		const exact = (25 * 2250 * july + 25 * 1350 * (days.length - july)) / 5 / days.length;
		const year = entitlementOf(mixed, 2026);
		expect(year.minutes).toBeGreaterThanOrEqual(exact);
		// Rounded up by less than half of the average day of 7:30.
		expect(year.minutes - exact).toBeLessThan(DAY / 2);
		expect(year.dayLength).toBe(DAY);
	});

	it("is pro rata over random start and end days, and never more than the full year: a property", () => {
		const next = random(98_201);
		const full = entitlementOf(leaveOf([contract("2026-01-01", null)]), 2026).minutes;
		for (let run = 0; run < 300; run += 1) {
			const a = dayOf2026(next);
			const b = dayOf2026(next);
			const [startsOn, endsOn] = a <= b ? [a, b] : [b, a];
			const leaveDays = 1 + Math.floor(next() * 40);
			const covered = daysFrom(startsOn, endsOn).length;
			const leave = leaveOf([contract(startsOn, endsOn, [version(startsOn, { leaveDays })])]);
			const { minutes } = entitlementOf(leave, 2026);
			// Half days: leave days × 2 × the days covered ÷ 365, rounded up.
			expect(minutes, JSON.stringify({ startsOn, endsOn, leaveDays })).toBe(
				(Math.ceil((leaveDays * 2 * covered) / 365) * DAY) / 2,
			);
			if (leaveDays === 25) expect(minutes).toBeLessThanOrEqual(full);
		}
	});

	it("splits a year among random versions without ever passing the full year: a property", () => {
		const next = random(98_202);
		const full = entitlementOf(leaveOf([contract("2026-01-01", null)]), 2026).minutes;
		for (let run = 0; run < 100; run += 1) {
			const changes = [
				...new Set(Array.from({ length: 1 + Math.floor(next() * 4) }, () => dayOf2026(next))),
			]
				.filter((day) => day > "2026-01-01")
				.sort();
			const versions = ["2026-01-01", ...changes].map((day) => version(day));
			const leave = leaveOf([contract("2026-01-01", null, versions)]);
			// The same 25 days in every version: the parts add up to the year, no more.
			expect(entitlementOf(leave, 2026).minutes).toBe(full);
		}
	});

	it("gives a contractor's contract none", () => {
		const leave = leaveOf([contract("2026-01-01", null, undefined, { kind: "contractor" })]);
		expect(entitlementOf(leave, 2026).minutes).toBe(0);
		expect(contractBalance(leave, 2026)).toBeNull();
	});
});

describe("days or hours", () => {
	it("shows days where every working day is the same length, and hours where they differ", () => {
		const even = contractBalance(
			leaveOf([contract("2026-01-01", null)], { week: THREE_DAYS }),
			2026,
		);
		if (!even) throw new Error("No balance.");
		expect(shownInDays(even)).toBe(DAY);
		expect(contractBalanceWords(even, "2026-06-01").value).toBe("15 days left");
		// Four days: three of 7:30 and a Friday of 4:00, 26:30 a week.
		const uneven = contractBalance(
			leaveOf([contract("2026-01-01", null)], { week: [450, 450, 450, 0, 240, 0, 0] }),
			2026,
		);
		if (!uneven) throw new Error("No balance.");
		expect(uneven.dayLength).toBeNull();
		expect(shownInDays(uneven)).toBeNull();
		// 25 ÷ 5 × 26:30 = 132:30, already a whole number of half average days (3:18.75 is half of 6:37.5).
		expect(uneven.entitlement).toBe(132 * 60 + 30);
		expect(contractBalanceWords(uneven, "2026-06-01").value).toBe("132:30 left");
	});

	it("shows hours when a figure is not a whole or half day, though the days are the same length", () => {
		const leave = leaveOf([contract("2026-01-01", null)], {
			adjustments: [{ leaveYear: 2026, minutes: 100 }],
		});
		const counted = contractBalance(leave, 2026);
		if (!counted) throw new Error("No balance.");
		expect(shownInDays(counted)).toBeNull();
		expect(contractBalanceWords(counted, "2026-06-01").value).toBe("189:10 left");
	});

	it("converts minutes and days both ways for any day length and any half days: a property", () => {
		const next = random(98_203);
		for (let run = 0; run < 1_000; run += 1) {
			const length = 60 + 15 * Math.floor(next() * 40);
			const halves = 1 + Math.floor(next() * 120);
			const negative = next() < 0.3;
			const typed = `${negative ? "-" : ""}${halves / 2}`;
			const minutes = minutesFrom(typed, "days", length);
			expect(minutes, `${typed} of ${length}`).toBe(
				(negative ? -1 : 1) * Math.round((halves * length) / 2),
			);
			if (Number.isInteger((halves * length) / 2)) {
				const words = leaveAmount(minutes ?? 0, length);
				expect(words).toBe(
					`${negative ? "minus " : ""}${halves === 1 ? "half a day" : `${halves / 2} ${halves === 2 ? "day" : "days"}`}`,
				);
			}
			// Hours: any whole minutes said as h:mm come back as themselves.
			const any = 1 + Math.floor(next() * 50_000);
			expect(minutesFrom(leaveAmount(any, null), "hours", null)).toBe(any);
		}
		expect(minutesFrom("7.5", "hours", null)).toBe(450);
		expect(minutesFrom("2", "days", null)).toBeNull();
		expect(minutesFrom("1.25", "days", DAY)).toBeNull();
		expect(minutesFrom("0", "hours", null)).toBeNull();
	});
});

describe("carry-over", () => {
	const carrying = (more: Partial<ContractVersion>) => [
		contract("2026-01-01", null, [version("2026-01-01", { carryOverDays: 5, ...more })]),
	];

	it("carries what is left, up to carry_over_days, into the next leave year", () => {
		const counted = contractBalance(leaveOf(carrying({})), 2027);
		expect(counted?.carried).toBe(5 * DAY);
		expect(counted?.left).toBe(30 * DAY);
		// Less left than the most it carries: what is left.
		const most = contractBalance(
			leaveOf(carrying({}), { requests: [request("2026-03-02", "2026-03-27")] }),
			2027,
		);
		// 20 working days taken of 25 leaves 5; 22 taken leaves 3.
		expect(most?.carried).toBe(5 * DAY);
		const less = contractBalance(
			leaveOf(carrying({}), { requests: [request("2026-03-02", "2026-03-31")] }),
			2027,
		);
		expect(less?.carried).toBe(3 * DAY);
		// None where the contract carries none.
		expect(contractBalance(leaveOf([contract("2026-01-01", null)]), 2027)?.carried).toBe(0);
	});

	it("lapses after carry_over_expires_after_days: what is not taken by then is not left", () => {
		const leave = leaveOf(carrying({ carryOverExpiresAfterDays: 90 }), {
			// Two days taken in the 90 days, and one after.
			requests: [request("2027-02-01", "2027-02-02"), request("2027-06-01", "2027-06-01")],
		});
		const counted = contractBalance(leave, 2027);
		if (!counted) throw new Error("No balance.");
		expect(counted.carriedUntil).toBe("2027-03-31");
		expect(counted.lapsing).toBe(3 * DAY);
		expect(counted.left).toBe((25 + 5 - 3 - 3) * DAY);
		expect(contractBalanceWords(counted, "2027-03-01").detail).toContain(
			"3 days more of what was carried over, until Wednesday 31 March 2027.",
		);
		// Once lapsed it is not said.
		expect(contractBalanceWords(counted, "2027-04-01").detail).not.toContain("carried over, until");
	});

	it("carries a balance below nothing in full, whatever the contract carries", () => {
		const leave = leaveOf([contract("2026-01-01", null)], {
			adjustments: [{ leaveYear: 2026, minutes: -28 * DAY }],
		});
		const counted = contractBalance(leave, 2027);
		expect(counted?.carried).toBe(-3 * DAY);
		expect(counted?.left).toBe(22 * DAY);
	});
});

describe("no contract is today", () => {
	it("leaves the balance to `balance`, which matches main's for random requests: a property", () => {
		const next = random(98_204);
		for (let run = 0; run < 300; run += 1) {
			const requests = randomRequests(next, 1 + Math.floor(next() * 12));
			const week = next() < 0.5 ? FULL_TIME : THREE_DAYS;
			const holidays = next() < 0.5 ? ["2026-12-25", "2026-05-04"] : [];
			const allowance = next() < 0.1 ? null : Math.floor(next() * 70);
			const leave = leaveOf([], { week, requests, holidays, allowanceHalfDays: allowance });
			for (const year of [2025, 2026, 2027]) {
				// No contract: no balance from one, so Time off shows `balance`'s.
				expect(contractBalance(leave, year)).toBeNull();
				expect(balance(allowance, requests, year, leave.calendar, CALENDAR_YEAR)).toEqual(
					balanceOnMain(allowance, requests, year, leave.calendar),
				);
			}
			// Nor does a contract whose versions give no leave days of their own.
			const allowanceOnly = leaveOf(
				[contract("2026-03-02", null, [version("2026-03-02", { leaveDays: null })])],
				{ week, requests, holidays, allowanceHalfDays: allowance },
			);
			expect(contractBalance(allowanceOnly, 2026)).toBeNull();
		}
	});
});

describe("continuity", () => {
	it("leaves a year's balance as it was when the first answer gives a contract equal to the allowance from any day: a property", () => {
		const next = random(98_205);
		for (let run = 0; run < 200; run += 1) {
			const startsOn = dayOf2026(next);
			const requests = randomRequests(next, Math.floor(next() * 8));
			const leave = leaveOf(
				[
					contract(startsOn, null, [version(startsOn, { leaveDays: ALLOWANCE / 2 })], {
						priorDaysAtAllowance: true,
					}),
				],
				{ requests },
			);
			const before = balanceOnMain(ALLOWANCE, requests, 2026, leave.calendar);
			const counted = contractBalance(leave, 2026);
			if (!counted || before.left === null) throw new Error("No balance.");
			expect(counted.entitlement, startsOn).toBe((ALLOWANCE * DAY) / 2);
			expect(counted.left, startsOn).toBe((before.left * DAY) / 2);
			expect(contractBalanceWords(counted, startsOn).value.replace(" left", "")).toBe(
				leaveAmount((before.left * DAY) / 2, DAY),
			);
		}
	});

	it("keeps the days before a contract given mid-year at the allowance, over random start days: a property", () => {
		const next = random(98_206);
		for (let run = 0; run < 300; run += 1) {
			const startsOn = dayOf2026(next);
			const leaveDays = Math.floor(next() * 40);
			const before = daysFrom("2026-01-01", startsOn).length - 1;
			const after = 365 - before;
			const given = (prior: boolean) =>
				leaveOf([
					contract(startsOn, null, [version(startsOn, { leaveDays })], {
						priorDaysAtAllowance: prior,
					}),
				]);
			// The allowance's half days for the days before, and the contract's after, rounded up once.
			expect(entitlementOf(given(true), 2026).minutes, `${startsOn} ${leaveDays}`).toBe(
				(Math.ceil((ALLOWANCE * before + 2 * leaveDays * after) / 365) * DAY) / 2,
			);
			// The second answer: the days before count nothing.
			expect(entitlementOf(given(false), 2026).minutes).toBe(
				(Math.ceil((2 * leaveDays * after) / 365) * DAY) / 2,
			);
		}
	});

	it("counts the allowance in the person's own working days before the contract, as today", () => {
		// Three days a week: today's 25 days are 25 of her days, 187:30; from 1
		// July a contract gives 25 ÷ 5 × 22:30 a year, 112:30.
		const leave = leaveOf(
			[contract("2026-07-01", null, undefined, { priorDaysAtAllowance: true })],
			{ week: THREE_DAYS },
		);
		const exact = (187.5 * 60 * 181 + 112.5 * 60 * 184) / 365;
		const { minutes } = entitlementOf(leave, 2026);
		expect(minutes).toBeGreaterThanOrEqual(exact);
		expect(minutes - exact).toBeLessThan(DAY / 2);
	});

	it("counts nothing between two contracts, nor after the last ends", () => {
		const first = contract("2026-01-01", "2026-03-31");
		const second = contract("2026-07-01", "2026-09-30", [version("2026-07-01")]);
		const gap = entitlementOf(leaveOf([first, second]), 2026);
		// January to March, 90 days, and July to September, 92, of 25: the gap and October on give nothing.
		expect(gap.minutes).toBe((Math.ceil((50 * 182) / 365) * DAY) / 2);
		expect(gap.counts("2026-05-04")).toBe(false);
		expect(gap.counts("2026-08-31")).toBe(true);
		expect(gap.counts("2026-10-01")).toBe(false);
	});

	it("counts the gap nothing though the first contract counts the days before it, over random gaps: a property", () => {
		const next = random(98_207);
		for (let run = 0; run < 300; run += 1) {
			const firstEnds = addDays("2026-01-01", Math.floor(next() * 360));
			const secondStarts = addDays(firstEnds, 1 + Math.floor(next() * 120));
			const before = contract("2025-06-01", firstEnds, [version("2025-06-01")], {
				priorDaysAtAllowance: true,
			});
			const after = contract(secondStarts, null);
			// The days of 2026 each contract covers; none between them.
			const counted =
				daysFrom("2026-01-01", firstEnds).length +
				(secondStarts <= "2026-12-31" ? daysFrom(secondStarts, "2026-12-31").length : 0);
			const { minutes } = entitlementOf(leaveOf([before, after]), 2026);
			expect(minutes, `${firstEnds} ${secondStarts}`).toBe(
				(Math.ceil((ALLOWANCE * counted) / 365) * DAY) / 2,
			);
			expect(leavesGap([before, after], leaveYear("01-01", 2026))).toBe(
				secondStarts > addDays(firstEnds, 1),
			);
		}
	});

	it("finds a gap only where two contracts leave days of the year between them", () => {
		const year = leaveYear("01-01", 2026);
		const ended = contract("2025-01-01", "2026-03-31");
		expect(leavesGap([ended, contract("2026-04-01", null)], year)).toBe(false);
		expect(leavesGap([ended, contract("2026-04-02", null)], year)).toBe(true);
		expect(
			leavesGap([contract("2025-01-01", "2025-06-30"), contract("2025-08-01", null)], year),
		).toBe(false);
		expect(
			leavesGap([contract("2026-11-01", "2026-12-31"), contract("2027-02-01", null)], year),
		).toBe(false);
		expect(
			leavesGap([contract("2026-11-01", "2026-12-30"), contract("2027-02-01", null)], year),
		).toBe(true);
		// Days after the last contract ends are no gap: nothing comes after them.
		expect(leavesGap([contract("2026-01-01", "2026-06-30")], year)).toBe(false);
	});
});
