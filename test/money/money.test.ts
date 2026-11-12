import { describe, expect, it } from "vitest";
import {
	allocate,
	CurrencyCode,
	formatMoney,
	invoiceTotals,
	isCurrencyCode,
	lineAmount,
	minorDigits,
	percentOf,
	roundHalfUp,
	type Tax,
	totalsByCurrency,
} from "~/money/money";

// Money in integer minor units (TS-064, B5, B11): one rounding rule, invoice
// arithmetic that always adds up, and no sum across currencies.

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

/** A whole number from 0 to `below` − 1. */
function below(next: () => number, limit: number): number {
	return Math.floor(next() * limit);
}

describe("currency codes", () => {
	it("are three upper-case letters", () => {
		for (const code of ["GBP", "EUR", "JPY", "XYZ"]) expect(isCurrencyCode(code)).toBe(true);
		for (const code of ["gbp", "GB", "GBPX", "G1P", "", " GBP"]) {
			expect(isCurrencyCode(code)).toBe(false);
			expect(CurrencyCode.safeParse(code).success).toBe(false);
		}
		expect(CurrencyCode.parse("GBP")).toBe("GBP");
	});

	it("give the digits of their minor unit from the platform's data", () => {
		expect(minorDigits("GBP")).toBe(2);
		expect(minorDigits("EUR")).toBe(2);
		expect(minorDigits("JPY")).toBe(0);
		expect(minorDigits("KWD")).toBe(3);
		expect(() => minorDigits("gbp")).toThrow(RangeError);
	});
});

describe("rounding half up", () => {
	it("rounds a half away from zero, so a negative rounds as its positive with the sign put back", () => {
		expect(roundHalfUp(5, 2)).toBe(3);
		expect(roundHalfUp(-5, 2)).toBe(-3);
		expect(roundHalfUp(4, 3)).toBe(1);
		expect(roundHalfUp(-4, 3)).toBe(-1);
		expect(roundHalfUp(5, 3)).toBe(2);
		expect(roundHalfUp(-5, 3)).toBe(-2);
		expect(roundHalfUp(0, 7)).toBe(0);
	});

	it("property: is the nearest whole number, a half going away from zero, and odd in sign", () => {
		const next = random(1);
		for (let run = 0; run < 2000; run++) {
			const denominator = 1 + below(next, 1000);
			const numerator = below(next, 2_000_000) - 1_000_000;
			const rounded = roundHalfUp(numerator, denominator);
			const twice = 2 * (numerator - rounded * denominator);
			// The rounded value is within half a step, and a half rounds outwards.
			expect(Math.abs(twice)).toBeLessThanOrEqual(denominator);
			if (Math.abs(twice) === denominator)
				expect(Math.abs(rounded * denominator)).toBeGreaterThan(Math.abs(numerator));
			expect(roundHalfUp(-numerator, denominator)).toBe(-rounded || 0);
		}
	});

	it("takes safe integers and a positive denominator only", () => {
		expect(() => roundHalfUp(1.5, 2)).toThrow(RangeError);
		expect(() => roundHalfUp(1, 0)).toThrow(RangeError);
		expect(() => roundHalfUp(1, -2)).toThrow(RangeError);
		expect(() => roundHalfUp(Number.MAX_SAFE_INTEGER + 1, 2)).toThrow(RangeError);
	});
});

describe("a percentage of an amount", () => {
	it("is in basis points and rounded half up once", () => {
		expect(percentOf(10_000, 2000)).toBe(2000);
		expect(percentOf(1255, 2000)).toBe(251);
		expect(percentOf(1, 5000)).toBe(1);
		expect(percentOf(-1, 5000)).toBe(-1);
		expect(percentOf(333, 1000)).toBe(33);
	});

	it("is exact past the safe range on the way, and refuses an answer outside it", () => {
		expect(percentOf(Number.MAX_SAFE_INTEGER, 10_000)).toBe(Number.MAX_SAFE_INTEGER);
		expect(percentOf(Number.MAX_SAFE_INTEGER, 5000)).toBe(4_503_599_627_370_496);
		expect(() => percentOf(Number.MAX_SAFE_INTEGER, 20_000)).toThrow(RangeError);
		expect(() => percentOf(10.5, 2000)).toThrow(RangeError);
	});
});

describe("a line's amount", () => {
	it("is the quantity in thousandths times the unit price, rounded half up once", () => {
		expect(lineAmount(1000, 12_345)).toBe(12_345);
		expect(lineAmount(1500, 333)).toBe(500);
		expect(lineAmount(-1500, 333)).toBe(-500);
		expect(lineAmount(250, 1)).toBe(0);
		expect(lineAmount(0, 9999)).toBe(0);
		expect(() => lineAmount(1.5, 100)).toThrow(RangeError);
	});
});

describe("the totals of an invoice", () => {
	const vat: Tax = { id: "vat", basisPoints: 2000, compound: false };

	it("charge UK VAT at 20% on the lines that bear it", () => {
		const totals = invoiceTotals({
			lines: [
				{ amountMinor: 10_000, taxIds: ["vat"] },
				{ amountMinor: 2550, taxIds: ["vat"] },
				{ amountMinor: 1000, taxIds: [] },
			],
			discountBasisPoints: 0,
			taxes: [vat],
		});
		expect(totals).toEqual({
			subtotalMinor: 13_550,
			discountMinor: 0,
			taxes: [{ id: "vat", amountMinor: 2510 }],
			taxMinor: 2510,
			totalMinor: 16_060,
		});
	});

	it("take the discount off before tax", () => {
		const totals = invoiceTotals({
			lines: [
				{ amountMinor: 10_000, taxIds: ["vat"] },
				{ amountMinor: 2550, taxIds: ["vat"] },
			],
			discountBasisPoints: 1000,
			taxes: [vat],
		});
		expect(totals).toEqual({
			subtotalMinor: 12_550,
			discountMinor: 1255,
			taxes: [{ id: "vat", amountMinor: 2259 }],
			taxMinor: 2259,
			totalMinor: 13_554,
		});
	});

	it("tax the exact discounted amount, not the rounded one", () => {
		// 10% off 333 is 33.3, rounded to 33; VAT is 20% of 299.7, 59.94, so 60.
		const totals = invoiceTotals({
			lines: [{ amountMinor: 333, taxIds: ["vat"] }],
			discountBasisPoints: 1000,
			taxes: [vat],
		});
		expect(totals).toMatchObject({ discountMinor: 33, taxMinor: 60, totalMinor: 360 });
	});

	it("charge a compound tax on the line plus its simple taxes", () => {
		const totals = invoiceTotals({
			lines: [{ amountMinor: 10_000, taxIds: ["gst", "qst"] }],
			discountBasisPoints: 0,
			taxes: [
				{ id: "gst", basisPoints: 500, compound: false },
				{ id: "qst", basisPoints: 950, compound: true },
			],
		});
		// GST is 500. QST is 9.5% of 10 500, 997.5, so 998.
		expect(totals.taxes).toEqual([
			{ id: "gst", amountMinor: 500 },
			{ id: "qst", amountMinor: 998 },
		]);
		expect(totals.totalMinor).toBe(11_498);
	});

	it("charge a compound tax only on the simple taxes of the lines it is on", () => {
		const totals = invoiceTotals({
			lines: [
				{ amountMinor: 10_000, taxIds: ["gst"] },
				{ amountMinor: 10_000, taxIds: ["qst"] },
			],
			discountBasisPoints: 0,
			taxes: [
				{ id: "gst", basisPoints: 500, compound: false },
				{ id: "qst", basisPoints: 1000, compound: true },
			],
		});
		expect(totals.taxes).toEqual([
			{ id: "gst", amountMinor: 500 },
			{ id: "qst", amountMinor: 1000 },
		]);
	});

	it("round each tax once over all its lines, not line by line", () => {
		// Three lines of 1p at 50%: 0.5 each would round to 1 each, 3 in all;
		// the exact 1.5 rounds once to 2.
		const totals = invoiceTotals({
			lines: [1, 1, 1].map((amountMinor) => ({ amountMinor, taxIds: ["half"] })),
			discountBasisPoints: 0,
			taxes: [{ id: "half", basisPoints: 5000, compound: false }],
		});
		expect(totals.taxes).toEqual([{ id: "half", amountMinor: 2 }]);
	});

	it("list only the taxes some line bears, in the order the taxes were given", () => {
		const totals = invoiceTotals({
			lines: [{ amountMinor: 100, taxIds: ["b", "a"] }],
			discountBasisPoints: 0,
			taxes: [
				{ id: "a", basisPoints: 1000, compound: false },
				{ id: "unused", basisPoints: 1000, compound: false },
				{ id: "b", basisPoints: 2000, compound: false },
			],
		});
		expect(totals.taxes.map(({ id }) => id)).toEqual(["a", "b"]);
	});

	it("are nothing for an invoice with no lines", () => {
		expect(invoiceTotals({ lines: [], discountBasisPoints: 500, taxes: [vat] })).toEqual({
			subtotalMinor: 0,
			discountMinor: 0,
			taxes: [],
			taxMinor: 0,
			totalMinor: 0,
		});
	});

	it("refuse an unknown tax, a tax twice on a line, and rates outside 0 to 100%", () => {
		const line = (taxIds: string[]) => ({ amountMinor: 100, taxIds });
		expect(() =>
			invoiceTotals({ lines: [line(["nope"])], discountBasisPoints: 0, taxes: [vat] }),
		).toThrow(RangeError);
		expect(() =>
			invoiceTotals({ lines: [line(["vat", "vat"])], discountBasisPoints: 0, taxes: [vat] }),
		).toThrow(RangeError);
		expect(() =>
			invoiceTotals({ lines: [line([])], discountBasisPoints: 0, taxes: [vat, vat] }),
		).toThrow(RangeError);
		expect(() =>
			invoiceTotals({ lines: [line([])], discountBasisPoints: 10_001, taxes: [] }),
		).toThrow(RangeError);
		expect(() =>
			invoiceTotals({
				lines: [line([])],
				discountBasisPoints: 0,
				taxes: [{ id: "x", basisPoints: -1, compound: false }],
			}),
		).toThrow(RangeError);
		expect(() =>
			invoiceTotals({
				lines: [{ amountMinor: 0.5, taxIds: [] }],
				discountBasisPoints: 0,
				taxes: [],
			}),
		).toThrow(RangeError);
	});

	it("property: subtotal − discount + tax = total, and each tax is its exact amount rounded half up", () => {
		const next = random(2);
		for (let run = 0; run < 500; run++) {
			const taxes: Tax[] = Array.from({ length: below(next, 4) }, (_, index) => ({
				id: `t${index}`,
				basisPoints: below(next, 10_001),
				compound: next() < 0.3,
			}));
			const lines = Array.from({ length: below(next, 12) }, () => ({
				amountMinor: below(next, 2_000_000) - (next() < 0.1 ? 1_000_000 : 0),
				taxIds: taxes.filter(() => next() < 0.6).map(({ id }) => id),
			}));
			const discountBasisPoints = next() < 0.5 ? 0 : below(next, 10_001);
			const totals = invoiceTotals({ lines, discountBasisPoints, taxes });

			expect(totals.subtotalMinor - totals.discountMinor + totals.taxMinor).toBe(totals.totalMinor);
			expect(totals.subtotalMinor).toBe(
				lines.reduce((sum, { amountMinor }) => sum + amountMinor, 0),
			);
			expect(totals.discountMinor).toBe(percentOf(totals.subtotalMinor, discountBasisPoints));
			expect(totals.taxMinor).toBe(
				totals.taxes.reduce((sum, { amountMinor }) => sum + amountMinor, 0),
			);

			// An independent reckoning, line by line in exact fractions of 10⁻¹² of a minor unit.
			const scale = 10_000n;
			for (const tax of taxes) {
				const bearing = lines.filter(({ taxIds }) => taxIds.includes(tax.id));
				const reported = totals.taxes.find(({ id }) => id === tax.id);
				if (bearing.length === 0) {
					expect(reported).toBeUndefined();
					continue;
				}
				let exact = 0n;
				for (const line of bearing) {
					const base = BigInt(line.amountMinor) * (scale - BigInt(discountBasisPoints));
					if (!tax.compound) {
						exact += base * BigInt(tax.basisPoints) * scale;
						continue;
					}
					const simple = taxes
						.filter((other) => !other.compound && line.taxIds.includes(other.id))
						.reduce((sum, other) => sum + base * BigInt(other.basisPoints), 0n);
					exact += (base * scale + simple) * BigInt(tax.basisPoints);
				}
				const unit = scale ** 3n;
				const magnitude = exact < 0n ? -exact : exact;
				const rounded = (magnitude + unit / 2n) / unit;
				expect(reported?.amountMinor).toBe(Number(exact < 0n ? -rounded : rounded));
			}
		}
	});
});

describe("totals by currency", () => {
	it("are one per currency, ordered by code, and never add across currencies", () => {
		expect(
			totalsByCurrency([
				{ amountMinor: 100, currency: "USD" },
				{ amountMinor: 250, currency: "GBP" },
				{ amountMinor: 50, currency: "USD" },
				{ amountMinor: 1000, currency: "JPY" },
			]),
		).toEqual([
			{ currency: "GBP", amountMinor: 250 },
			{ currency: "JPY", amountMinor: 1000 },
			{ currency: "USD", amountMinor: 150 },
		]);
		expect(totalsByCurrency([])).toEqual([]);
	});

	it("refuse a malformed code or an amount that is not a safe integer", () => {
		expect(() => totalsByCurrency([{ amountMinor: 1, currency: "gbp" }])).toThrow(RangeError);
		expect(() => totalsByCurrency([{ amountMinor: 0.1, currency: "GBP" }])).toThrow(RangeError);
		expect(() =>
			totalsByCurrency([
				{ amountMinor: Number.MAX_SAFE_INTEGER, currency: "GBP" },
				{ amountMinor: 1, currency: "GBP" },
			]),
		).toThrow(RangeError);
	});

	it("property: each currency's total is the sum of its own amounts and no other", () => {
		const next = random(3);
		const codes = ["GBP", "EUR", "USD", "JPY"];
		for (let run = 0; run < 300; run++) {
			const items = Array.from({ length: below(next, 20) }, () => ({
				amountMinor: below(next, 200_000) - 100_000,
				currency: codes[below(next, codes.length)] as string,
			}));
			const totals = totalsByCurrency(items);
			expect(totals.map(({ currency }) => currency)).toEqual(
				[...new Set(items.map(({ currency }) => currency))].sort(),
			);
			for (const { currency, amountMinor } of totals) {
				expect(amountMinor).toBe(
					items.filter((item) => item.currency === currency).reduce((s, i) => s + i.amountMinor, 0),
				);
			}
		}
	});
});

describe("allocating an amount", () => {
	it("splits by weight and gives the leftover units to the largest remainders, earlier first on a tie", () => {
		expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
		expect(allocate(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
		expect(allocate(10, [1, 2])).toEqual([3, 7]);
		expect(allocate(5, [0, 1, 0])).toEqual([0, 5, 0]);
		expect(allocate(0, [3, 4])).toEqual([0, 0]);
		expect(allocate(2, [1, 1, 1])).toEqual([1, 1, 0]);
	});

	it("refuses weights that are all 0, negative or fractional", () => {
		expect(() => allocate(5, [])).toThrow(RangeError);
		expect(() => allocate(5, [0, 0])).toThrow(RangeError);
		expect(() => allocate(5, [1, -1])).toThrow(RangeError);
		expect(() => allocate(5, [0.5])).toThrow(RangeError);
	});

	it("property: the parts add up exactly, each within one unit of its exact share", () => {
		const next = random(4);
		for (let run = 0; run < 1000; run++) {
			const total = below(next, 2_000_000) - 1_000_000;
			const weights: number[] = Array.from({ length: 1 + below(next, 10) }, () =>
				next() < 0.2 ? 0 : below(next, 10_000),
			);
			if (!weights.some((weight) => weight !== 0)) weights[0] = 1;
			const parts = allocate(total, weights);
			const sum = weights.reduce((a, b) => a + b, 0);
			expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
			parts.forEach((part, index) => {
				const share = (total * (weights[index] as number)) / sum;
				expect(Math.abs(part - share)).toBeLessThan(1);
				if (weights[index] === 0) expect(part).toBe(0);
			});
			expect(allocate(total, weights)).toEqual(parts);
		}
	});
});

describe("formatting money", () => {
	it("writes minor units with the currency's own digits, as the locale writes money", () => {
		expect(formatMoney(123_456, "GBP", "en-GB")).toBe("£1,234.56");
		expect(formatMoney(-5, "GBP", "en-GB")).toBe("-£0.05");
		expect(formatMoney(1234, "JPY", "en-GB")).toMatch(/1,234$/);
		expect(formatMoney(1234, "KWD", "en-GB")).toMatch(/1\.234$/);
		expect(formatMoney(123_456, "EUR", "de-DE")).toBe("1.234,56\u00a0€");
	});

	it("refuses a fractional amount or a malformed code", () => {
		expect(() => formatMoney(1.5, "GBP", "en-GB")).toThrow(RangeError);
		expect(() => formatMoney(1, "£", "en-GB")).toThrow(RangeError);
	});
});
