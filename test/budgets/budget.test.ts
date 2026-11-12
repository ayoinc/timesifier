import { describe, expect, it } from "vitest";
import {
	BudgetKind,
	budgetPeriod,
	budgetStatus,
	countsTowardHours,
	crossedThreshold,
	isHoursBudget,
	LIFETIME_START,
} from "~/budgets/budget";
import { addDays, Day, dayOf } from "~/time/calendar";

// Project budgets (TS-064, B7): the period a budget counts over, where it
// stands, and when an alert's threshold is crossed.

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

describe("a budget's kind", () => {
	it("counts hours for the hours kinds and money for the fees kinds", () => {
		expect(BudgetKind.options.filter(isHoursBudget)).toEqual([
			"total_hours",
			"task_hours",
			"person_hours",
		]);
		expect(isHoursBudget("total_fees")).toBe(false);
		expect(isHoursBudget("none")).toBe(false);
	});
});

describe("a budget's period", () => {
	it("is the calendar month holding today when it resets monthly", () => {
		expect(budgetPeriod({ resetsMonthly: true, today: "2026-11-11" })).toEqual({
			startsOn: "2026-11-01",
			endsOn: "2026-11-30",
		});
		expect(budgetPeriod({ resetsMonthly: true, today: "2026-12-31" })).toEqual({
			startsOn: "2026-12-01",
			endsOn: "2026-12-31",
		});
		expect(budgetPeriod({ resetsMonthly: true, today: "2028-02-01" })).toEqual({
			startsOn: "2028-02-01",
			endsOn: "2028-02-29",
		});
		expect(budgetPeriod({ resetsMonthly: true, today: "2026-02-28" })).toEqual({
			startsOn: "2026-02-01",
			endsOn: "2026-02-28",
		});
	});

	it("is the whole month even when the project started within it", () => {
		expect(
			budgetPeriod({ resetsMonthly: true, today: "2026-11-20", projectStartedOn: "2026-11-15" }),
		).toEqual({ startsOn: "2026-11-01", endsOn: "2026-11-30" });
	});

	it("resets at local midnight on the 1st in the organisation's zone", () => {
		// 23:30 UTC on 31 October is already 1 November in Auckland, still 31 October in London.
		const instant = Date.parse("2026-10-31T23:30:00Z");
		const inLondon = budgetPeriod({ resetsMonthly: true, today: dayOf(instant, "Europe/London") });
		const inAuckland = budgetPeriod({
			resetsMonthly: true,
			today: dayOf(instant, "Pacific/Auckland"),
		});
		expect(inLondon.startsOn).toBe("2026-10-01");
		expect(inAuckland.startsOn).toBe("2026-11-01");
	});

	it("runs from the project's start, or from before any entry, with no end when it never resets", () => {
		expect(
			budgetPeriod({ resetsMonthly: false, today: "2026-11-11", projectStartedOn: "2026-03-04" }),
		).toEqual({ startsOn: "2026-03-04", endsOn: null });
		expect(budgetPeriod({ resetsMonthly: false, today: "2026-11-11" })).toEqual({
			startsOn: LIFETIME_START,
			endsOn: null,
		});
		expect(Day.safeParse(LIFETIME_START).success).toBe(true);
	});

	it("property: a monthly period holds today, starts on the 1st and ends the day before the next 1st", () => {
		const next = random(8);
		for (let run = 0; run < 1000; run++) {
			const today = addDays("1990-01-01", Math.floor(next() * 30_000));
			const { startsOn, endsOn } = budgetPeriod({ resetsMonthly: true, today });
			expect(endsOn).not.toBeNull();
			const last = endsOn as Day;
			expect(startsOn <= today && today <= last).toBe(true);
			expect(startsOn.slice(8)).toBe("01");
			expect(startsOn.slice(0, 7)).toBe(today.slice(0, 7));
			expect(last.slice(0, 7)).toBe(today.slice(0, 7));
			expect(addDays(last, 1).slice(8)).toBe("01");
		}
	});
});

describe("where a budget stands", () => {
	it("gives spent, remaining, the whole percent rounded down, and whether it is over", () => {
		expect(budgetStatus({ amount: 3000, spent: 2400 })).toEqual({
			spent: 2400,
			remaining: 600,
			percent: 80,
			over: false,
		});
		expect(budgetStatus({ amount: 3000, spent: 2999 })).toMatchObject({ percent: 99, over: false });
		expect(budgetStatus({ amount: 3000, spent: 3000 })).toMatchObject({
			remaining: 0,
			percent: 100,
			over: false,
		});
		expect(budgetStatus({ amount: 3000, spent: 3001 })).toEqual({
			spent: 3001,
			remaining: -1,
			percent: 100,
			over: true,
		});
		expect(budgetStatus({ amount: 3000, spent: 0 })).toMatchObject({ percent: 0, over: false });
	});

	it("is over at once for a budget of 0 once anything is spent, with no percent", () => {
		expect(budgetStatus({ amount: 0, spent: 0 })).toEqual({
			spent: 0,
			remaining: 0,
			percent: null,
			over: false,
		});
		expect(budgetStatus({ amount: 0, spent: 1 })).toEqual({
			spent: 1,
			remaining: -1,
			percent: null,
			over: true,
		});
	});

	it("refuses negative or fractional amounts", () => {
		expect(() => budgetStatus({ amount: -1, spent: 0 })).toThrow(RangeError);
		expect(() => budgetStatus({ amount: 10, spent: -1 })).toThrow(RangeError);
		expect(() => budgetStatus({ amount: 10.5, spent: 0 })).toThrow(RangeError);
	});

	it("property: remaining is amount − spent, percent is floor(spent × 100 / amount), over is spent > amount", () => {
		const next = random(9);
		for (let run = 0; run < 2000; run++) {
			const amount = Math.floor(next() * 100_000);
			const spent = Math.floor(next() * 150_000);
			const status = budgetStatus({ amount, spent });
			expect(status.remaining).toBe(amount - spent);
			expect(status.over).toBe(spent > amount);
			if (amount === 0) expect(status.percent).toBeNull();
			else {
				const percent = status.percent as number;
				expect(percent * amount).toBeLessThanOrEqual(spent * 100);
				expect((percent + 1) * amount).toBeGreaterThan(spent * 100);
			}
		}
	});
});

describe("crossing an alert threshold", () => {
	it("happens when spending reaches the threshold from below, exactly", () => {
		// 80% of 999 is 799.2: reached at 800, not at 799.
		expect(crossedThreshold({ amount: 999, spent: 700 }, { amount: 999, spent: 799 }, 80)).toBe(
			false,
		);
		expect(crossedThreshold({ amount: 999, spent: 799 }, { amount: 999, spent: 800 }, 80)).toBe(
			true,
		);
		expect(crossedThreshold({ amount: 1000, spent: 0 }, { amount: 1000, spent: 800 }, 80)).toBe(
			true,
		);
	});

	it("does not happen again while above it, nor on the way down", () => {
		expect(crossedThreshold({ amount: 1000, spent: 800 }, { amount: 1000, spent: 900 }, 80)).toBe(
			false,
		);
		expect(crossedThreshold({ amount: 1000, spent: 900 }, { amount: 1000, spent: 100 }, 80)).toBe(
			false,
		);
	});

	it("happens when the budget is lowered under what is spent", () => {
		expect(crossedThreshold({ amount: 1000, spent: 500 }, { amount: 600, spent: 500 }, 80)).toBe(
			true,
		);
	});

	it("happens at the first spending against a budget of 0, and allows thresholds past 100", () => {
		expect(crossedThreshold({ amount: 0, spent: 0 }, { amount: 0, spent: 1 }, 80)).toBe(true);
		expect(crossedThreshold({ amount: 0, spent: 1 }, { amount: 0, spent: 5 }, 80)).toBe(false);
		expect(crossedThreshold({ amount: 100, spent: 100 }, { amount: 100, spent: 120 }, 120)).toBe(
			true,
		);
	});

	it("refuses a threshold that is not a whole number above 0", () => {
		const budget = { amount: 100, spent: 0 };
		expect(() => crossedThreshold(budget, budget, 0)).toThrow(RangeError);
		expect(() => crossedThreshold(budget, budget, 80.5)).toThrow(RangeError);
	});

	it("property: over a run of entries, is crossed exactly once, by the entry that first reaches it", () => {
		const next = random(10);
		for (let run = 0; run < 500; run++) {
			const amount = 1 + Math.floor(next() * 10_000);
			const threshold = 1 + Math.floor(next() * 150);
			let spent = 0;
			let crossings = 0;
			for (let entry = 0; entry < 50; entry++) {
				const after = spent + Math.floor(next() * 500);
				if (crossedThreshold({ amount, spent }, { amount, spent: after }, threshold)) {
					crossings += 1;
					expect(spent * 100).toBeLessThan(threshold * amount);
					expect(after * 100).toBeGreaterThanOrEqual(threshold * amount);
				}
				spent = after;
			}
			expect(crossings).toBe(spent * 100 >= threshold * amount ? 1 : 0);
		}
	});
});

describe("what counts against an hours budget", () => {
	it("is billable time always, and non-billable time when the organisation counts it", () => {
		expect(countsTowardHours(true, false)).toBe(true);
		expect(countsTowardHours(true, true)).toBe(true);
		expect(countsTowardHours(false, true)).toBe(true);
		expect(countsTowardHours(false, false)).toBe(false);
	});
});
