import * as z from "zod";

import { MINUTES_PER_HOUR } from "~/billing/billable";
import { allocate, roundHalfUp } from "~/money/money";
import type { Day } from "~/time/calendar";

/**
 * The lines an invoice is made of (TS-073), worked out before anything is
 * stored. Time is grouped into lines; each expense is a line; a fixed-fee
 * project's fee, or a part of it, is a line; and a person adds free lines.
 *
 * A quantity is in thousandths (1500 is 1.5 hours or 1.5 units), a price in
 * minor units of the invoice's one currency.
 */

/** How tracked time becomes lines: one per project, per task, per person, or per entry. */
export const Grouping = z.enum(["project", "task", "person", "entry"]);
export type Grouping = z.infer<typeof Grouping>;

export const GROUPING_LABELS: Record<Grouping, string> = {
	project: "One line per project",
	task: "One line per task",
	person: "One line per person",
	entry: "One line per entry",
};

/** The kinds of line `invoice_lines.kind` holds. */
export type LineKind = "time" | "expense" | "fixed" | "manual";

/** A priced time entry, ready to be put on a line. */
export interface TimeItem {
	id: string;
	projectId: string;
	projectName: string;
	taskId: string | null;
	taskName: string | null;
	userId: string;
	personName: string;
	description: string | null;
	day: Day;
	minutes: number;
	/** The hourly rate that priced it, in minor units. */
	rateMinor: number;
	/** Minutes × rate: 60 times its amount, exact (`billableAmount`). */
	minuteMinor: number;
}

/** A line before it is stored, with what it bills for. */
export interface DraftLine {
	kind: LineKind;
	description: string;
	projectId: string | null;
	quantityMilli: number;
	unitPriceMinor: number;
	amountMinor: number;
	timeEntryIds: string[];
	expenseIds: string[];
}

/** Thousandths in one. */
const MILLI = 1000;

/** `minutes` as hours in thousandths, rounded half up: 90 minutes is 1500. */
export function hoursMilli(minutes: number): number {
	return roundHalfUp(minutes * MILLI, MINUTES_PER_HOUR);
}

/** What identifies an item's line under `grouping`. */
function keyOf(item: TimeItem, grouping: Grouping): string {
	switch (grouping) {
		case "project":
			return item.projectId;
		case "task":
			return `${item.projectId}/${item.taskId ?? ""}`;
		case "person":
			return `${item.projectId}/${item.userId}`;
		case "entry":
			return item.id;
	}
}

/** What a line of `items` under `grouping` says. */
function lineDescription(items: readonly TimeItem[], grouping: Grouping): string {
	const [first] = items;
	if (!first) return "";
	switch (grouping) {
		case "project":
			return first.projectName;
		case "task":
			return `${first.projectName}: ${first.taskName ?? "No task"}`;
		case "person":
			return `${first.projectName}: ${first.personName}`;
		case "entry":
			return [first.projectName, first.description ?? first.taskName, first.day]
				.filter(Boolean)
				.join(": ");
	}
}

/**
 * Tracked time as lines, grouped by `grouping`, in the order the groups are
 * first met.
 *
 * The lines add up to exactly what the entries are worth together: their
 * exact amounts are summed, rounded once (`sumBillable`), and that total is
 * shared between the lines in proportion to each line's exact amount
 * (`allocate`). So the subtotal is the same whichever grouping is chosen.
 * A line's quantity is its hours; its price is the rate when all its entries
 * share one, and otherwise the amount over the hours.
 */
export function timeLines(items: readonly TimeItem[], grouping: Grouping): DraftLine[] {
	const groups = new Map<string, TimeItem[]>();
	for (const item of items) {
		const key = keyOf(item, grouping);
		const group = groups.get(key);
		if (group) group.push(item);
		else groups.set(key, [item]);
	}
	const lists = [...groups.values()];
	const exact = lists.map((list) => list.reduce((sum, item) => sum + item.minuteMinor, 0));
	const total = roundHalfUp(
		exact.reduce((sum, value) => sum + value, 0),
		MINUTES_PER_HOUR,
	);
	const amounts = total === 0 ? exact.map(() => 0) : allocate(total, exact);

	return lists.map((list, index) => {
		const amountMinor = amounts[index] ?? 0;
		const minutes = list.reduce((sum, item) => sum + item.minutes, 0);
		const quantityMilli = hoursMilli(minutes);
		const rates = new Set(list.map((item) => item.rateMinor));
		const [rate] = rates;
		const unitPriceMinor =
			rates.size === 1 && rate !== undefined
				? rate
				: quantityMilli > 0
					? roundHalfUp(amountMinor * MILLI, quantityMilli)
					: amountMinor;
		return {
			kind: "time",
			description: lineDescription(list, grouping),
			projectId: list[0]?.projectId ?? null,
			quantityMilli,
			unitPriceMinor,
			amountMinor,
			timeEntryIds: list.map((item) => item.id),
			expenseIds: [],
		};
	});
}

/** An expense as a line takes it. */
export interface ExpenseItem {
	id: string;
	projectId: string;
	projectName: string;
	categoryName: string;
	notes: string | null;
	spentOn: Day;
	amountMinor: number;
	quantityMilli: number | null;
	unitPriceMinor: number | null;
}

/**
 * One line per expense, for its amount. A unit-priced expense (miles, say)
 * keeps its quantity and price; any other is one of its amount.
 */
export function expenseLines(items: readonly ExpenseItem[]): DraftLine[] {
	return items.map((item) => {
		const unit = item.quantityMilli !== null && item.unitPriceMinor !== null;
		return {
			kind: "expense",
			description: [item.projectName, item.categoryName, item.notes ?? item.spentOn]
				.filter(Boolean)
				.join(": "),
			projectId: item.projectId,
			quantityMilli: unit ? (item.quantityMilli ?? MILLI) : MILLI,
			unitPriceMinor: unit ? (item.unitPriceMinor ?? item.amountMinor) : item.amountMinor,
			amountMinor: item.amountMinor,
			timeEntryIds: [],
			expenseIds: [item.id],
		};
	});
}

/** A fixed-fee project's fee, or the part of it being invoiced, as one line. */
export function fixedLine(project: { id: string; name: string }, amountMinor: number): DraftLine {
	return {
		kind: "fixed",
		description: `${project.name}: fixed fee`,
		projectId: project.id,
		quantityMilli: MILLI,
		unitPriceMinor: amountMinor,
		amountMinor,
		timeEntryIds: [],
		expenseIds: [],
	};
}

/** The most a quantity may be: a million units. */
const MOST_QUANTITY_MILLI = 1_000_000_000;

/**
 * A quantity as typed, in thousandths: "1.5" is 1500, "2" is 2000. Null for
 * text that is not a number above 0 with at most three decimals.
 */
export function parseQuantity(text: string): number | null {
	const match = /^(\d{1,7})(?:\.(\d{1,3}))?$/.exec(text.trim());
	if (!match) return null;
	const [, whole = "", fraction = ""] = match;
	const milli = Number(whole) * MILLI + Number(fraction.padEnd(3, "0"));
	return milli > 0 && milli <= MOST_QUANTITY_MILLI ? milli : null;
}

/** A quantity in thousandths as a field shows it: 1500 is "1.5", 2000 is "2". */
export function quantityText(milli: number): string {
	const whole = Math.floor(milli / MILLI);
	const fraction = String(milli % MILLI)
		.padStart(3, "0")
		.replace(/0+$/, "");
	return fraction ? `${whole}.${fraction}` : String(whole);
}
