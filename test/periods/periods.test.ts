import { describe, expect, it } from "vitest";
import {
	locksEntries,
	PeriodAction,
	PeriodStatus,
	periodAfter,
	periodBounds,
	periodContaining,
	statusAfter,
	WeekStart,
} from "~/periods/periods";

// Timesheet periods (TS-046, TS-047): where a week starts, its instants in a
// person's zone, what locks its entries, and the steps of its life.

const at = (iso: string) => Date.parse(iso);

describe("the period a day falls in", () => {
	it("is the week from Monday when weeks start on Monday", () => {
		for (const day of ["2026-11-09", "2026-11-11", "2026-11-15"]) {
			expect(periodContaining(day, 1)).toEqual({ startsOn: "2026-11-09", endsOn: "2026-11-15" });
		}
	});

	it("is the week from Sunday when weeks start on Sunday", () => {
		expect(periodContaining("2026-11-15", 7)).toEqual({
			startsOn: "2026-11-15",
			endsOn: "2026-11-21",
		});
		expect(periodContaining("2026-11-14", 7)).toEqual({
			startsOn: "2026-11-08",
			endsOn: "2026-11-14",
		});
	});

	it("always holds the day, starts on the week's first day and lasts seven days, whatever the start", () => {
		for (let start = 1; start <= 7; start++) {
			for (let offset = 0; offset < 21; offset++) {
				const day = new Date(Date.UTC(2026, 11, 20 + offset)).toISOString().slice(0, 10);
				const { startsOn, endsOn } = periodContaining(day, start);
				expect(startsOn <= day && day <= endsOn).toBe(true);
				expect(new Date(`${startsOn}T00:00:00Z`).getUTCDay() || 7).toBe(start);
				expect(Date.parse(endsOn) - Date.parse(startsOn)).toBe(6 * 86_400_000);
			}
		}
	});

	it("is followed and preceded by the weeks either side", () => {
		const week = { startsOn: "2026-12-28", endsOn: "2027-01-03" };
		expect(periodAfter(week, 1)).toEqual({ startsOn: "2027-01-04", endsOn: "2027-01-10" });
		expect(periodAfter(week, -1)).toEqual({ startsOn: "2026-12-21", endsOn: "2026-12-27" });
	});

	it("takes a week start of 1 to 7 alone", () => {
		expect(WeekStart.safeParse("7").success).toBe(true);
		for (const wrong of ["0", "8", "1.5", "monday"]) {
			expect(WeekStart.safeParse(wrong).success, wrong).toBe(false);
		}
	});
});

describe("the instants of a period", () => {
	it("run from the start of its first local day to the start of the day after its last", () => {
		const week = { startsOn: "2026-03-23", endsOn: "2026-03-29" };
		expect(periodBounds(week, "Europe/London")).toEqual({
			from: at("2026-03-23T00:00:00Z"),
			to: at("2026-03-29T23:00:00Z"),
		});
		expect(periodBounds(week, "Pacific/Auckland").from).toBe(at("2026-03-22T11:00:00Z"));
	});
});

describe("a period's status", () => {
	it("locks its entries while submitted or approved, and not before, after a withdrawal or a return", () => {
		expect(locksEntries(null)).toBe(false);
		expect(locksEntries("submitted")).toBe(true);
		expect(locksEntries("approved")).toBe(true);
		expect(locksEntries("withdrawn")).toBe(false);
		expect(locksEntries("returned")).toBe(false);
	});

	it("moves only by the steps of TS-046 and TS-047", () => {
		const table: [PeriodStatus | null, PeriodAction, PeriodStatus | null][] = [
			[null, "submitted", "submitted"],
			["withdrawn", "submitted", "submitted"],
			["returned", "submitted", "submitted"],
			["submitted", "submitted", null],
			["approved", "submitted", null],
			["submitted", "withdrawn", "withdrawn"],
			["approved", "withdrawn", null],
			["returned", "withdrawn", null],
			[null, "withdrawn", null],
			["submitted", "approved", "approved"],
			["returned", "approved", null],
			["approved", "approved", null],
			["submitted", "returned", "returned"],
			["approved", "returned", null],
			["approved", "reopened", "returned"],
			["submitted", "reopened", null],
			[null, "approved", null],
		];
		for (const [from, action, to] of table) {
			expect(statusAfter(from, action), `${from} ${action}`).toBe(to);
		}
		// Every status and action is in the table above at least once.
		expect(new Set(table.map(([from]) => from))).toEqual(new Set([null, ...PeriodStatus.options]));
		expect(new Set(table.map(([, action]) => action))).toEqual(new Set(PeriodAction.options));
	});
});
