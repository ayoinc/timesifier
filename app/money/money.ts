import * as z from "zod";

/**
 * Money in integer minor units (TS-064, B5, B11). An amount is a whole number
 * of the currency's smallest unit, pence for GBP and yen for JPY, and always
 * travels with its currency code. No amount is ever a fraction: where a
 * calculation divides, it says where it rounds, and it rounds once.
 *
 * The rounding rule is round half up in magnitude: a half rounds away from
 * zero, so 2.5 becomes 3 and −2.5 becomes −3. A negative amount, a credit,
 * rounds as its positive would with the sign put back, so a credit note is the
 * mirror of the invoice it cancels.
 *
 * Arithmetic that could pass `Number.MAX_SAFE_INTEGER` on the way is done in
 * BigInt, and every answer is checked to be a safe integer before it is
 * returned.
 */

/** An ISO 4217 currency code as a form carries it: three upper-case letters. */
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, "Not a currency code.");

/** Whether `value` is shaped like an ISO 4217 code: three upper-case letters. */
export function isCurrencyCode(value: string): boolean {
	return /^[A-Z]{3}$/.test(value);
}

function requireCurrency(currency: string): void {
	if (!isCurrencyCode(currency)) throw new RangeError(`Not a currency code: ${currency}`);
}

/** Throws unless `value` is a safe integer, naming it as `what`. */
function requireSafe(value: number, what: string): void {
	if (!Number.isSafeInteger(value)) throw new RangeError(`${what} is not a safe integer: ${value}`);
}

/** The BigInt `value` as a number, or a RangeError when it is not a safe integer. */
function toSafe(value: bigint, what: string): number {
	if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
		throw new RangeError(`${what} is too large to hold exactly`);
	}
	return Number(value);
}

/** `numerator / denominator` rounded half up in magnitude; `denominator` is positive. */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
	const negative = numerator < 0n;
	const magnitude = negative ? -numerator : numerator;
	const quotient = (magnitude * 2n + denominator) / (denominator * 2n);
	return negative ? -quotient : quotient;
}

const digitsByCurrency = new Map<string, number>();

/**
 * How many digits the currency's minor unit has: 2 for GBP, 0 for JPY, 3 for
 * KWD, as the platform's currency data says. A well-formed code the platform
 * does not know gets 2.
 */
export function minorDigits(currency: string): number {
	requireCurrency(currency);
	let digits = digitsByCurrency.get(currency);
	if (digits === undefined) {
		const options = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions();
		digits = options.maximumFractionDigits ?? 2;
		digitsByCurrency.set(currency, digits);
	}
	return digits;
}

/**
 * `numerator / denominator` as a whole number, rounded half up in magnitude
 * (see the module's rule). Both are safe integers and `denominator` is positive.
 */
export function roundHalfUp(numerator: number, denominator: number): number {
	requireSafe(numerator, "The numerator");
	requireSafe(denominator, "The denominator");
	if (denominator <= 0) throw new RangeError("The denominator must be positive");
	return toSafe(divideHalfUp(BigInt(numerator), BigInt(denominator)), "The quotient");
}

/** Basis points in a whole: 10 000 is 100%. */
export const BASIS_POINTS = 10_000;

/** `basisPoints` of `amountMinor` (2000 is 20%), rounded half up once. */
export function percentOf(amountMinor: number, basisPoints: number): number {
	requireSafe(amountMinor, "The amount");
	requireSafe(basisPoints, "The basis points");
	return toSafe(
		divideHalfUp(BigInt(amountMinor) * BigInt(basisPoints), BigInt(BASIS_POINTS)),
		"The share",
	);
}

/**
 * A line's amount: `quantityMilli` thousandths (1500 is 1.5) at
 * `unitPriceMinor` each, rounded half up once.
 */
export function lineAmount(quantityMilli: number, unitPriceMinor: number): number {
	requireSafe(quantityMilli, "The quantity");
	requireSafe(unitPriceMinor, "The unit price");
	return toSafe(divideHalfUp(BigInt(quantityMilli) * BigInt(unitPriceMinor), 1000n), "The amount");
}

/** A tax as an invoice or an estimate applies it. */
export interface Tax {
	id: string;
	/** The rate: 2000 is 20%, from 0 to 10 000. */
	basisPoints: number;
	/** A compound tax is charged on the line's amount plus its simple taxes. */
	compound: boolean;
}

/** A line as the totals see it: its amount and the taxes it bears. */
export interface TotalsLine {
	amountMinor: number;
	taxIds: readonly string[];
}

/** What an invoice or estimate comes to. `subtotal − discount + tax = total`, always. */
export interface InvoiceTotals {
	subtotalMinor: number;
	discountMinor: number;
	/** One amount per tax some line bears, in the order the taxes were given. */
	taxes: { id: string; amountMinor: number }[];
	taxMinor: number;
	totalMinor: number;
}

/**
 * The totals of an invoice or an estimate (B11, B12).
 *
 * - The subtotal is the sum of the lines.
 * - The discount is `discountBasisPoints` of the subtotal, rounded half up once.
 *   It comes off before tax: each line is taxed on its discounted amount.
 * - A simple tax is its rate of the discounted amount of each line that bears it.
 * - A compound tax is its rate of each such line's discounted amount plus the
 *   simple taxes on that line. It is never charged on another compound tax.
 * - Each tax is added up exactly over its lines and rounded half up once, not
 *   line by line, so a tax is never a penny out for having many lines.
 * - The total is `subtotal − discount + tax`, so the four always agree.
 *
 * A line naming a tax that is not given, or the same tax twice, is an error.
 */
export function invoiceTotals(input: {
	lines: readonly TotalsLine[];
	discountBasisPoints: number;
	taxes: readonly Tax[];
}): InvoiceTotals {
	const { lines, discountBasisPoints, taxes } = input;
	requireSafe(discountBasisPoints, "The discount");
	if (discountBasisPoints < 0 || discountBasisPoints > BASIS_POINTS) {
		throw new RangeError("The discount must be from 0 to 10 000 basis points");
	}
	const byId = new Map<string, Tax>();
	for (const tax of taxes) {
		requireSafe(tax.basisPoints, "A tax rate");
		if (tax.basisPoints < 0 || tax.basisPoints > BASIS_POINTS) {
			throw new RangeError("A tax rate must be from 0 to 10 000 basis points");
		}
		if (byId.has(tax.id)) throw new RangeError(`The tax ${tax.id} is given twice`);
		byId.set(tax.id, tax);
	}

	const scale = BigInt(BASIS_POINTS);
	const kept = scale - BigInt(discountBasisPoints);
	let subtotal = 0n;
	// Each tax's exact amount, in minor units times scale³: the discounted base
	// is in units of 1/scale, a simple tax of 1/scale², a compound tax of 1/scale³.
	const exact = new Map<string, bigint>();
	for (const line of lines) {
		requireSafe(line.amountMinor, "A line's amount");
		const amount = BigInt(line.amountMinor);
		subtotal += amount;
		const lineTaxes: Tax[] = [];
		for (const id of line.taxIds) {
			const tax = byId.get(id);
			if (tax === undefined) throw new RangeError(`A line bears the unknown tax ${id}`);
			if (lineTaxes.includes(tax)) throw new RangeError(`A line bears the tax ${id} twice`);
			lineTaxes.push(tax);
		}
		const base = amount * kept;
		let simple = 0n;
		for (const tax of lineTaxes) {
			if (tax.compound) continue;
			const charged = base * BigInt(tax.basisPoints);
			simple += charged;
			exact.set(tax.id, (exact.get(tax.id) ?? 0n) + charged * scale);
		}
		for (const tax of lineTaxes) {
			if (!tax.compound) continue;
			const charged = (base * scale + simple) * BigInt(tax.basisPoints);
			exact.set(tax.id, (exact.get(tax.id) ?? 0n) + charged);
		}
	}

	const discount = divideHalfUp(subtotal * BigInt(discountBasisPoints), scale);
	const taxLines: { id: string; amountMinor: number }[] = [];
	let taxTotal = 0n;
	for (const tax of taxes) {
		const sum = exact.get(tax.id);
		if (sum === undefined) continue;
		const amount = divideHalfUp(sum, scale * scale * scale);
		taxTotal += amount;
		taxLines.push({ id: tax.id, amountMinor: toSafe(amount, "A tax") });
	}
	return {
		subtotalMinor: toSafe(subtotal, "The subtotal"),
		discountMinor: toSafe(discount, "The discount"),
		taxes: taxLines,
		taxMinor: toSafe(taxTotal, "The tax"),
		totalMinor: toSafe(subtotal - discount + taxTotal, "The total"),
	};
}

/** An amount with its currency. */
export interface Money {
	amountMinor: number;
	currency: string;
}

/**
 * One total per currency, ordered by code. Amounts in different currencies
 * are never added together: there is no conversion (B5).
 */
export function totalsByCurrency(items: readonly Money[]): Money[] {
	const sums = new Map<string, bigint>();
	for (const { amountMinor, currency } of items) {
		requireCurrency(currency);
		requireSafe(amountMinor, "An amount");
		sums.set(currency, (sums.get(currency) ?? 0n) + BigInt(amountMinor));
	}
	return [...sums]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([currency, sum]) => ({ currency, amountMinor: toSafe(sum, `The ${currency} total`) }));
}

/**
 * `totalMinor` split in proportion to `weights` (non-negative safe integers,
 * at least one above 0), in whole minor units that add up to it exactly.
 * Each part gets the whole units of its exact share; the units left over go
 * one each to the parts with the largest remainders, the earlier part first
 * on a tie. A negative total is split as its positive and every part negated.
 */
export function allocate(totalMinor: number, weights: readonly number[]): number[] {
	requireSafe(totalMinor, "The total");
	let sum = 0n;
	for (const weight of weights) {
		requireSafe(weight, "A weight");
		if (weight < 0) throw new RangeError("A weight cannot be negative");
		sum += BigInt(weight);
	}
	if (sum === 0n) throw new RangeError("At least one weight must be above 0");
	const negative = totalMinor < 0;
	const total = BigInt(Math.abs(totalMinor));
	const parts = weights.map((weight) => (total * BigInt(weight)) / sum);
	const remainders = weights.map((weight, index) => ({
		index,
		remainder: (total * BigInt(weight)) % sum,
	}));
	let left = total - parts.reduce((a, b) => a + b, 0n);
	remainders.sort((a, b) =>
		a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
	);
	for (const { index } of remainders) {
		if (left === 0n) break;
		parts[index] = (parts[index] as bigint) + 1n;
		left -= 1n;
	}
	return parts.map((part) => Number(negative ? -part : part));
}

/**
 * `minor` units of `currency` as `locale` writes money: `formatMoney(123456,
 * "GBP", "en-GB")` is "£1,234.56".
 */
export function formatMoney(minor: number, currency: string, locale: string): string {
	requireSafe(minor, "The amount");
	const digits = minorDigits(currency);
	return new Intl.NumberFormat(locale, {
		style: "currency",
		currency,
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	}).format(minor / 10 ** digits);
}
