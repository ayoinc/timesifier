import * as z from "zod";

import { addDays, type Day } from "~/time/calendar";

/**
 * Project budgets (TS-064, B7). A budget is in minutes or in minor units,
 * as the project's `budget_kind` says, and runs over the project's life or,
 * when it resets monthly, over each calendar month in the organisation's zone.
 * Tracking is never blocked by a budget: it only warns and alerts.
 */

/** What a project's budget counts, if anything. */
export const BudgetKind = z.enum([
	"none",
	"total_hours",
	"task_hours",
	"person_hours",
	"total_fees",
	"task_fees",
]);
export type BudgetKind = z.infer<typeof BudgetKind>;

/** Whether a budget of `kind` counts time (in minutes) rather than money. */
export function isHoursBudget(kind: BudgetKind): boolean {
	return kind === "total_hours" || kind === "task_hours" || kind === "person_hours";
}

/**
 * The day a budget that never resets starts on when its project has no start
 * day: before any entry. It is also the fixed `period_starts_on` its alerts
 * are kept under.
 */
export const LIFETIME_START: Day = "1970-01-01";

/** The days a budget's spending is counted over. `endsOn` null runs on with no end. */
export interface BudgetPeriod {
	startsOn: Day;
	endsOn: Day | null;
}

/**
 * The budget period that holds `today`, the organisation's local date. A
 * monthly budget runs from the first to the last day of `today`'s month, so it
 * resets at local midnight on the 1st. Any other runs from `projectStartedOn`
 * (or `LIFETIME_START`) with no end. A monthly period is the whole month even
 * when the project started within it, so its alerts have one key per month.
 */
export function budgetPeriod(input: {
	resetsMonthly: boolean;
	today: Day;
	projectStartedOn?: Day | null;
}): BudgetPeriod {
	const { resetsMonthly, today, projectStartedOn } = input;
	if (!resetsMonthly) return { startsOn: projectStartedOn ?? LIFETIME_START, endsOn: null };
	const startsOn = `${today.slice(0, 7)}-01`;
	// Day 28 of any month plus four days is always in the next month.
	const nextMonth = `${addDays(`${today.slice(0, 7)}-28`, 4).slice(0, 7)}-01`;
	return { startsOn, endsOn: addDays(nextMonth, -1) };
}

/** A budget's amount and what has been spent against it, both in its unit. */
export interface BudgetInput {
	amount: number;
	spent: number;
}

/** Where a budget stands. */
export interface BudgetStatus {
	spent: number;
	/** `amount − spent`: below 0 once over. */
	remaining: number;
	/**
	 * The whole percentage spent, rounded down, so 100 is shown only once the
	 * budget is all spent. Null for a budget of 0, which has no share to show.
	 */
	percent: number | null;
	/** Spent more than the amount. A budget of 0 is over as soon as anything is spent. */
	over: boolean;
}

function requireAmounts({ amount, spent }: BudgetInput): void {
	if (!Number.isSafeInteger(amount) || amount < 0) {
		throw new RangeError(`Not a budget amount: ${amount}`);
	}
	if (!Number.isSafeInteger(spent) || spent < 0)
		throw new RangeError(`Not an amount spent: ${spent}`);
}

/** Where a budget of `amount` stands with `spent` spent against it. */
export function budgetStatus(input: BudgetInput): BudgetStatus {
	requireAmounts(input);
	const { amount, spent } = input;
	return {
		spent,
		remaining: amount - spent,
		percent: amount === 0 ? null : Number((BigInt(spent) * 100n) / BigInt(amount)),
		over: spent > amount,
	};
}

/** Whether `budget` has reached `thresholdPercent`; a budget of 0 reaches every threshold once over. */
function reached(budget: BudgetInput, thresholdPercent: number): boolean {
	if (budget.amount === 0) return budget.spent > 0;
	return BigInt(budget.spent) * 100n >= BigInt(thresholdPercent) * BigInt(budget.amount);
}

/**
 * Whether a change from `before` to `after` takes spending to the alert's
 * `thresholdPercent` of the budget, or past it, from below. It is exact: 80%
 * of 999 minutes is reached at 799.2, so at 800 and not at 799. Crossing again
 * in the same period is the caller's to suppress (`budget_alerts`).
 */
export function crossedThreshold(
	before: BudgetInput,
	after: BudgetInput,
	thresholdPercent: number,
): boolean {
	requireAmounts(before);
	requireAmounts(after);
	if (!Number.isSafeInteger(thresholdPercent) || thresholdPercent <= 0) {
		throw new RangeError(`Not an alert percentage: ${thresholdPercent}`);
	}
	return !reached(before, thresholdPercent) && reached(after, thresholdPercent);
}

/**
 * Whether an entry counts against an hours budget: a billable one always,
 * a non-billable one when the organisation counts them
 * (`budget_counts_non_billable`).
 */
export function countsTowardHours(billable: boolean, countNonBillable: boolean): boolean {
	return billable || countNonBillable;
}
