import { MINUTES_PER_HOUR } from "~/billing/billable";
import type { OrganisationScope } from "~/db";
import { roundHalfUp, totalsByCurrency } from "~/money/money";
import { type Day, dayOf } from "~/time/calendar";

import { billableProjectsOf, uninvoicedExpenses, uninvoicedTime } from "./sources.server";

/**
 * The Uninvoiced view (TS-073): for each client's project, the billable time
 * and expenses in a range that are on no invoice yet, and what they come to.
 * It reads the same rows and prices as the invoice preview
 * (`sources.server.ts`), so what it says is waiting is what an invoice would
 * take. A project's time is summed exactly and rounded once.
 */

/** One project's uninvoiced work. */
export interface UninvoicedProject {
	clientId: string;
	clientName: string;
	projectId: string;
	projectName: string;
	currency: string;
	/** Billable minutes with a rate. */
	minutes: number;
	/** What that time is worth. */
	timeMinor: number;
	/** Billable expenses, in the expenses' own currency when it is the project's. */
	expensesMinor: number;
	/** A fixed-fee project's fee still to invoice. */
	feeLeftMinor: number;
	/** Time, expenses and fee together. */
	amountMinor: number;
	/** Billable minutes no rate prices: shown, worth nothing until one does. */
	unpricedMinutes: number;
}

/** What the view needs to know of the organisation. */
export interface BillingOrganisation {
	timeZone: string;
	currency: string;
}

/** Every client project with uninvoiced work in `days` (all of it up to now when null), by client then project. */
export async function uninvoicedOf(
	scope: OrganisationScope,
	organisation: BillingOrganisation,
	days: { first: Day; last: Day } | null,
	now: number,
): Promise<UninvoicedProject[]> {
	const [projects, clients] = await Promise.all([
		billableProjectsOf(scope, null, organisation.currency),
		scope.clients.select(),
	]);
	const today = dayOf(now, organisation.timeZone);
	const hourly = projects.filter((p) => p.billingType === "hourly").map((p) => p.id);
	const [entries, expenses] = await Promise.all([
		uninvoicedTime(scope, organisation, hourly, days, now),
		uninvoicedExpenses(
			scope,
			projects.map((p) => p.id),
			days,
			today,
		),
	]);
	const clientName = new Map(clients.map((c) => [c.id, c.name]));

	const rows = projects.map((project) => {
		const time = entries.filter((e) => e.projectId === project.id);
		const priced = time.filter((e) => e.priced);
		const timeMinor = roundHalfUp(
			priced.reduce((sum, e) => sum + e.minuteMinor, 0),
			MINUTES_PER_HOUR,
		);
		const expensesMinor = expenses
			.filter((x) => x.projectId === project.id && x.currency === project.currency)
			.reduce((sum, x) => sum + x.amountMinor, 0);
		const feeLeftMinor = project.feeLeftMinor ?? 0;
		return {
			clientId: project.clientId ?? "",
			clientName: clientName.get(project.clientId ?? "") ?? "",
			projectId: project.id,
			projectName: project.name,
			currency: project.currency,
			minutes: priced.reduce((sum, e) => sum + e.minutes, 0),
			timeMinor,
			expensesMinor,
			feeLeftMinor,
			amountMinor: timeMinor + expensesMinor + feeLeftMinor,
			unpricedMinutes: time.filter((e) => !e.priced).reduce((sum, e) => sum + e.minutes, 0),
		};
	});
	return rows
		.filter((row) => row.amountMinor > 0 || row.unpricedMinutes > 0)
		.sort(
			(a, b) =>
				a.clientName.localeCompare(b.clientName) || a.projectName.localeCompare(b.projectName),
		);
}

/** What is waiting to be invoiced, one total per currency: the figure a dashboard shows. */
export interface UninvoicedTotal {
	currency: string;
	amountMinor: number;
	minutes: number;
	expensesMinor: number;
}

export async function uninvoicedTotalsOf(
	scope: OrganisationScope,
	organisation: BillingOrganisation,
	days: { first: Day; last: Day } | null,
	now: number,
): Promise<UninvoicedTotal[]> {
	const rows = await uninvoicedOf(scope, organisation, days, now);
	return totalsByCurrency(rows.map(({ amountMinor, currency }) => ({ amountMinor, currency }))).map(
		({ currency, amountMinor }) => {
			const same = rows.filter((row) => row.currency === currency);
			return {
				currency,
				amountMinor,
				minutes: same.reduce((sum, row) => sum + row.minutes, 0),
				expensesMinor: same.reduce((sum, row) => sum + row.expensesMinor, 0),
			};
		},
	);
}
