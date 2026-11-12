import { and, asc, eq, gte, inArray, lte, ne } from "drizzle-orm";

import type { OrganisationScope } from "~/db";
import type { Day } from "~/time/calendar";

import { settledOf } from "./invoices.server";
import { AGES, type Age, ageOf, balanceOf, OWING } from "./status";

/**
 * What clients owe and have paid (TS-074): the receivables, by how overdue
 * they are, and the reports of what was invoiced and what was received in a
 * range. A balance is an issued invoice's total less its payments and
 * write-offs; "overdue" is a balance whose due date has passed in the
 * organisation's time zone. Amounts in different currencies are never added.
 */

/** What is owed in one currency, and how much of it is overdue: the figure a dashboard shows. */
export interface Receivable {
	currency: string;
	outstandingMinor: number;
	overdueMinor: number;
}

/** One open invoice with what is still owed on it. */
export interface OpenInvoice {
	id: string;
	number: string;
	clientId: string;
	currency: string;
	issuedOn: Day;
	dueOn: Day;
	totalMinor: number;
	balanceMinor: number;
	age: Age;
}

/** Every issued invoice with something owed on it, on `today`, oldest due first. */
export async function openInvoicesOf(scope: OrganisationScope, today: Day): Promise<OpenInvoice[]> {
	const rows = await scope.invoices.select((i) => inArray(i.status, [...OWING]), {
		orderBy: (i) => [asc(i.dueOn), asc(i.createdAt)],
	});
	const settled = await settledOf(
		scope,
		rows.map((r) => r.id),
	);
	return rows
		.map((row) => ({
			id: row.id,
			number: row.number,
			clientId: row.clientId,
			currency: row.currency,
			issuedOn: row.issuedOn,
			dueOn: row.dueOn,
			totalMinor: row.totalMinor,
			balanceMinor: balanceOf(
				row.totalMinor,
				settled.get(row.id) ?? { paidMinor: 0, writtenOffMinor: 0 },
			),
			age: ageOf(row.dueOn, today),
		}))
		.filter((row) => row.balanceMinor > 0);
}

/** What is owed on `today`, one row per currency, ordered by code. */
export async function receivablesOf(scope: OrganisationScope, today: Day): Promise<Receivable[]> {
	const open = await openInvoicesOf(scope, today);
	const byCurrency = new Map<string, Receivable>();
	for (const row of open) {
		const sum = byCurrency.get(row.currency) ?? {
			currency: row.currency,
			outstandingMinor: 0,
			overdueMinor: 0,
		};
		sum.outstandingMinor += row.balanceMinor;
		if (row.age !== "current") sum.overdueMinor += row.balanceMinor;
		byCurrency.set(row.currency, sum);
	}
	return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/** The receivables of one currency by age. */
export interface AgedReceivables {
	currency: string;
	byAge: Record<Age, number>;
	totalMinor: number;
}

/** What is owed on `today` by age, one row per currency. */
export function agedOf(open: readonly OpenInvoice[]): AgedReceivables[] {
	const byCurrency = new Map<string, AgedReceivables>();
	for (const row of open) {
		const sum = byCurrency.get(row.currency) ?? {
			currency: row.currency,
			byAge: Object.fromEntries(AGES.map((age) => [age, 0])) as Record<Age, number>,
			totalMinor: 0,
		};
		sum.byAge[row.age] += row.balanceMinor;
		sum.totalMinor += row.balanceMinor;
		byCurrency.set(row.currency, sum);
	}
	return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/** The issued invoices whose issue date is in `days`, void ones left out. */
export function invoicedIn(scope: OrganisationScope, days: { first: Day; last: Day }) {
	return scope.invoices.select(
		(i) =>
			and(
				ne(i.status, "draft"),
				ne(i.status, "void"),
				gte(i.issuedOn, days.first),
				lte(i.issuedOn, days.last),
			),
		{ orderBy: (i) => [asc(i.issuedOn), asc(i.createdAt)] },
	);
}

/** The payments received on a day in `days`: write-offs are not money received. */
export function paymentsIn(scope: OrganisationScope, days: { first: Day; last: Day }) {
	return scope.payments.select(
		(p) => and(eq(p.kind, "payment"), gte(p.paidOn, days.first), lte(p.paidOn, days.last)),
		{ orderBy: (p) => [asc(p.paidOn), asc(p.createdAt)] },
	);
}
