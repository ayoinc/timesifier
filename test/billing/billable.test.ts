import { describe, expect, it } from "vitest";
import {
	type BillableAmount,
	BillingType,
	billableAmount,
	billableMinuteMinor,
	sumBillable,
} from "~/billing/billable";
import { roundHalfUp } from "~/money/money";

// What tracked time is worth (TS-064, B5): minutes × rate, exact until a total
// is shown, then rounded once.

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

const rate = { amountMinor: 9000 };

describe("an entry's billable amount", () => {
	it("is its minutes times the hourly rate, exact, in minute-minor units", () => {
		expect(billableAmount({ minutes: 90, billable: true, billingType: "hourly", rate })).toEqual({
			kind: "billable",
			minuteMinor: 810_000,
		});
		expect(
			billableAmount({
				minutes: 7,
				billable: true,
				billingType: "hourly",
				rate: { amountMinor: 10 },
			}),
		).toEqual({ kind: "billable", minuteMinor: 70 });
	});

	it("is priced at its rate on a fixed-fee project too, for the 'if billed hourly' figure", () => {
		expect(billableAmount({ minutes: 60, billable: true, billingType: "fixed_fee", rate })).toEqual(
			{
				kind: "billable",
				minuteMinor: 540_000,
			},
		);
	});

	it("is nothing for a non-billable entry, and for every entry on a non-billable project", () => {
		expect(billableAmount({ minutes: 60, billable: false, billingType: "hourly", rate })).toEqual({
			kind: "non-billable",
		});
		for (const billable of [true, false]) {
			expect(billableAmount({ minutes: 60, billable, billingType: "non_billable", rate })).toEqual({
				kind: "non-billable",
			});
			expect(
				billableAmount({ minutes: 60, billable, billingType: "non_billable", rate: null }),
			).toEqual({ kind: "non-billable" });
		}
	});

	it("is a missing rate for billable work with no rate", () => {
		expect(
			billableAmount({ minutes: 60, billable: true, billingType: "hourly", rate: null }),
		).toEqual({
			kind: "missing-rate",
		});
	});

	it("refuses fractional or negative minutes and an amount past the safe range", () => {
		const input = { billable: true, billingType: "hourly" as const, rate };
		expect(() => billableAmount({ ...input, minutes: 1.5 })).toThrow(RangeError);
		expect(() => billableAmount({ ...input, minutes: -1 })).toThrow(RangeError);
		expect(() =>
			billableAmount({ ...input, minutes: 1_000_000_000, rate: { amountMinor: 10_000_000_000 } }),
		).toThrow(RangeError);
	});

	it("takes the three billing types", () => {
		expect(BillingType.options).toEqual(["hourly", "fixed_fee", "non_billable"]);
	});
});

describe("a total of billable amounts", () => {
	it("is the exact sum divided by 60 and rounded half up once", () => {
		// 1 minute at £0.30 an hour is half a penny; three are 1.5p, so 2p, not 3p.
		const halfPenny = billableAmount({
			minutes: 1,
			billable: true,
			billingType: "hourly",
			rate: { amountMinor: 30 },
		});
		expect(sumBillable([halfPenny, halfPenny, halfPenny])).toBe(2);
		expect(sumBillable([halfPenny])).toBe(1);
		expect(sumBillable([])).toBe(0);
	});

	it("counts non-billable work and missing rates as 0", () => {
		const items: BillableAmount[] = [
			{ kind: "billable", minuteMinor: 600 },
			{ kind: "non-billable" },
			{ kind: "missing-rate" },
		];
		expect(billableMinuteMinor(items)).toBe(600);
		expect(sumBillable(items)).toBe(10);
	});

	it("property: equals the rounding of the exact sum, however the entries are grouped or ordered", () => {
		const next = random(7);
		const kinds = ["hourly", "fixed_fee", "non_billable"] as const;
		for (let run = 0; run < 500; run++) {
			const items = Array.from({ length: Math.floor(next() * 40) }, () =>
				billableAmount({
					minutes: Math.floor(next() * 600),
					billable: next() < 0.8,
					billingType: kinds[Math.floor(next() * kinds.length)] ?? "hourly",
					rate: next() < 0.1 ? null : { amountMinor: Math.floor(next() * 50_000) },
				}),
			);
			let exact = 0;
			for (const item of items) if (item.kind === "billable") exact += item.minuteMinor;
			const total = sumBillable(items);
			expect(total).toBe(roundHalfUp(exact, 60));
			// Within half a minor unit of the exact amount.
			expect(Math.abs(total * 60 - exact)).toBeLessThanOrEqual(30);

			// Split into groups at random, sum each group exactly, add the groups: the same total.
			const groups: BillableAmount[][] = [[], [], [], []];
			for (const item of items) groups[Math.floor(next() * groups.length)]?.push(item);
			const grouped = groups.reduce((sum, group) => sum + billableMinuteMinor(group), 0);
			expect(roundHalfUp(grouped, 60)).toBe(total);
			expect(sumBillable([...items].reverse())).toBe(total);
		}
	});
});
