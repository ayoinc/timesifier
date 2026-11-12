import * as z from "zod";

import { roundHalfUp } from "~/money/money";
import type { RateRow } from "~/rates/rates";

/**
 * What tracked time is worth (TS-064, B5). An entry's amount is its minutes
 * times its hourly rate, kept exact as "minute-minor" units (minor units × 60)
 * until a total is shown. Only then is it divided by 60 and rounded, once, so
 * a total is the same however its entries are grouped and in whatever order
 * they are added.
 */

/**
 * How a project bills: by the hour (time and materials), at a fixed fee, or
 * not at all. A fixed-fee project's entries are still priced at their rates,
 * for its "if billed hourly" figure; the fee is the project's.
 */
export const BillingType = z.enum(["hourly", "fixed_fee", "non_billable"]);
export type BillingType = z.infer<typeof BillingType>;

/** Minutes in the hour a rate is quoted for. */
export const MINUTES_PER_HOUR = 60;

/** What an entry is worth. A missing rate is shown as such and counts 0 in totals. */
export type BillableAmount =
	| { kind: "non-billable" }
	| { kind: "missing-rate" }
	| {
			kind: "billable";
			/** Minutes × the hourly rate in minor units: 60 times the amount, exact. */
			minuteMinor: number;
	  };

/**
 * What `minutes` of work is worth. A non-billable project makes all its work
 * non-billable, whatever the entry says; otherwise the entry's own `billable`
 * decides. Billable work without a rate (`rate` null, see `resolveRate`) has a
 * missing rate.
 */
export function billableAmount(input: {
	minutes: number;
	billable: boolean;
	billingType: BillingType;
	rate: Pick<RateRow, "amountMinor"> | null;
}): BillableAmount {
	const { minutes, billable, billingType, rate } = input;
	if (billingType === "non_billable" || !billable) return { kind: "non-billable" };
	if (rate === null) return { kind: "missing-rate" };
	if (!Number.isSafeInteger(minutes) || minutes < 0) {
		throw new RangeError(`Not a number of minutes: ${minutes}`);
	}
	const minuteMinor = minutes * rate.amountMinor;
	if (!Number.isSafeInteger(minuteMinor)) {
		throw new RangeError("The amount is too large to hold exactly");
	}
	return { kind: "billable", minuteMinor };
}

/**
 * The exact worth of `items` in minute-minor units: what a group adds to a
 * larger total before anything is rounded. Non-billable work and missing rates
 * add 0.
 */
export function billableMinuteMinor(items: Iterable<BillableAmount>): number {
	let sum = 0;
	for (const item of items) {
		if (item.kind !== "billable") continue;
		sum += item.minuteMinor;
		if (!Number.isSafeInteger(sum)) throw new RangeError("The total is too large to hold exactly");
	}
	return sum;
}

/**
 * The worth of `items` in minor units: their exact sum divided by 60 and
 * rounded half up once (`roundHalfUp`). Rounding each entry first would let a
 * report's total drift from the sum of its rows.
 */
export function sumBillable(items: Iterable<BillableAmount>): number {
	return roundHalfUp(billableMinuteMinor(items), MINUTES_PER_HOUR);
}
