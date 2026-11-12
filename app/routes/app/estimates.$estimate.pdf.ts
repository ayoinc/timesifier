import { documentBrand } from "~/brand/document-brand.server";
import { findEstimate, printedEstimate } from "~/estimates/estimates.server";
import { billingOf } from "~/invoices/context.server";
import { pdfFilename, pdfOf } from "~/invoices/pdf";
import { notFound } from "~/organisations/membership.server";

import type { Route } from "./+types/estimates.$estimate.pdf";

// An estimate as a PDF (TS-077), printed from the same words as its page. It
// sits below Estimates, so the organisation layout's checks cover it.

export async function loader({ request, context, params }: Route.LoaderArgs) {
	const { scope, organisation, locale } = await billingOf(context, request);
	const estimate = await findEstimate(scope, params.estimate);
	if (!estimate) throw notFound();
	const [printed, brand] = await Promise.all([
		printedEstimate(scope, organisation.name, estimate, locale),
		documentBrand(scope.organisationId),
	]);
	return new Response(pdfOf(printed, brand.art), {
		headers: {
			"Content-Type": "application/pdf",
			"Content-Disposition": `attachment; filename="${pdfFilename("Estimate", estimate.number)}"`,
			"Cache-Control": "no-store",
		},
	});
}
