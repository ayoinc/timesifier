import { and, desc, eq } from "drizzle-orm";

import type { OrganisationScope } from "~/db";
import type { Day } from "~/time/calendar";

import { formatDayWithYear } from "~/time/format";

import { invoiceDetailsOf, printedDocument, taxesOf } from "./documents.server";
import {
	findInvoice,
	type InvoiceLineRow,
	type InvoiceRow,
	linesOf,
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
	{ locale, today }: { locale: string; today: Day },
): Promise<InvoiceView | null> {
	const invoice = await findInvoice(scope, id);
	if (!invoice) return null;
	const [lines, taxes, details, [client], payments, settledById] = await Promise.all([
		linesOf(scope, id),
		taxesOf(scope),
		invoiceDetailsOf(scope),
		scope.clients.select((c) => eq(c.id, invoice.clientId), { limit: 1 }),
		scope.payments.select((p) => eq(p.invoiceId, id), { orderBy: (p) => [desc(p.paidOn)] }),
		settledOf(scope, [id]),
	]);
	const settled = settledById.get(id) ?? { paidMinor: 0, writtenOffMinor: 0 };
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
		clientName: client?.name ?? "",
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
		clientName: client?.name ?? "",
		lines,
		payments,
		settled,
		balanceMinor,
		state: stateOf(invoice, settled, today),
		printed,
	};
}

/** The history of an invoice: its activity records, newest first. */
export function historyOf(scope: OrganisationScope, invoiceId: string) {
	return scope.activityRecords.select(
		(r) => and(eq(r.subjectType, "invoice"), eq(r.subjectId, invoiceId)),
		{ orderBy: (r) => [desc(r.createdAt)], limit: 50 },
	);
}
