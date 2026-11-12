import { billingOf } from "~/invoices/context.server";
import { pdfFilename, pdfOf } from "~/invoices/pdf";
import { invoiceView } from "~/invoices/view.server";
import { notFound } from "~/organisations/membership.server";

import type { Route } from "./+types/invoices.$invoice.pdf";

// An invoice as a PDF (TS-074), made on the Worker from the same words as its
// page (`invoiceView`), so the numbers on paper are the numbers on screen. It
// sits below Invoices, so the organisation layout's checks cover it.

export async function loader({ request, context, params }: Route.LoaderArgs) {
	const { scope, organisation, today, locale } = await billingOf(context, request);
	const view = await invoiceView(scope, organisation.name, params.invoice, { locale, today });
	if (!view) throw notFound();
	return new Response(pdfOf(view.printed), {
		headers: {
			"Content-Type": "application/pdf",
			"Content-Disposition": `attachment; filename="${pdfFilename("Invoice", view.invoice.number)}"`,
			"Cache-Control": "no-store",
		},
	});
}
