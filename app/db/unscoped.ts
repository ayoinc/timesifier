/**
 * The few reads that cross organisations on purpose, each named for its one
 * caller. Everything else goes through `organisationScope`.
 *
 * - The billing schedule (TS-074, TS-078) runs for every organisation at once
 *   and has no person or organisation to start from.
 * - An estimate's public link (TS-077) is opened by someone who is not signed
 *   in: the estimate is found by id and shown only once the link's token is
 *   proved against it.
 */
import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { estimates, invoiceSettings, organisations, recurringInvoices } from "./schema";

/** Recurring invoice templates, in any organisation, whose next issue date is on or before `latest`. */
export function dueRecurringInvoices(database: D1Database, latest: string) {
	return drizzle(database)
		.select({
			id: recurringInvoices.id,
			organisationId: recurringInvoices.organisationId,
			name: organisations.name,
			timeZone: organisations.timeZone,
			currency: organisations.currency,
		})
		.from(recurringInvoices)
		.innerJoin(organisations, eq(organisations.id, recurringInvoices.organisationId))
		.where(and(isNull(recurringInvoices.stoppedAt), lte(recurringInvoices.nextIssueOn, latest)));
}

/** Every organisation that sends late payment reminders, with its rule. */
export function reminderOrganisations(database: D1Database) {
	return drizzle(database)
		.select({
			organisationId: invoiceSettings.organisationId,
			after: invoiceSettings.lateReminderAfterDays,
			every: invoiceSettings.lateReminderEveryDays,
			name: organisations.name,
			timeZone: organisations.timeZone,
		})
		.from(invoiceSettings)
		.innerJoin(organisations, eq(organisations.id, invoiceSettings.organisationId))
		.where(isNotNull(invoiceSettings.lateReminderAfterDays));
}

/** The estimate with `id` in any organisation, for its public link. The caller proves the token first. */
export async function estimateForLink(database: D1Database, id: string) {
	const [row] = await drizzle(database)
		.select()
		.from(estimates)
		.where(eq(estimates.id, id))
		.limit(1);
	return row ?? null;
}
