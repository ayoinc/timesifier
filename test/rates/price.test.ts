import { describe, expect, it } from "vitest";
import { type BillableAmount, sumBillable } from "~/billing/billable";
import { moneyText, parseBudgetHours, parseMoney, parsePercent } from "~/money/typed";
import { type PricedProject, priceTime, rateFor, wholeMinutes } from "~/rates/price";
import type { RateRow } from "~/rates/rates";
import { addDays } from "~/time/calendar";

// Pricing tracked time (TS-067, B5): the project's billing type and rate mode
// choose which rates may price its time, the rate in force on the entry's own
// local day prices it, and amounts are exact until a total is rounded once.

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

const project = (more: Partial<PricedProject> = {}): PricedProject => ({
	id: "p1",
	billingType: "hourly",
	rateMode: "project",
	currency: "GBP",
	...more,
});

const rate = (more: Partial<RateRow>): RateRow => ({
	kind: "billable",
	userId: null,
	projectId: null,
	taskId: null,
	amountMinor: 10_000,
	currency: "GBP",
	effectiveFrom: "2026-01-01",
	...more,
});

const time = { userId: "ada", taskId: "design", billable: true, day: "2026-06-01", minutes: 60 };

const RATES: RateRow[] = [
	rate({ projectId: "p1", amountMinor: 5000 }),
	rate({ userId: "ada", amountMinor: 7000 }),
	rate({ userId: "ada", projectId: "p1", amountMinor: 7500 }),
	rate({ taskId: "design", amountMinor: 9000 }),
	rate({ taskId: "design", projectId: "p1", amountMinor: 9500 }),
	rate({ projectId: "p2", amountMinor: 1 }),
];

describe("the rate that prices time", () => {
	it("is the project's rate when the project bills one rate", () => {
		expect(rateFor(project(), RATES, time)?.amountMinor).toBe(5000);
	});

	it("is the person's rate on the project, else their default, when it bills by person", () => {
		const byPerson = project({ rateMode: "person" });
		expect(rateFor(byPerson, RATES, time)?.amountMinor).toBe(7500);
		const defaults = RATES.filter((r) => !(r.userId && r.projectId));
		expect(rateFor(byPerson, defaults, time)?.amountMinor).toBe(7000);
		expect(rateFor(byPerson, RATES, { ...time, userId: "bola" })).toBeNull();
	});

	it("is the task's rate on the project, else its default, when it bills by task", () => {
		const byTask = project({ rateMode: "task" });
		expect(rateFor(byTask, RATES, time)?.amountMinor).toBe(9500);
		const defaults = RATES.filter((r) => !(r.taskId && r.projectId));
		expect(rateFor(byTask, defaults, time)?.amountMinor).toBe(9000);
		expect(rateFor(byTask, RATES, { ...time, taskId: null })).toBeNull();
	});

	it("is never another project's, nor one in another currency", () => {
		expect(rateFor(project({ id: "p3" }), RATES, time)).toBeNull();
		expect(rateFor(project({ currency: "USD" }), RATES, time)).toBeNull();
		expect(rateFor(project({ rateMode: "person", currency: "USD" }), RATES, time)).toBeNull();
	});

	it("is the one in force on the time's own day: a later rate never prices earlier time", () => {
		const next = random(67);
		for (let run = 0; run < 300; run += 1) {
			const changes = Array.from({ length: 1 + Math.floor(next() * 5) }, (_, at) =>
				rate({
					projectId: "p1",
					amountMinor: 100 + Math.floor(next() * 50_000),
					effectiveFrom: addDays("2026-01-01", at * 30 + Math.floor(next() * 30)),
				}),
			);
			const day = addDays("2025-12-01", Math.floor(next() * 220));
			const before = changes.filter((c) => c.effectiveFrom <= day);
			const expected = before.at(-1)?.amountMinor ?? null;
			expect(rateFor(project(), changes, { ...time, day })?.amountMinor ?? null).toBe(expected);
			// A rate added from a later day changes nothing on or before this one.
			const later = rate({ projectId: "p1", amountMinor: 1, effectiveFrom: addDays(day, 1) });
			expect(rateFor(project(), [...changes, later], { ...time, day })?.amountMinor ?? null).toBe(
				expected,
			);
		}
	});
});

describe("what time is worth", () => {
	it("is nothing on a non-billable project or for non-billable time", () => {
		expect(priceTime(project({ billingType: "non_billable" }), RATES, time)).toEqual({
			kind: "non-billable",
		});
		expect(priceTime(project(), RATES, { ...time, billable: false })).toEqual({
			kind: "non-billable",
		});
	});

	it("is a missing rate for billable time with no rate, which counts 0", () => {
		const amount = priceTime(project({ id: "p9" }), RATES, time);
		expect(amount).toEqual({ kind: "missing-rate" });
		expect(sumBillable([amount])).toBe(0);
	});

	it("is minutes times the hourly rate, rounded only at the total", () => {
		expect(priceTime(project(), RATES, { ...time, minutes: 90 })).toEqual({
			kind: "billable",
			minuteMinor: 450_000,
		});
		expect(wholeMinutes(5399)).toBe(89);
	});

	it("adds up to the penny however the rows are grouped (property)", () => {
		const next = random(2026);
		for (let run = 0; run < 200; run += 1) {
			const amounts: BillableAmount[] = Array.from({ length: 1 + Math.floor(next() * 40) }, () =>
				priceTime(
					project(),
					[rate({ projectId: "p1", amountMinor: 1 + Math.floor(next() * 99_999) })],
					{ ...time, minutes: Math.floor(next() * 600), billable: next() > 0.2 },
				),
			);
			const total = sumBillable(amounts);
			// Each row's exact amount, grouped in two at a random place, adds to the same total.
			const cut = Math.floor(next() * amounts.length);
			const exact = (list: BillableAmount[]) =>
				list.reduce((sum, a) => sum + (a.kind === "billable" ? a.minuteMinor : 0), 0);
			expect(Math.floor((exact(amounts.slice(0, cut)) + exact(amounts.slice(cut)) + 30) / 60)).toBe(
				total,
			);
		}
	});
});

describe("money as typed", () => {
	it("reads an amount in the currency's minor units", () => {
		expect(parseMoney("85", "GBP")).toBe(8500);
		expect(parseMoney("85.5", "GBP")).toBe(8550);
		expect(parseMoney(" 1,234.50 ", "GBP")).toBe(123_450);
		expect(parseMoney("1200", "JPY")).toBe(1200);
	});

	it.each(["", "-5", "1.234", "abc", "1,23", "12.", "1e3"])("refuses %j", (text) => {
		expect(parseMoney(text, "GBP")).toBeNull();
	});

	it("refuses decimals a currency does not have", () => {
		expect(parseMoney("1.5", "JPY")).toBeNull();
	});

	it("writes back what it reads", () => {
		for (const minor of [0, 5, 99, 100, 123_450]) {
			expect(parseMoney(moneyText(minor, "GBP"), "GBP")).toBe(minor);
		}
		expect(moneyText(1200, "JPY")).toBe("1200");
	});

	it("reads percentages in basis points and budget hours in minutes", () => {
		expect(parsePercent("17.5")).toBe(1750);
		expect(parsePercent("101")).toBeNull();
		expect(parseBudgetHours("37.5")).toBe(2250);
		expect(parseBudgetHours("1,200")).toBe(72_000);
		expect(parseBudgetHours("ten")).toBeNull();
	});
});
