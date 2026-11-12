import { type BillableAmount, billableMinuteMinor, MINUTES_PER_HOUR } from "~/billing/billable";
import { roundHalfUp } from "~/money/money";
import { type PricedProject, priceTime } from "~/rates/price";
import { type RateRow, resolveRate } from "~/rates/rates";
import { type Day, daysFrom } from "~/time/calendar";
import type { ReportDays } from "./query";
import type { Row } from "./report";

/**
 * Profitability (TS-071, B6), as Harvest's Profitability report counts it
 * (research/harvest-b2b.md, section 4; Harvest's "Profitability report FAQ"):
 *
 * - Revenue of an hourly project is the billable amount of its time
 *   (`priceTime`) plus its billable expenses in its currency. Revenue of a
 *   fixed-fee project is its fee spread evenly over its start-to-end days:
 *   the fee ÷ its days × its days in the range. A non-billable project has
 *   none.
 * - Cost is each row of time at the person's cost rate in force on its
 *   local day, plus every expense, billable or not.
 * - Cost rates are in the organisation's currency, and there is no
 *   conversion: a project billed in another currency shows its revenue in
 *   that currency and no profit.
 *
 * Amounts are summed exactly in minute-minor units and rounded once.
 */

/** A project as profitability reads it. */
export interface ProfitProject extends PricedProject {
	name: string;
	client: string | null;
	feeMinor: number | null;
	startsOn: Day | null;
	endsOn: Day | null;
}

/** An expense as profitability reads it. */
export interface ProfitExpense {
	projectId: string;
	amountMinor: number;
	currency: string;
	billable: boolean;
}

/** One project's money over the range. Revenue is in the project's currency; cost and profit in the organisation's. */
export interface ProfitLine {
	projectId: string;
	project: string;
	client: string | null;
	billingType: PricedProject["billingType"];
	currency: string;
	/** Null for a fixed-fee project without its fee or its dates. */
	revenueMinor: number | null;
	costMinor: number;
	/** Revenue less cost, when both are in the organisation's currency and revenue is known. */
	profitMinor: number | null;
	/** Profit as a share of revenue; null without profit or revenue. */
	margin: number | null;
	/** Seconds of time priced with no billable rate: counted as nothing. */
	missingRateSeconds: number;
	/** Seconds of time with no cost rate: counted as nothing. */
	missingCostSeconds: number;
	/** Whether the project is fixed fee and lacks its fee or its dates. */
	missingFeeOrDates: boolean;
}

/** Everything in the organisation's currency, added up. */
export interface ProfitTotals {
	currency: string;
	/** Revenue of the projects billed in the organisation's currency. */
	revenueMinor: number;
	costMinor: number;
	profitMinor: number;
	margin: number | null;
}

/** The days `range` and the project's dates share. */
function sharedDays(project: { startsOn: Day; endsOn: Day }, range: ReportDays): number {
	const first = Math.max(project.startsOn, range.first);
	const last = Math.min(project.endsOn, range.last);
	return first > last ? 0 : daysFrom(first, last).length;
}

/**
 * The part of a fixed fee earned over `range`: the fee ÷ the project's days ×
 * its days in the range, rounded half up once. Null when the project lacks
 * its fee or its dates, or its dates are backwards.
 */
export function spreadFee(
	project: Pick<ProfitProject, "feeMinor" | "startsOn" | "endsOn">,
	range: ReportDays,
): number | null {
	const { feeMinor, startsOn, endsOn } = project;
	if (feeMinor === null || startsOn === null || endsOn === null || endsOn < startsOn) return null;
	const days = daysFrom(startsOn, endsOn).length;
	return roundHalfUp(feeMinor * sharedDays({ startsOn, endsOn }, range), days);
}

/** The cost rate in force for `userId`'s time on `projectId` on `day`, in `currency`, or null for none. */
export function costRateFor(
	rates: readonly RateRow[],
	currency: string,
	time: { userId: string; projectId: string; day: Day },
): RateRow | null {
	return resolveRate(
		rates.filter((r) => r.kind === "cost" && r.currency === currency),
		{ kind: "cost", userId: time.userId, projectId: time.projectId, taskId: null, on: time.day },
	);
}

/** Profit as a share of revenue, or null when either is unknown or there is no revenue. */
export function marginOf(profitMinor: number | null, revenueMinor: number | null): number | null {
	if (profitMinor === null || revenueMinor === null || revenueMinor <= 0) return null;
	return profitMinor / revenueMinor;
}

/**
 * Each project's revenue, cost and profit over `range`, and the totals in
 * `currency`, the organisation's. A project with no time, no expense and no
 * fee earned in the range is left out.
 */
export function profitability(input: {
	projects: ReadonlyMap<string, ProfitProject>;
	billableRates: readonly RateRow[];
	costRates: readonly RateRow[];
	currency: string;
	range: ReportDays;
	rows: readonly Row[];
	expenses: readonly ProfitExpense[];
}): { lines: ProfitLine[]; totals: ProfitTotals } {
	const { projects, billableRates, costRates, currency, range, rows, expenses } = input;
	interface Tally {
		revenue: BillableAmount[];
		billableExpenses: number;
		costMinuteMinor: number;
		expenseCost: number;
		missingRateSeconds: number;
		missingCostSeconds: number;
		touched: boolean;
	}
	const tallies = new Map<string, Tally>();
	const tally = (projectId: string): Tally => {
		let found = tallies.get(projectId);
		if (!found) {
			found = {
				revenue: [],
				billableExpenses: 0,
				costMinuteMinor: 0,
				expenseCost: 0,
				missingRateSeconds: 0,
				missingCostSeconds: 0,
				touched: false,
			};
			tallies.set(projectId, found);
		}
		return found;
	};

	for (const row of rows) {
		const { entry } = row;
		const project = projects.get(entry.projectId);
		if (!project) continue;
		const line = tally(project.id);
		line.touched = true;
		const minutes = row.minutes;
		if (project.billingType === "hourly") {
			const amount = priceTime(project, billableRates, {
				userId: entry.userId,
				taskId: entry.taskId,
				billable: entry.billable,
				day: row.day,
				minutes,
			});
			if (amount.kind === "missing-rate") line.missingRateSeconds += row.minutes * 60;
			line.revenue.push(amount);
		}
		const cost = costRateFor(costRates, currency, {
			userId: entry.userId,
			projectId: project.id,
			day: row.day,
		});
		if (cost === null) line.missingCostSeconds += row.minutes * 60;
		else line.costMinuteMinor += minutes * cost.amountMinor;
	}

	for (const expense of expenses) {
		const project = projects.get(expense.projectId);
		if (!project) continue;
		const line = tally(project.id);
		line.touched = true;
		if (expense.currency === currency) line.expenseCost += expense.amountMinor;
		if (
			project.billingType === "hourly" &&
			expense.billable &&
			expense.currency === project.currency
		) {
			line.billableExpenses += expense.amountMinor;
		}
	}

	const lines: ProfitLine[] = [];
	for (const project of projects.values()) {
		const fee = project.billingType === "fixed_fee" ? spreadFee(project, range) : null;
		const earnsFee = fee !== null && fee > 0;
		const line = tallies.get(project.id);
		if (!line?.touched && !earnsFee) continue;
		const t = line ?? tally(project.id);
		const revenueMinor =
			project.billingType === "hourly"
				? roundHalfUp(billableMinuteMinor(t.revenue), MINUTES_PER_HOUR) + t.billableExpenses
				: project.billingType === "fixed_fee"
					? fee
					: 0;
		const costMinor = roundHalfUp(t.costMinuteMinor, MINUTES_PER_HOUR) + t.expenseCost;
		const profitMinor =
			revenueMinor !== null && project.currency === currency ? revenueMinor - costMinor : null;
		lines.push({
			projectId: project.id,
			project: project.name,
			client: project.client,
			billingType: project.billingType,
			currency: project.currency,
			revenueMinor,
			costMinor,
			profitMinor,
			margin: marginOf(profitMinor, revenueMinor),
			missingRateSeconds: t.missingRateSeconds,
			missingCostSeconds: t.missingCostSeconds,
			missingFeeOrDates: project.billingType === "fixed_fee" && fee === null,
		});
	}
	lines.sort(
		(a, b) => a.project.localeCompare(b.project, "en") || (a.projectId < b.projectId ? -1 : 1),
	);

	const inCurrency = lines.filter((l) => l.currency === currency && l.revenueMinor !== null);
	const revenueMinor = inCurrency.reduce((sum, l) => sum + (l.revenueMinor ?? 0), 0);
	const costMinor = lines.reduce((sum, l) => sum + l.costMinor, 0);
	const profitMinor = revenueMinor - costMinor;
	return {
		lines,
		totals: {
			currency,
			revenueMinor,
			costMinor,
			profitMinor,
			margin: marginOf(profitMinor, revenueMinor),
		},
	};
}
