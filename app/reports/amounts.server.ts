import { billableMinuteMinor } from "~/billing/billable";
import { formatMoney, roundHalfUp } from "~/money/money";
import { maySeeRates } from "~/organisations/access";
import type { Membership } from "~/organisations/membership.server";
import { organisationMoney, pricingOf } from "~/projects/money.server";
import { priceTime } from "~/rates/price";

import { hoursAndMinutes } from "./format";
import type { Row } from "./report";
import type { ReportRequest } from "./reports.server";

/**
 * A report's billable and non-billable time (TS-066) and, for those who see
 * rates, what the billable time is worth (TS-067): one total for each
 * currency, never added across them, each the exact sum of its rows
 * rounded once. A row is priced for its whole minutes at the rate in force on
 * the local day it starts. Billable time with no rate is counted, and worth 0.
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

export async function billableSplitOf(
	request: Pick<ReportRequest, "scope">,
	rows: readonly Row[],
	membership: Membership,
	locale = "en-GB",
): Promise<BillableSplit> {
	let billable = 0;
	let total = 0;
	for (const row of rows) {
		total += row.minutes * 60;
		if (row.entry.billable) billable += row.minutes * 60;
	}
	const split = {
		billable: hoursAndMinutes(billable),
		nonBillable: hoursAndMinutes(total - billable),
		total: hoursAndMinutes(total),
	};
	if (!maySeeRates(membership.role)) return { ...split, amounts: null, missingRates: null };

	const money = await organisationMoney(membership.organisation.id);
	const pricing = await pricingOf(request.scope, money.currency);
	const exact = new Map<string, number>();
	const missing = new Set<string>();
	for (const { entry, day, minutes } of rows) {
		const project = pricing.projects.get(entry.projectId);
		if (!project) continue;
		const amount = priceTime(project, pricing.rates, {
			userId: entry.userId,
			taskId: entry.taskId,
			billable: entry.billable,
			day,
			minutes,
		});
		if (amount.kind === "missing-rate") missing.add(entry.id);
		if (amount.kind !== "billable") continue;
		exact.set(project.currency, (exact.get(project.currency) ?? 0) + billableMinuteMinor([amount]));
	}
	const amounts = [...exact]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([currency, minuteMinor]) => ({
			currency,
			amount: formatMoney(roundHalfUp(minuteMinor, 60), currency, locale),
		}));
	return { ...split, amounts, missingRates: missing.size };
}
