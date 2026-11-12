import { describe, expect, it } from "vitest";

import {
	amountText,
	expenseGrouping,
	looksLike,
	parseAmount,
	parseQuantity,
	priceOn,
	quantityText,
} from "~/expenses/expenses";

// The rules of an expense that run in the browser and on the server alike
// (TS-070, B9): amounts and quantities as typed, the unit price on a day, and
// what a receipt's first bytes must be.

describe("an amount as typed", () => {
	it("is counted in the currency's minor units, on the digits", () => {
		expect(parseAmount("12", "GBP")).toBe(1200);
		expect(parseAmount("12.5", "GBP")).toBe(1250);
		expect(parseAmount(" 1,234.56 ", "GBP")).toBe(123_456);
		expect(parseAmount("0.10", "GBP")).toBe(10);
		expect(parseAmount("1500", "JPY")).toBe(1500);
		expect(parseAmount("1.234", "KWD")).toBe(1234);
	});

	it("is refused with more decimals than the currency has, a sign, or no number", () => {
		expect(parseAmount("12.505", "GBP")).toBeNull();
		expect(parseAmount("15.5", "JPY")).toBeNull();
		expect(parseAmount("-3", "GBP")).toBeNull();
		expect(parseAmount("", "GBP")).toBeNull();
		expect(parseAmount("12e3", "GBP")).toBeNull();
		expect(parseAmount("99999999999999", "GBP")).toBeNull();
	});

	it("is written back as the field shows it", () => {
		expect(amountText(1250, "GBP")).toBe("12.50");
		expect(amountText(5, "GBP")).toBe("0.05");
		expect(amountText(1500, "JPY")).toBe("1500");
	});
});

describe("a quantity as typed", () => {
	it("is thousandths, above nothing", () => {
		expect(parseQuantity("12")).toBe(12_000);
		expect(parseQuantity("12.5")).toBe(12_500);
		expect(parseQuantity("0.125")).toBe(125);
		expect(parseQuantity("0")).toBeNull();
		expect(parseQuantity("1.2345")).toBeNull();
		expect(quantityText(12_500)).toBe("12.5");
		expect(quantityText(12_000)).toBe("12");
		expect(quantityText(125)).toBe("0.125");
	});
});

describe("the unit price on a day", () => {
	const prices = [
		{ effectiveFrom: "2026-12-01", unitPriceMinor: 50 },
		{ effectiveFrom: "2026-01-01", unitPriceMinor: 45 },
	];

	it("is the one set latest on or before it, or the first for a day before them all", () => {
		expect(priceOn(prices, "2026-11-30")).toBe(45);
		expect(priceOn(prices, "2026-12-01")).toBe(50);
		expect(priceOn(prices, "2027-06-01")).toBe(50);
		expect(priceOn(prices, "2025-06-01")).toBe(45);
		expect(priceOn([], "2026-12-01")).toBeNull();
	});
});

describe("a receipt", () => {
	it("is taken for what its first bytes say", () => {
		const bytes = (...values: number[]) => new Uint8Array(values);
		expect(looksLike("application/pdf", new TextEncoder().encode("%PDF-1.7"))).toBe(true);
		expect(looksLike("image/png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(
			true,
		);
		expect(looksLike("image/jpeg", bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(true);
		expect(looksLike("image/png", new TextEncoder().encode("<svg"))).toBe(false);
		expect(looksLike("application/pdf", bytes(0xff, 0xd8, 0xff))).toBe(false);
	});
});

describe("the grouping of the Expenses view", () => {
	it("is category unless the address names another it has", () => {
		expect(expenseGrouping(null)).toBe("category");
		expect(expenseGrouping("person")).toBe("person");
		expect(expenseGrouping("client")).toBeNull();
	});
});
