import { and, asc, gte, lte, ne } from "drizzle-orm";
import { data } from "react-router";
import * as z from "zod";
import { among } from "~/db";
import { billingReportRequest } from "~/invoices/billing-reports.server";
import { billingOf } from "~/invoices/context.server";
import { taxesOf } from "~/invoices/documents.server";
import { DEFAULT_XERO_OPTIONS, type XeroInvoice, xeroCsv } from "~/invoices/xero";
import { exportFilename } from "~/organisations/export-filename";
import type { Route } from "./+types/invoices.xero";

// Issued invoices as a CSV for Xero's sales-invoice import (TS-088): those
// issued from `?from=` to `?to=`, this month when neither is given, void ones
// and drafts left out. `?accountCode=`, `?noTaxType=` and `?dateOrder=` set
// what the file says for each line; Xero's own defaults when not given. It
// sits below Invoices, so the organisation layout's checks cover it.

const Options = z.object({
	accountCode: z.string().trim().min(1).max(10).optional(),
	noTaxType: z.string().trim().min(1).max(50).optional(),
	dateOrder: z.enum(["day-first", "month-first"]).optional(),
});

export async function loader({ request, context }: Route.LoaderArgs) {
	const { scope, organisation, today } = await billingOf(context, request);
	const search = new URL(request.url).searchParams;
	const query = Options.safeParse(
		Object.fromEntries(
			[...search].filter(([key, value]) => key !== "from" && key !== "to" && value.trim() !== ""),
		),
	);
	if (!query.success) throw data("Bad Request", { status: 400 });
	const { first, last } = billingReportRequest(search, today).days;

	const rows = await scope.invoices.select(
		(i) =>
			and(
				ne(i.status, "draft"),
				ne(i.status, "void"),
				gte(i.issuedOn, first),
				lte(i.issuedOn, last),
			),
		{ orderBy: (i) => [asc(i.issuedOn), asc(i.number)] },
	);
	const ids = rows.map((r) => r.id);
	const clientIds = [...new Set(rows.map((r) => r.clientId))];
	const [lines, clients, contacts, taxes] = await Promise.all([
		ids.length === 0
			? []
			: scope.invoiceLines.select((l) => among(l.invoiceId, ids), {
					orderBy: (l) => [asc(l.position)],
				}),
		clientIds.length === 0 ? [] : scope.clients.select((c) => among(c.id, clientIds)),
		clientIds.length === 0
			? []
			: scope.clientContacts.select((c) => among(c.clientId, clientIds), {
					orderBy: (c) => [asc(c.createdAt)],
				}),
		taxesOf(scope),
	]);
	const clientName = new Map(clients.map((c) => [c.id, c.name]));
	const emailOf = new Map<string, string>();
	for (const contact of contacts) {
		if (!emailOf.has(contact.clientId)) emailOf.set(contact.clientId, contact.email);
	}
	const invoices: XeroInvoice[] = rows.map((row) => ({
		number: row.number,
		clientName: clientName.get(row.clientId) ?? "",
		email: emailOf.get(row.clientId) ?? null,
		poNumber: row.poNumber,
		issuedOn: row.issuedOn,
		dueOn: row.dueOn,
		currency: row.currency,
		discountMinor: row.discountMinor,
		lines: lines.filter((l) => l.invoiceId === row.id),
	}));
	const file = xeroCsv(invoices, taxes, {
		accountCode: query.data.accountCode ?? DEFAULT_XERO_OPTIONS.accountCode,
		noTaxType: query.data.noTaxType ?? DEFAULT_XERO_OPTIONS.noTaxType,
		dateOrder: query.data.dateOrder ?? DEFAULT_XERO_OPTIONS.dateOrder,
	});
	return new Response(file, {
		headers: {
			"Content-Type": "text/csv; charset=utf-8; header=present",
			"Content-Disposition": `attachment; filename="${exportFilename(organisation.name, `xero-${first}-to-${last}`, today, "csv")}"`,
			"Cache-Control": "no-store",
		},
	});
}
