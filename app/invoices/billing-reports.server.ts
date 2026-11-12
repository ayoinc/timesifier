import { inArray } from "drizzle-orm";
import * as z from "zod";

import type { OrganisationScope } from "~/db";
import { type Money, totalsByCurrency } from "~/money/money";
import { moneyText } from "~/money/typed";
import { addDays, Day } from "~/time/calendar";

import { agedOf, invoicedIn, openInvoicesOf, paymentsIn } from "./receivables.server";
import { AGE_LABELS, type Age } from "./status";

/**
 * The reports of Invoices (TS-074), for their page and their CSV alike: what
 * was invoiced in a range, the payments received in it, and what is owed now
 * by how overdue it is. The page and the file read the same rows, so their
 * figures are the same.
 */

export const BillingReportName = z.enum(["invoiced", "payments", "receivables"]);
export type BillingReportName = z.infer<typeof BillingReportName>;

export const BILLING_REPORT_LABELS: Record<BillingReportName, string> = {
	invoiced: "Invoiced",
	payments: "Payments received",
	receivables: "Receivables",
};

/** The report and range an address asks for: `?report=&from=&to=`, this month when it names no range. */
export function billingReportRequest(search: URLSearchParams, today: Day) {
	const report = BillingReportName.catch("receivables").parse(search.get("report"));
	const range = z.object({ from: Day, to: Day }).safeParse({
		from: search.get("from"),
		to: search.get("to"),
	});
	const first = `${today.slice(0, 8)}01`;
	const days =
		range.success && range.data.from <= range.data.to
			? { first: range.data.from, last: range.data.to }
			: { first, last: addDays(`${addDays(first, 31).slice(0, 8)}01`, -1) };
	return { report, days };
}

/** One row of a report: an invoice, and the amount the report counts for it. */
export interface BillingReportRow {
	key: string;
	invoiceId: string;
	number: string;
	client: string;
	/** The day the report reads the row by: issued, paid or due. */
	day: Day;
	currency: string;
	amountMinor: number;
	age: Age | null;
}

export interface BillingReport {
	report: BillingReportName;
	rows: BillingReportRow[];
	totals: Money[];
	/** For Receivables: each currency's amounts by age. */
	aged: { currency: string; byAge: Record<Age, number>; totalMinor: number }[];
}

/** The rows of `report`, for `days` (Receivables is as of `today`, whatever the range). */
export async function billingReportOf(
	scope: OrganisationScope,
	report: BillingReportName,
	days: { first: Day; last: Day },
	today: Day,
): Promise<BillingReport> {
	const clients = await scope.clients.select();
	const clientName = new Map(clients.map((c) => [c.id, c.name]));
	let rows: BillingReportRow[];
	let aged: BillingReport["aged"] = [];
	if (report === "invoiced") {
		rows = (await invoicedIn(scope, days)).map((invoice) => ({
			key: invoice.id,
			invoiceId: invoice.id,
			number: invoice.number,
			client: clientName.get(invoice.clientId) ?? "",
			day: invoice.issuedOn,
			currency: invoice.currency,
			amountMinor: invoice.totalMinor,
			age: null,
		}));
	} else if (report === "payments") {
		const payments = await paymentsIn(scope, days);
		const ids = [...new Set(payments.map((p) => p.invoiceId))];
		const invoices = ids.length === 0 ? [] : await scope.invoices.select((i) => inArray(i.id, ids));
		const invoiceOf = new Map(invoices.map((i) => [i.id, i]));
		rows = payments.flatMap((payment) => {
			const invoice = invoiceOf.get(payment.invoiceId);
			if (!invoice) return [];
			return [
				{
					key: payment.id,
					invoiceId: invoice.id,
					number: invoice.number,
					client: clientName.get(invoice.clientId) ?? "",
					day: payment.paidOn,
					currency: invoice.currency,
					amountMinor: payment.amountMinor,
					age: null,
				},
			];
		});
	} else {
		const open = await openInvoicesOf(scope, today);
		aged = agedOf(open);
		rows = open.map((invoice) => ({
			key: invoice.id,
			invoiceId: invoice.id,
			number: invoice.number,
			client: clientName.get(invoice.clientId) ?? "",
			day: invoice.dueOn,
			currency: invoice.currency,
			amountMinor: invoice.balanceMinor,
			age: invoice.age,
		}));
	}
	return { report, rows, totals: totalsByCurrency(rows), aged };
}

/** The CSV's headings for each report. */
export const BILLING_CSV_COLUMNS: Record<BillingReportName, readonly string[]> = {
	invoiced: ["invoice_number", "client", "issued_on", "currency", "total"],
	payments: ["invoice_number", "client", "paid_on", "currency", "amount"],
	receivables: ["invoice_number", "client", "due_on", "age", "currency", "balance"],
};

/** One row's cells, in the order of the report's headings; amounts as plain decimals. */
export function billingCsvCells(report: BillingReportName, row: BillingReportRow): string[] {
	const amount = moneyText(row.amountMinor, row.currency);
	return report === "receivables"
		? [row.number, row.client, row.day, AGE_LABELS[row.age ?? "current"], row.currency, amount]
		: [row.number, row.client, row.day, row.currency, amount];
}
