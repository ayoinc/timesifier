import { type BillableAmount, type BillingType, billableAmount } from "~/billing/billable";
import { roundHalfUp } from "~/money/money";
import type { Day } from "~/time/calendar";

import { type RateLevel, type RateRow, rateLevel, resolveRate } from "./rates";

/**
 * What one piece of tracked time is worth (TS-067, B5): the project's billing
 * type and rate mode pick which rates may price it, `resolveRate` picks the
 * one in force on the time's own local day, and `billableAmount` multiplies.
 * Overtime is billed at that rate times the project's multiplier (D9, OQ4).
 * Pure, so a report, a budget, the project page, profitability (TS-071) and
 * an invoice price time the same way.
 */

/** Which rate prices an hourly or fixed-fee project's time: one for the project, each person's, or each task's. */
export type RateMode = "project" | "person" | "task";

/** The levels of rate each mode reads, the most particular first. */
export const LEVELS_OF_MODE: Readonly<Record<RateMode, readonly RateLevel[]>> = {
	project: ["project"],
	person: ["project-person", "person"],
	task: ["project-task", "task"],
};

/** A project as pricing reads it. `currency` is the one its money is in (its own, its client's or the organisation's). */
export interface PricedProject {
	id: string;
	billingType: BillingType;
	rateMode: RateMode;
	currency: string;
	/** What its overtime is billed at: the rate times this, in thousandths (1000 is ×1). */
	overtimeRateMilli: number;
}

/** A piece of time to price: whose, on which task, whether billable and overtime, on which local day, and how long. */
export interface PricedTime {
	userId: string;
	taskId: string | null;
	billable: boolean;
	/** Whether it is overtime (TS-095), billed at the project's multiplier. */
	overtime: boolean;
	day: Day;
	/** Whole minutes (`wholeMinutes`). */
	minutes: number;
}

/** Whole minutes in `seconds`, rounded down: what time is priced by. */
export function wholeMinutes(seconds: number): number {
	return Math.floor(seconds / 60);
}

/**
 * The billable rate that prices `time` on `project`, or null for none (a
 * missing rate). Only the levels of the project's mode count, and only rates
 * in the project's currency: there is no conversion, so a person's default
 * in pounds does not price a project billed in dollars.
 */
export function rateFor(
	project: PricedProject,
	rates: readonly RateRow[],
	time: Pick<PricedTime, "userId" | "taskId" | "day">,
): RateRow | null {
	const levels = LEVELS_OF_MODE[project.rateMode];
	const usable = rates.filter(
		(row) =>
			row.kind === "billable" &&
			row.currency === project.currency &&
			levels.includes(rateLevel(row)) &&
			(row.projectId === null || row.projectId === project.id),
	);
	return resolveRate(usable, {
		kind: "billable",
		projectId: project.id,
		userId: project.rateMode === "person" ? time.userId : null,
		taskId: project.rateMode === "task" ? time.taskId : null,
		on: time.day,
	});
}

/** Thousandths in one: a multiplier of 1500 is ×1.5. */
export const MULTIPLIER_ONE = 1000;

/**
 * An overtime hour's price: the rate times the multiplier, rounded half up to
 * a minor unit once, here. Its minutes are then priced at it exactly, as any
 * rate's are, so the total is still rounded once and an invoice line's hours
 * times its price are its amount.
 */
export function overtimeRate(amountMinor: number, multiplierMilli: number): number {
	return roundHalfUp(amountMinor * multiplierMilli, MULTIPLIER_ONE);
}

/**
 * The price of an hour of `time` on `project`, in minor units: the rate in
 * force on its day (`rateFor`), times the project's multiplier for overtime;
 * null for no rate.
 */
export function hourlyPrice(
	project: PricedProject,
	rates: readonly RateRow[],
	time: Pick<PricedTime, "userId" | "taskId" | "day" | "overtime">,
): number | null {
	const rate = rateFor(project, rates, time);
	if (rate === null) return null;
	return time.overtime
		? overtimeRate(rate.amountMinor, project.overtimeRateMilli)
		: rate.amountMinor;
}

/** What `time` on `project` is worth, in the project's currency. */
export function priceTime(
	project: PricedProject,
	rates: readonly RateRow[],
	time: PricedTime,
): BillableAmount {
	const billable = project.billingType !== "non_billable" && time.billable;
	const price = billable ? hourlyPrice(project, rates, time) : null;
	return billableAmount({
		minutes: time.minutes,
		billable,
		billingType: project.billingType,
		rate: price === null ? null : { amountMinor: price },
	});
}
