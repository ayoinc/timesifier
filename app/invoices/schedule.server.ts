import { env } from "cloudflare:workers";
import { and, desc, eq, inArray, like, lte } from "drizzle-orm";

import { dueRecurringInvoices, organisationScope, reminderOrganisations } from "~/db";
import { DEFAULT_LOCALE } from "~/shell/locale";
import { addDays, type Day, dayOf } from "~/time/calendar";

import { sendInvoice } from "./deliver.server";
import { settledOf } from "./invoices.server";
import { contactsOf } from "./mail.server";
import { issueRecurring } from "./recurring.server";
import { balanceOf, daysBetween, OWING } from "./status";

/**
 * The scheduled handler's billing work (TS-074, TS-078), run every hour by
 * the Worker's cron trigger (`workers/app.ts`, `wrangler.jsonc`) and by a test
 * with the instant it pretends it is. Each organisation's day is its own
 * time zone's, so a template due on the 1st is issued once the 1st has begun
 * there. Running it twice for the same hour does the work once.
 */

/** The most invoices one template makes in one run, catching up after missed runs. */
const MOST_CATCH_UP = 24;

/** What a run did. */
export interface BillingRun {
	invoicesMade: number;
	remindersSent: number;
}

export async function runBillingSchedule(now: number): Promise<BillingRun> {
	const [invoicesMade, remindersSent] = [await issueDueRecurring(now), await sendDueReminders(now)];
	return { invoicesMade, remindersSent };
}

/** Makes every recurring invoice whose issue date has come in its organisation's zone. */
async function issueDueRecurring(now: number): Promise<number> {
	// The latest day it is anywhere: a template due then may be due somewhere.
	const latest = addDays(dayOf(now, "UTC"), 1);
	const due = await dueRecurringInvoices(env.DB, latest);

	let made = 0;
	for (const row of due) {
		const scope = organisationScope(env.DB, row.organisationId);
		const today = dayOf(now, row.timeZone);
		for (let run = 0; run < MOST_CATCH_UP; run++) {
			const [template] = await scope.recurringInvoices.select((r) => eq(r.id, row.id), {
				limit: 1,
			});
			if (!template || template.stoppedAt || template.nextIssueOn > today) break;
			if (template.endsOn !== null && template.nextIssueOn > template.endsOn) break;
			const issueOn = template.nextIssueOn;
			const id = await issueRecurring(scope, row, row.id, issueOn, now, DEFAULT_LOCALE);
			if (id) made++;
			// Nothing moved: another run has it, or it is past its end.
			const [after] = await scope.recurringInvoices.select((r) => eq(r.id, row.id), { limit: 1 });
			if (!after || after.nextIssueOn === issueOn) break;
		}
	}
	return made;
}

/**
 * Sends each overdue invoice's reminder when one is due: `after` days past
 * its due date, then every `every` days, until it is paid. Each reminder is
 * recorded on the invoice's history, which is what the next run reads.
 */
async function sendDueReminders(now: number): Promise<number> {
	const settings = await reminderOrganisations(env.DB);

	let sent = 0;
	for (const org of settings) {
		const after = org.after ?? 0;
		const scope = organisationScope(env.DB, org.organisationId);
		const today = dayOf(now, org.timeZone);
		const late = await scope.invoices.select((i) =>
			and(inArray(i.status, [...OWING]), lte(i.dueOn, addDays(today, -after))),
		);
		const settled = await settledOf(
			scope,
			late.map((i) => i.id),
		);
		for (const invoice of late) {
			const owed = balanceOf(
				invoice.totalMinor,
				settled.get(invoice.id) ?? { paidMinor: 0, writtenOffMinor: 0 },
			);
			if (owed <= 0) continue;
			const [last] = await scope.activityRecords.select(
				(r) =>
					and(
						eq(r.subjectType, "invoice"),
						eq(r.subjectId, invoice.id),
						eq(r.action, "invoice.sent"),
						like(r.summary, '%"reminder":true%'),
					),
				{ orderBy: (r) => [desc(r.createdAt)], limit: 1 },
			);
			if (last) {
				if (org.every === null) continue;
				const lastDay: Day = dayOf(last.createdAt, org.timeZone);
				if (daysBetween(lastDay, today) < org.every) continue;
			}
			const contacts = await contactsOf(scope, invoice.clientId);
			if (contacts.length === 0) continue;
			const result = await sendInvoice(scope, null, invoice.id, {
				organisationName: org.name,
				to: contacts.map((c) => c.email),
				reminder: true,
				locale: DEFAULT_LOCALE,
				today,
				now: new Date(now),
				source: "system",
			});
			if (result?.ok) sent++;
		}
	}
	return sent;
}
