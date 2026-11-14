import { and, asc, desc, eq } from "drizzle-orm";

import { among, type OrganisationScope } from "~/db";
import type { Day } from "~/time/calendar";
import { formatDayWithYear } from "~/time/format";
import { invoiceDetailsOf, printedDocument, taxesOf } from "./documents.server";
import {
	findInvoice,
	type InvoiceLineRow,
	type InvoiceRow,
	type PaymentRow,
	settledOf,
} from "./invoices.server";
import type { PrintedDocument } from "./pdf";
import { balanceOf, daysBetween, type InvoiceState, type Settled, stateOf } from "./status";
import { termsLabel } from "./terms";

/**
 * One invoice as the page, its PDF and its email read it (TS-074): the row,
 * its lines, its client, what has been settled, its state, and the whole of
 * it in words (`PrintedDocument`). They all read this one function, so the
 * numbers agree wherever they are shown.
 */
export interface InvoiceView {
	invoice: InvoiceRow;
	clientName: string;
	lines: InvoiceLineRow[];
	payments: PaymentRow[];
	settled: Settled;
	balanceMinor: number;
	state: InvoiceState;
	printed: PrintedDocument;
}

export async function invoiceView(
	scope: OrganisationScope,
	organisationName: string,
	id: string,
	words: { locale: string; today: Day },
): Promise<InvoiceView | null> {
	const invoice = await findInvoice(scope, id);
	if (!invoice) return null;
	const [view] = await invoiceViews(scope, organisationName, [invoice], words);
	return view ?? null;
}

/** How many invoices `invoiceViews` reads at once: each query binds every id, and D1 binds at most 100 values. */
export const VIEWS_AT_ONCE = 50;

/**
 * Each of `invoices` (at most `VIEWS_AT_ONCE`) as `invoiceView` reads it, with
 * one query of each kind for all of them, so the export of every invoice
 * (TS-076) prints what each invoice's own PDF prints.
 */
export async function invoiceViews(
	scope: OrganisationScope,
	organisationName: string,
	invoices: readonly InvoiceRow[],
	{ locale, today }: { locale: string; today: Day },
): Promise<InvoiceView[]> {
	if (invoices.length === 0) return [];
	const ids = invoices.map((i) => i.id);
	const clientIds = [...new Set(invoices.map((i) => i.clientId))];
	const [allLines, taxes, details, clients, allPayments, settledById] = await Promise.all([
		scope.invoiceLines.select((l) => among(l.invoiceId, ids), {
			orderBy: (l) => [asc(l.position)],
		}),
		taxesOf(scope),
		invoiceDetailsOf(scope),
		scope.clients.select((c) => among(c.id, clientIds)),
		scope.payments.select((p) => among(p.invoiceId, ids), {
			orderBy: (p) => [desc(p.paidOn)],
		}),
		settledOf(scope, ids),
	]);
	const clientNames = new Map(clients.map((c) => [c.id, c.name]));
	return invoices.map((invoice) => {
		const lines = allLines.filter((l) => l.invoiceId === invoice.id);
		const payments = allPayments.filter((p) => p.invoiceId === invoice.id);
		const clientName = clientNames.get(invoice.clientId) ?? "";
		const settled = settledById.get(invoice.id) ?? { paidMinor: 0, writtenOffMinor: 0 };
		const balanceMinor = balanceOf(invoice.totalMinor, settled);
		const issued = invoice.status !== "draft";
		const after: [string, number][] = [];
		if (issued && invoice.status !== "void") {
			if (settled.paidMinor > 0) after.push(["Paid", -settled.paidMinor]);
			if (settled.writtenOffMinor > 0) after.push(["Written off", -settled.writtenOffMinor]);
			after.push(["Balance due", balanceMinor]);
		}
		const facts: [string, string][] = [
			["Issued", formatDayWithYear(invoice.issuedOn)],
			["Due", formatDayWithYear(invoice.dueOn)],
			["Terms", termsLabel(daysBetween(invoice.issuedOn, invoice.dueOn))],
		];
		if (invoice.poNumber) facts.push(["PO number", invoice.poNumber]);
		const printed = printedDocument({
			title: "Invoice",
			number: invoice.number,
			organisationName,
			details,
			clientName,
			facts,
			subject: invoice.subject,
			notes: invoice.notes,
			currency: invoice.currency,
			discountBasisPoints: invoice.discountBasisPoints,
			lines,
			taxes,
			after,
			locale,
		});
		return {
			invoice,
			clientName,
			lines,
			payments,
			settled,
			balanceMinor,
			state: stateOf(invoice, settled, today),
			printed,
		};
	});
}

/** The history of an invoice: its activity records, newest first. */
export function historyOf(scope: OrganisationScope, invoiceId: string) {
	return scope.activityRecords.select(
		(r) => and(eq(r.subjectType, "invoice"), eq(r.subjectId, invoiceId)),
		{ orderBy: (r) => [desc(r.createdAt)], limit: 50 },
	);
}
