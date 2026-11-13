import { and, eq, gte, inArray, lt, lte, ne, notInArray, sql } from "drizzle-orm";

import type { OrganisationScope } from "~/db";
import type { Day } from "~/time/calendar";

import { OWING } from "./status";

/**
 * The overview Invoices opens on (TS-119, S2-11): what clients owe now and
 * how much of it is overdue, what they paid this year, and, for each of the
 * last twelve months, what was issued and what was paid. Every figure is a
 * SQL sum in the organisation's currency; invoices in another currency are
 * named, never added in. The rules are the receivables report's (TS-074): a
 * balance is an issued invoice's total less its payments and write-offs, it
 * is overdue once its due date has passed on `today`, an invoice is issued
 * once it is neither a draft nor void, and money received is a payment,
 * never a write-off.
 */

/** The months the bars cover: this one and the eleven before. */
export const OVERVIEW_MONTHS = 12;

/** One month's bar pair, in minor units. */
export interface MonthFigures {
	/** The month's first day. */
	month: Day;
	issuedMinor: number;
	paidMinor: number;
}

export interface InvoiceOverview {
	currency: string;
	outstandingMinor: number;
	overdueMinor: number;
	/** Payments received from 1 January of `today`'s year to `today`. */
	paidThisYearMinor: number;
	/** Oldest first. */
	months: MonthFigures[];
	/** The other currencies the organisation has issued invoices in, which no figure here counts. */
	otherCurrencies: string[];
}

/** The first day of the month `count` months after `day`'s (before, when negative). */
function monthStart(day: Day, count: number): Day {
	const year = Number(day.slice(0, 4));
	const month = Number(day.slice(5, 7)) - 1 + count;
	const shifted = new Date(Date.UTC(year, month, 1));
	return shifted.toISOString().slice(0, 10);
}

export async function invoiceOverview(
	scope: OrganisationScope,
	currency: string,
	today: Day,
): Promise<InvoiceOverview> {
	const first = monthStart(today, 1 - OVERVIEW_MONTHS);
	// What is still owed on an invoice: its total less every payment and write-off on it.
	const balance: Parameters<typeof scope.invoices.sum>[0] = (i) =>
		sql<number>`${i.totalMinor} - coalesce(${scope.payments.value(
			(p) => sql<number>`sum(${p.amountMinor})`,
			(p) => eq(p.invoiceId, i.id),
		)}, 0)`;
	const [owed, overdue, issued, paid, currencies] = await Promise.all([
		scope.invoices.sum(
			balance,
			(i) => i.currency,
			(i) => and(inArray(i.status, [...OWING]), eq(i.currency, currency)),
		),
		scope.invoices.sum(
			balance,
			(i) => i.currency,
			(i) => and(inArray(i.status, [...OWING]), eq(i.currency, currency), lt(i.dueOn, today)),
		),
		// By day, at most a year's days, and gathered into months below.
		scope.invoices.sum(
			(i) => sql<number>`${i.totalMinor}`,
			(i) => i.issuedOn,
			(i) =>
				and(
					notInArray(i.status, ["draft", "void"]),
					eq(i.currency, currency),
					gte(i.issuedOn, first),
					lte(i.issuedOn, today),
				),
		),
		scope.payments.sum(
			(p) => sql<number>`${p.amountMinor}`,
			(p) => p.paidOn,
			(p) =>
				and(
					eq(p.kind, "payment"),
					gte(p.paidOn, first),
					lte(p.paidOn, today),
					scope.invoices.exists((i) => and(eq(i.id, p.invoiceId), eq(i.currency, currency))),
				),
		),
		scope.invoices.sum(
			() => sql<number>`1`,
			(i) => i.currency,
			(i) => and(notInArray(i.status, ["draft", "void"]), ne(i.currency, currency)),
		),
	]);

	const months: MonthFigures[] = Array.from({ length: OVERVIEW_MONTHS }, (_, at) => ({
		month: monthStart(first, at),
		issuedMinor: 0,
		paidMinor: 0,
	}));
	const index = (day: Day) =>
		(Number(day.slice(0, 4)) - Number(first.slice(0, 4))) * 12 +
		Number(day.slice(5, 7)) -
		Number(first.slice(5, 7));
	for (const { key, total } of issued) {
		const month = months[index(key)];
		if (month) month.issuedMinor += total;
	}
	// 1 January of this year is always within the twelve months.
	const newYear = `${today.slice(0, 4)}-01-01`;
	let paidThisYearMinor = 0;
	for (const { key, total } of paid) {
		const month = months[index(key)];
		if (month) month.paidMinor += total;
		if (key >= newYear) paidThisYearMinor += total;
	}
	return {
		currency,
		outstandingMinor: owed[0]?.total ?? 0,
		overdueMinor: overdue[0]?.total ?? 0,
		paidThisYearMinor,
		months,
		otherCurrencies: currencies.map(({ key }) => key).sort(),
	};
}
