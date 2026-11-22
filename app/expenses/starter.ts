import type { DatedPrice } from "./expenses";

/**
 * The expense categories an organisation starts with (TS-119, S2-05): the
 * kinds of expense a UK business pays back most, so a person can record one
 * on their first visit. A new organisation is given them when it is created;
 * an owner or admin of one that has none adds them with one action. Each is an
 * ordinary category afterwards: renamed, repriced or archived in Workspace
 * settings. Nothing here reads the database, so the sheet that offers them
 * names them from the same list the server adds.
 */

/** Where HMRC publishes its approved mileage rates. */
export const HMRC_MILEAGE_RATES =
	"https://www.gov.uk/government/publications/rates-and-allowances-travel-mileage-and-fuel-allowances/travel-mileage-and-fuel-rates-and-allowances";

/**
 * HMRC's approved mileage rate for cars and vans, for the first 10,000
 * business miles of a tax year, in pence, from the first day of the tax year
 * it began in. GOV.UK, "Travel — mileage and fuel rates and allowances"
 * (updated 21 May 2026, `HMRC_MILEAGE_RATES`):
 *
 * - "Approved mileage rates from tax year 2011 to 2026 … Cars and vans | 45p"
 * - "Approved mileage rates from tax year 2026 to 2027 … Cars and vans | 55p"
 *
 * A tax year starts on 6 April. Each mile over 10,000 in a tax year is 25p,
 * which a price per unit cannot tell apart; an owner who pays it changes the
 * price. The rates are in pounds, so a starter Mileage is priced only for an
 * organisation whose currency is GBP.
 */
export const HMRC_CAR_MILEAGE_PENCE: readonly DatedPrice[] = [
	{ effectiveFrom: "2011-04-06", unitPriceMinor: 45 },
	{ effectiveFrom: "2026-04-06", unitPriceMinor: 55 },
];

/** The one currency HMRC's rate is in. */
export const MILEAGE_RATE_CURRENCY = "GBP";

/** The unit Mileage is counted in. */
export const MILE = "mile";

/** The starter categories, in the order a person reads them. */
export const USUAL_CATEGORIES = [
	"Travel",
	"Accommodation",
	"Meals and subsistence",
	"Mileage",
	"Equipment",
	"Software and subscriptions",
	"Training",
	"Other",
] as const;

/** The category priced per mile. */
export const MILEAGE: (typeof USUAL_CATEGORIES)[number] = "Mileage";

/** A starter category as it is added: plain, or priced per unit from dated prices. */
export interface UsualCategory {
	name: string;
	unit: { name: string; prices: readonly DatedPrice[] } | null;
}

/**
 * The starter categories for an organisation whose currency is `currency`:
 * Mileage at HMRC's rate per mile in GBP, and in any other currency an amount
 * each time, since HMRC's rate is in pounds.
 */
export function usualCategories(currency: string): UsualCategory[] {
	const priced = currency === MILEAGE_RATE_CURRENCY;
	return USUAL_CATEGORIES.map((name) => ({
		name,
		unit: name === MILEAGE && priced ? { name: MILE, prices: HMRC_CAR_MILEAGE_PENCE } : null,
	}));
}
