import { eq } from "drizzle-orm";

import type { OrganisationScope } from "~/db";
import type { Day } from "~/time/calendar";

import { issueInvoice } from "./invoices.server";
import { sendDocument } from "./mail.server";
import { invoiceView } from "./view.server";

/**
 * Sending an invoice (TS-074): a draft is issued first, then the invoice goes
 * as a PDF to each address, and the send is recorded on its history. The
 * page, a recurring invoice set to send itself, and a late reminder all send
 * through here.
 */
export async function sendInvoice(
	scope: OrganisationScope,
	actor: string | null,
	invoiceId: string,
	{
		organisationName,
		to,
		note = null,
		reminder = false,
		locale,
		today,
		now,
		source = "web",
	}: {
		organisationName: string;
		to: readonly string[];
		note?: string | null;
		reminder?: boolean;
		locale: string;
		today: Day;
		now: Date;
		source?: "web" | "system";
	},
): Promise<{ ok: true; number: string } | { ok: false; problem: string } | null> {
	const before = await invoiceView(scope, organisationName, invoiceId, { locale, today });
	if (!before) return null;
	if (before.invoice.status === "void") {
		return { ok: false, problem: "A void invoice is not sent." };
	}
	if (before.invoice.status === "draft") {
		const issued = await issueInvoice(scope, actor, invoiceId, source);
		if (!issued?.ok) return issued;
	}
	const view =
		before.invoice.status === "draft"
			? await invoiceView(scope, organisationName, invoiceId, { locale, today })
			: before;
	if (!view) return null;
	const total = view.printed.totals.find(([label]) => label.startsWith("Total"))?.[1] ?? "";
	const balance = view.printed.totals.find(([label]) => label === "Balance due")?.[1] ?? total;
	const sent = await sendDocument(
		scope,
		actor,
		{ type: "invoice", id: invoiceId },
		to,
		{
			kind: reminder ? "reminder" : "invoice",
			organisationName,
			clientName: view.clientName,
			number: view.invoice.number,
			amount: reminder ? balance : total,
			dueOn: view.invoice.dueOn,
			note,
		},
		view.printed,
		source,
		reminder ? [] : [scope.invoices.statements.update({ sentAt: now }, (i) => eq(i.id, invoiceId))],
	);
	if (!sent.ok) return sent;
	return { ok: true, number: view.invoice.number };
}
