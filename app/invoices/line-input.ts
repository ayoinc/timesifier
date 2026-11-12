import * as z from "zod";

import { parseMoney } from "~/money/typed";

import { parseQuantity } from "./lines";

/**
 * A line as a form sends it, for an invoice, an estimate or a recurring
 * invoice alike (TS-073, TS-077, TS-078): its words, quantity and unit price
 * as typed, and up to two of the organisation's taxes. The action reads the
 * numbers in the document's currency.
 */

/** The value a tax field sends for "no tax". */
export const NO_TAX = "none";

export const DESCRIPTION_MAX_LENGTH = 500;

export const LineFields = {
	description: z.string().max(2000),
	quantity: z.string().max(40),
	unitPrice: z.string().max(40),
	tax: z.string().min(1).max(64),
	secondTax: z.string().min(1).max(64),
};

export interface ParsedLine {
	description: string;
	quantityMilli: number;
	unitPriceMinor: number;
	taxId: string | null;
	secondTaxId: string | null;
}

/** The line typed, in `currency`, or the sentence that says what is wrong with it. */
export function parseLine(
	fields: {
		description: string;
		quantity: string;
		unitPrice: string;
		tax: string;
		secondTax: string;
	},
	currency: string,
): { ok: true; line: ParsedLine } | { ok: false; problem: string } {
	const description = fields.description.trim();
	if (description === "" || description.length > DESCRIPTION_MAX_LENGTH) {
		return {
			ok: false,
			problem: `Describe the line in up to ${DESCRIPTION_MAX_LENGTH} characters.`,
		};
	}
	const quantityMilli = parseQuantity(fields.quantity);
	if (quantityMilli === null) {
		return { ok: false, problem: "Enter a quantity above 0, such as 1 or 7.5." };
	}
	const unitPriceMinor = parseMoney(fields.unitPrice, currency);
	if (unitPriceMinor === null) {
		return { ok: false, problem: "Enter a unit price, such as 120.00." };
	}
	const taxId = fields.tax === NO_TAX ? null : fields.tax;
	const secondTaxId = fields.secondTax === NO_TAX || taxId === null ? null : fields.secondTax;
	return { ok: true, line: { description, quantityMilli, unitPriceMinor, taxId, secondTaxId } };
}
