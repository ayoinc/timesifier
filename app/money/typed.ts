import { minorDigits } from "./money";

/**
 * Money and percentages as a person types them into a form (TS-067, B5).
 * Each reads the plain digits a field holds, with an optional thousands
 * comma and a decimal point, and gives a whole number or null for text that
 * is not one. Nothing is rounded: more decimals than the currency has is not
 * an amount.
 */

/** The most minor units a typed amount may be: a billion in a two-digit currency. */
export const MOST_MINOR = 100_000_000_000;

/**
 * `text` as minor units of `currency`: "1,234.50" in GBP is 123450, "1200"
 * in JPY is 1200. Null for empty text, a negative, more decimals than the
 * currency has, or more than `MOST_MINOR`.
 */
export function parseMoney(text: string, currency: string): number | null {
	const digits = minorDigits(currency);
	const match = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/.exec(text.trim());
	if (!match) return null;
	const [, whole = "", fraction = ""] = match;
	if (fraction.length > digits) return null;
	const minor =
		Number(whole.replaceAll(",", "")) * 10 ** digits + Number(fraction.padEnd(digits, "0") || "0");
	return Number.isSafeInteger(minor) && minor <= MOST_MINOR ? minor : null;
}

/**
 * `minor` units of `currency` as a field shows them for editing: plain
 * digits and the decimal point, no symbol or grouping. 123450 in GBP is
 * "1234.50"; what `parseMoney` reads back to the same number.
 */
export function moneyText(minor: number, currency: string): string {
	const digits = minorDigits(currency);
	if (digits === 0) return String(minor);
	const sign = minor < 0 ? "-" : "";
	const whole = Math.floor(Math.abs(minor) / 10 ** digits);
	const fraction = String(Math.abs(minor) % 10 ** digits).padStart(digits, "0");
	return `${sign}${whole}.${fraction}`;
}

/**
 * A percentage as typed, in basis points: "20" is 2000, "17.5" is 1750,
 * "0.25" is 25. Null for text that is not one, more than two decimals, or
 * more than `most` percent (100 unless said).
 */
export function parsePercent(text: string, most = 100): number | null {
	const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
	if (!match) return null;
	const [, whole = "", fraction = ""] = match;
	const basisPoints = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
	return basisPoints <= most * 100 ? basisPoints : null;
}

/**
 * Hours as typed into a budget: "120", "37.5" or "1,200", as whole minutes.
 * Null for text that is not one, or more than two decimals.
 */
export function parseBudgetHours(text: string): number | null {
	const match = /^(\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.(\d{1,2}))?$/.exec(text.trim());
	if (!match) return null;
	const [, whole = "", fraction = ""] = match;
	return Number(whole.replaceAll(",", "")) * 60 + Math.round(Number(`0.${fraction || "0"}`) * 60);
}
