import { minorDigits } from "~/money/money";
import type { Day } from "~/time/calendar";

/**
 * Expenses (TS-070, B9): what one person spent on a project, in a category,
 * with its receipt. The rules here run in the browser and on the server alike:
 * how an amount or a quantity is typed and stored, which price a unit-priced
 * category charges on a day, and which files a receipt may be.
 */

/** The longest note an expense takes. */
export const EXPENSE_NOTES_MAX_LENGTH = 500;

/** The longest name of a unit, such as "mile". */
export const UNIT_NAME_MAX_LENGTH = 20;

/** The largest receipt: 10 MB. */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

/** The kinds of file a receipt may be, by media type, with the name a person reads. */
export const RECEIPT_TYPES = {
	"application/pdf": "PDF",
	"image/png": "PNG",
	"image/jpeg": "JPEG",
} as const;
export type ReceiptType = keyof typeof RECEIPT_TYPES;

/** What the receipt field offers in the file chooser. */
export const RECEIPT_ACCEPT = ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg";

/** The largest amount or unit price, in minor units: a trillion, well inside a safe integer. */
export const AMOUNT_MAX_MINOR = 1_000_000_000_000;

/** The largest quantity, in thousandths: a million units. */
export const QUANTITY_MAX_MILLI = 1_000_000_000;

/**
 * An amount typed in `currency` as minor units: "12", "12.5", "1,234.56" in
 * GBP are 1200, 1250 and 123456. Null when it is no amount: not a plain
 * number, more decimals than the currency has, negative, or too large.
 * Counted on the digits, never through a floating-point number.
 */
export function parseAmount(typed: string, currency: string): number | null {
	const text = typed.trim().replaceAll(",", "");
	const match = /^(\d+)(?:\.(\d*))?$/.exec(text);
	if (!match) return null;
	const digits = minorDigits(currency);
	const whole = match[1] ?? "0";
	const fraction = match[2] ?? "";
	if (fraction.length > digits) return null;
	const minor = Number(whole + fraction.padEnd(digits, "0"));
	return Number.isSafeInteger(minor) && minor <= AMOUNT_MAX_MINOR ? minor : null;
}

/** Minor units of `currency` as the amount field shows them: 1250 in GBP is "12.50". */
export function amountText(minor: number, currency: string): string {
	const digits = minorDigits(currency);
	if (digits === 0) return String(minor);
	const text = String(minor).padStart(digits + 1, "0");
	return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/**
 * A quantity typed as thousandths: "12" is 12000, "0.5" is 500. Null when it
 * is no quantity: not a plain number, more than three decimals, zero, or too
 * large.
 */
export function parseQuantity(typed: string): number | null {
	const text = typed.trim().replaceAll(",", "");
	const match = /^(\d+)(?:\.(\d{0,3}))?$/.exec(text);
	if (!match) return null;
	const milli = Number((match[1] ?? "0") + (match[2] ?? "").padEnd(3, "0"));
	return Number.isSafeInteger(milli) && milli > 0 && milli <= QUANTITY_MAX_MILLI ? milli : null;
}

/** Thousandths as a quantity is written: 12500 is "12.5", 12000 is "12". */
export function quantityText(milli: number): string {
	const whole = Math.floor(milli / 1000);
	const fraction = String(milli % 1000)
		.padStart(3, "0")
		.replace(/0+$/, "");
	return fraction ? `${whole}.${fraction}` : String(whole);
}

/** A unit price in force from a day. */
export interface DatedPrice {
	effectiveFrom: Day;
	unitPriceMinor: number;
}

/**
 * The unit price a category charges on `day`: the one set latest on or
 * before it, or, for a day before every price, the first price. Null when the
 * category has none.
 */
export function priceOn(prices: readonly DatedPrice[], day: Day): number | null {
	const sorted = [...prices].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
	let price = sorted[0]?.unitPriceMinor ?? null;
	for (const each of sorted) {
		if (each.effectiveFrom <= day) price = each.unitPriceMinor;
	}
	return price;
}

/**
 * Whether `bytes` begin as a file of `type` does: `%PDF-` for a PDF, the PNG
 * signature, or a JPEG's start of image. A file is taken for what it is, not
 * for what its name or the browser says.
 */
export function looksLike(type: ReceiptType, bytes: Uint8Array): boolean {
	const starts = (signature: readonly number[]) =>
		signature.every((byte, index) => bytes[index] === byte);
	switch (type) {
		case "application/pdf":
			return starts([0x25, 0x50, 0x44, 0x46, 0x2d]);
		case "image/png":
			return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		case "image/jpeg":
			return starts([0xff, 0xd8, 0xff]);
	}
}

/** Whether `type` is a media type a receipt may have. */
export function isReceiptType(type: string): type is ReceiptType {
	return Object.hasOwn(RECEIPT_TYPES, type);
}

/** What a person is told when a receipt is refused. */
export const RECEIPT_PROBLEM = "A receipt is a PDF, PNG or JPEG file of up to 10 MB.";

/** How the Expenses view of Reports groups its expenses. */
export const EXPENSE_GROUPS = ["category", "project", "person"] as const;
export type ExpenseGrouping = (typeof EXPENSE_GROUPS)[number];

export const EXPENSE_GROUP_LABELS: Record<ExpenseGrouping, string> = {
	category: "Category",
	project: "Project",
	person: "Person",
};

/** The grouping an address asks for, or null when it names none of them; category when it names nothing. */
export function expenseGrouping(value: string | null): ExpenseGrouping | null {
	if (value === null || value === "") return "category";
	return EXPENSE_GROUPS.find((each) => each === value) ?? null;
}
