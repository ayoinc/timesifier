import * as z from "zod";

/**
 * Payment terms (TS-074): how many days after its issue date an invoice is
 * due. Stored as a number of days; a person chooses one of Harvest's names
 * for the common ones, or types their own.
 */

export const TermsChoice = z.enum(["receipt", "net15", "net30", "net45", "net60", "custom"]);
export type TermsChoice = z.infer<typeof TermsChoice>;

const DAYS: Record<Exclude<TermsChoice, "custom">, number> = {
	receipt: 0,
	net15: 15,
	net30: 30,
	net45: 45,
	net60: 60,
};

export const TERMS_LABELS: Record<TermsChoice, string> = {
	receipt: "Upon receipt",
	net15: "Net 15",
	net30: "Net 30",
	net45: "Net 45",
	net60: "Net 60",
	custom: "Custom",
};

/** The most days terms may give: a year. */
export const MOST_TERMS_DAYS = 365;

/** The choice that names `days`, or `custom` for any other number. */
export function termsChoiceOf(days: number): TermsChoice {
	const named = (Object.keys(DAYS) as (keyof typeof DAYS)[]).find((key) => DAYS[key] === days);
	return named ?? "custom";
}

/** The days of a choice; `custom` takes the typed number, null when it is not one from 0 to 365. */
export function termsDays(choice: TermsChoice, customDays: string | undefined): number | null {
	if (choice !== "custom") return DAYS[choice];
	const days = Number(customDays?.trim());
	return Number.isInteger(days) && days >= 0 && days <= MOST_TERMS_DAYS && customDays?.trim()
		? days
		: null;
}

/** Terms in words: "Upon receipt", "Net 30", "Net 21". */
export function termsLabel(days: number): string {
	return days === 0 ? TERMS_LABELS.receipt : `Net ${days}`;
}
