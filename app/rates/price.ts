import { type BillableAmount, type BillingType, billableAmount } from "~/billing/billable";
import type { Day } from "~/time/calendar";

import { type RateLevel, type RateRow, rateLevel, resolveRate } from "./rates";

/**
 * What one piece of tracked time is worth (TS-067, B5): the project's billing
 * type and rate mode pick which rates may price it, `resolveRate` picks the
 * one in force on the time's own local day, and `billableAmount` multiplies.
 * Pure, so a report, a budget, the project page and profitability (TS-071)
 * price time the same way.
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
}

/** A piece of time to price: whose, on which task, whether billable, on which local day, and how long. */
export interface PricedTime {
	userId: string;
	taskId: string | null;
	billable: boolean;
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

/** What `time` on `project` is worth, in the project's currency. */
export function priceTime(
	project: PricedProject,
	rates: readonly RateRow[],
	time: PricedTime,
): BillableAmount {
	const billable = project.billingType !== "non_billable" && time.billable;
	return billableAmount({
		minutes: time.minutes,
		billable,
		billingType: project.billingType,
		rate: billable ? rateFor(project, rates, time) : null,
	});
}
