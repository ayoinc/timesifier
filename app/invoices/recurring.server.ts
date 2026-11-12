import { and, asc, eq, isNull } from "drizzle-orm";

import {
	changes,
	REDACTED,
	recordStatement,
	recordStatementWhen,
} from "~/activity/activity.server";
import { type OrganisationScope, uuidv7 } from "~/db";
import { lineAmount } from "~/money/money";
import type { Day } from "~/time/calendar";
import { sendInvoice } from "./deliver.server";
import { defaultTaxIds } from "./documents.server";
import { createDraft, type LineInput, type Result } from "./invoices.server";
import type { DraftLine } from "./lines";
import { contactsOf } from "./mail.server";
import { type Frequency, nextIssueAfter } from "./recurring";
import { sourcesFor } from "./sources.server";

/**
 * Recurring invoices (TS-078): a template of a client's lines, or of "this
 * client's uninvoiced time", issued on a schedule. On each issue date the
 * scheduled handler (`schedule.server.ts`) makes a draft from it, or issues
 * it and sends it to the client's billing contacts when the template says so.
 */

/** What a person sets up. */
export interface RecurringInput {
	clientId: string;
	frequency: Frequency;
	startsOn: Day;
	endsOn: Day | null;
	sendAutomatically: boolean;
	includeUninvoicedTime: boolean;
	currency: string;
	paymentTermsDays: number;
	subject: string | null;
	notes: string | null;
}

/** The organisation's recurring invoices with their clients' names, the running ones first. */
export async function recurringOf(scope: OrganisationScope) {
	const [rows, clients] = await Promise.all([
		scope.recurringInvoices.select(undefined, { orderBy: (r) => [asc(r.nextIssueOn)] }),
		scope.clients.select(),
	]);
	const clientName = new Map(clients.map((c) => [c.id, c.name]));
	return rows
		.map((row) => ({ ...row, clientName: clientName.get(row.clientId) ?? "" }))
		.sort((a, b) => Number(a.stoppedAt !== null) - Number(b.stoppedAt !== null));
}

/** One recurring invoice of the organisation and its lines, or null. */
export async function findRecurring(scope: OrganisationScope, id: string) {
	const [row] = await scope.recurringInvoices.select((r) => eq(r.id, id), { limit: 1 });
	if (!row) return null;
	const [lines, [client]] = await Promise.all([
		scope.recurringInvoiceLines.select((l) => eq(l.recurringInvoiceId, id), {
			orderBy: (l) => [asc(l.position)],
		}),
		scope.clients.select((c) => eq(c.id, row.clientId), { limit: 1 }),
	]);
	return { recurring: row, lines, clientName: client?.name ?? "" };
}

/** Sets up a recurring invoice; its first issue date is its start. */
export async function createRecurring(
	scope: OrganisationScope,
	actor: string,
	input: RecurringInput,
): Promise<Result> {
	const [client] = await scope.clients.select(
		(c) => and(eq(c.id, input.clientId), isNull(c.archivedAt)),
		{ limit: 1 },
	);
	if (!client) return { ok: false, problem: "Choose an active client." };
	if (input.endsOn !== null && input.endsOn < input.startsOn) {
		return { ok: false, problem: "The last date cannot be before the first." };
	}
	const id = uuidv7();
	await scope.batch([
		scope.recurringInvoices.statements.insert({ id, ...input, nextIssueOn: input.startsOn }),
		recordStatement(
			scope,
			actor,
			"recurring_invoice.created",
			{ type: "recurring_invoice", id },
			{ after: { frequency: input.frequency, startsOn: input.startsOn } },
		),
	]);
	return { ok: true, id };
}

/** What a person changes on a running recurring invoice. */
export type RecurringChange = Omit<RecurringInput, "clientId" | "currency" | "startsOn"> & {
	nextIssueOn: Day;
};

/** The schedule and terms a recurring invoice's change compares; `notes` is recorded only as changed. */
const CHANGED_FIELDS = [
	"frequency",
	"nextIssueOn",
	"endsOn",
	"sendAutomatically",
	"includeUninvoicedTime",
	"paymentTermsDays",
	"notes",
] as const;

/** Changes a running recurring invoice; false when it has stopped (or is not this organisation's). */
export async function changeRecurring(
	scope: OrganisationScope,
	actor: string,
	recurringId: string,
	change: RecurringChange,
	now: Date,
): Promise<boolean> {
	const [held] = await scope.recurringInvoices.select(
		(r) => and(eq(r.id, recurringId), isNull(r.stoppedAt)),
		{ limit: 1 },
	);
	if (!held) return false;
	const summary = changes(held, change, CHANGED_FIELDS);
	// The subject is the client's words: recorded as changed, never copied.
	if (held.subject !== change.subject) summary.after = { ...summary.after, subject: REDACTED };
	const [, changed] = await scope.batch([
		recordStatementWhen(
			scope,
			scope.recurringInvoices.exists((r) => and(eq(r.id, recurringId), isNull(r.stoppedAt))),
			actor,
			"recurring_invoice.updated",
			{ type: "recurring_invoice", id: recurringId },
			summary,
		),
		scope.recurringInvoices.statements.update({ ...change, updatedAt: now }, (r) =>
			and(eq(r.id, recurringId), isNull(r.stoppedAt)),
		),
	]);
	return changed.length > 0;
}

/** Adds a line to a recurring invoice. */
export async function addRecurringLine(
	scope: OrganisationScope,
	actor: string,
	recurringId: string,
	line: LineInput,
): Promise<Result> {
	const found = await findRecurring(scope, recurringId);
	if (!found) return null;
	if (found.recurring.stoppedAt)
		return { ok: false, problem: "That recurring invoice has stopped." };
	await scope.batch([
		scope.recurringInvoiceLines.statements.insert({
			recurringInvoiceId: recurringId,
			position: (found.lines.at(-1)?.position ?? -1) + 1,
			description: line.description,
			quantityMilli: line.quantityMilli,
			unitPriceMinor: line.unitPriceMinor,
			taxId: line.taxId,
			secondTaxId: line.taxId ? line.secondTaxId : null,
		}),
		recordStatement(
			scope,
			actor,
			"recurring_invoice.updated",
			{ type: "recurring_invoice", id: recurringId },
			{ after: { line: "added" } },
		),
	]);
	return { ok: true, id: recurringId };
}

/** Removes a line of a recurring invoice; the invoices already made keep theirs. */
export async function removeRecurringLine(
	scope: OrganisationScope,
	actor: string,
	recurringId: string,
	lineId: string,
): Promise<Result> {
	const [line] = await scope.recurringInvoiceLines.select(
		(l) => and(eq(l.id, lineId), eq(l.recurringInvoiceId, recurringId)),
		{ limit: 1 },
	);
	if (!line) return null;
	await scope.batch([
		scope.recurringInvoiceLines.statements.delete((l) =>
			and(eq(l.id, lineId), eq(l.recurringInvoiceId, recurringId)),
		),
		recordStatement(
			scope,
			actor,
			"recurring_invoice.updated",
			{ type: "recurring_invoice", id: recurringId },
			{ before: { line: "removed" } },
		),
	]);
	return { ok: true, id: recurringId };
}

/** Stops a recurring invoice: no more are made from it. */
export async function stopRecurring(
	scope: OrganisationScope,
	actor: string,
	recurringId: string,
	now: Date,
): Promise<Result> {
	const [, stopped] = await scope.batch([
		// Recorded first, while it still runs: two stops at once record one.
		recordStatementWhen(
			scope,
			scope.recurringInvoices.exists((r) => and(eq(r.id, recurringId), isNull(r.stoppedAt))),
			actor,
			"recurring_invoice.stopped",
			{ type: "recurring_invoice", id: recurringId },
		),
		scope.recurringInvoices.statements.update({ stoppedAt: now }, (r) =>
			and(eq(r.id, recurringId), isNull(r.stoppedAt)),
		),
	]);
	return stopped.length > 0 ? { ok: true, id: recurringId } : null;
}

/** What an organisation is to the handler: who it is and how its days are counted. */
export interface ScheduledOrganisation {
	name: string;
	timeZone: string;
	currency: string;
}

/**
 * Makes the invoice a recurring template is due to make on `issueOn`, and
 * moves the template's next date on first, so that two runs at once make it
 * once. A template whose next date is past its last makes nothing more.
 * Returns the invoice's id, or null when another run made it or there was
 * nothing to put on it.
 */
export async function issueRecurring(
	scope: OrganisationScope,
	organisation: ScheduledOrganisation,
	recurringId: string,
	issueOn: Day,
	now: number,
	locale: string,
): Promise<string | null> {
	const found = await findRecurring(scope, recurringId);
	if (!found) return null;
	const { recurring, lines } = found;
	if (recurring.stoppedAt || recurring.nextIssueOn !== issueOn) return null;
	if (recurring.endsOn !== null && issueOn > recurring.endsOn) return null;

	const next = nextIssueAfter(recurring.startsOn, recurring.frequency as Frequency, issueOn);
	const claimed = await scope.recurringInvoices.update({ nextIssueOn: next }, (r) =>
		and(eq(r.id, recurringId), eq(r.nextIssueOn, issueOn), isNull(r.stoppedAt)),
	);
	if (claimed.length === 0) return null;

	const draftLines: DraftLine[] = lines.map((line) => ({
		kind: "manual",
		description: line.description,
		projectId: null,
		quantityMilli: line.quantityMilli,
		unitPriceMinor: line.unitPriceMinor,
		amountMinor: lineAmount(line.quantityMilli, line.unitPriceMinor),
		timeEntryIds: [],
		expenseIds: [],
	}));
	const lineTaxes: [string | null, string | null][] = lines.map((line) => [
		line.taxId,
		line.secondTaxId,
	]);
	if (recurring.includeUninvoicedTime) {
		const sources = await sourcesFor(
			scope,
			organisation,
			{
				clientId: recurring.clientId,
				days: null,
				projectIds: [],
				grouping: "project",
				fixedMinor: new Map(),
			},
			now,
		);
		// Only work in the template's currency: an invoice has one.
		const time = sources.lines.filter((line) => {
			const project = sources.projects.find((p) => p.id === line.projectId);
			return project?.currency === recurring.currency;
		});
		const taxes = await defaultTaxIds(scope);
		draftLines.push(...time);
		lineTaxes.push(...time.map(() => taxes));
	}
	if (draftLines.length === 0) return null;

	const created = await createDraft(
		scope,
		null,
		{
			clientId: recurring.clientId,
			currency: recurring.currency,
			issuedOn: issueOn,
			lines: draftLines,
			lineTaxes,
			subject: recurring.subject,
			notes: recurring.notes,
			paymentTermsDays: recurring.paymentTermsDays,
			recurringInvoiceId: recurring.id,
		},
		"system",
	);
	if (!created.ok) return null;
	if (!recurring.sendAutomatically) return created.id;

	const contacts = await contactsOf(scope, recurring.clientId);
	if (contacts.length === 0) return created.id;
	await sendInvoice(scope, null, created.id, {
		organisationName: organisation.name,
		to: contacts.map((c) => c.email),
		locale,
		today: issueOn,
		now: new Date(now),
		source: "system",
	});
	return created.id;
}
