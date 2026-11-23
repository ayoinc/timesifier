import { billableMinuteMinor } from "~/billing/billable";
import { formatMoney, roundHalfUp } from "~/money/money";
import type { Pricing } from "~/projects/money.server";
import { priceTime } from "~/rates/price";

import { hoursAndMinutes } from "./format";
import type { Sum } from "./report";

/**
 * A report's billable and non-billable time (TS-066) and, for those who see
 * rates, what the billable time is worth (TS-067): one total for each
 * currency, never added across them, each the exact sum of its entries
 * rounded once. Time is priced as the report's sums (`sumsOf` with
 * `pricedBy`), each the whole minutes of entries that all have the rate in
 * force on the first day of its span, so pricing a sum once is pricing each
 * of its entries and adding them up (docs/decisions.md entry 57). Regular and
 * overtime minutes are sums apart. Billable time with no rate is counted, and
 * worth 0.
 */
export interface BillableSplit {
	billable: string;
	nonBillable: string;
	total: string;
	/** For those who see rates: each currency's amount, by code. Null for anybody else. */
	amounts: { currency: string; amount: string }[] | null;
	/** How many entries are billable with no rate; null for those who do not see rates. */
	missingRates: number | null;
}

/**
 * The split of `sums`. `pricing` is null for a viewer who does not see rates;
 * given, the sums must have been read by its rates (`pricedBy(pricing)`).
 */
export function billableSplitOf(
	sums: readonly Sum[],
	pricing: Pricing | null,
	locale = "en-GB",
): BillableSplit {
	let billable = 0;
	let total = 0;
	for (const sum of sums) {
		total += sum.minutes * 60;
		if (sum.entry.billable) billable += sum.minutes * 60;
	}
	const split = {
		billable: hoursAndMinutes(billable),
		nonBillable: hoursAndMinutes(total - billable),
		total: hoursAndMinutes(total),
	};
	if (!pricing) return { ...split, amounts: null, missingRates: null };

	const exact = new Map<string, number>();
	let missing = 0;
	for (const { entry, day, minutes, entries } of sums) {
		const project = pricing.projects.get(entry.projectId);
		if (!project) continue;
		const amount = priceTime(project, pricing.rates, {
			userId: entry.userId,
			taskId: entry.taskId,
			billable: entry.billable,
			overtime: entry.overtime,
			day,
			minutes,
		});
		if (amount.kind === "missing-rate") missing += entries;
		if (amount.kind !== "billable") continue;
		exact.set(project.currency, (exact.get(project.currency) ?? 0) + billableMinuteMinor([amount]));
	}
	const amounts = [...exact]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([currency, minuteMinor]) => ({
			currency,
			amount: formatMoney(roundHalfUp(minuteMinor, 60), currency, locale),
		}));
	return { ...split, amounts, missingRates: missing };
}
