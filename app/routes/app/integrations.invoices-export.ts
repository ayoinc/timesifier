import { documentBrand } from "~/brand/document-brand.server";
import { MADE_WITH } from "~/brand/made-with";
import { billingOf } from "~/invoices/context.server";
import { invoicePdfs } from "~/invoices/export.server";
import { zip } from "~/lib/zip";
import { exportFilename } from "~/organisations/export-filename";

import type { Route } from "./+types/integrations.invoices-export";

// Every invoice of the organisation as its PDF, in one ZIP (TS-076), below
// Integrations as the export of all time is, so the same check lets only its
// owners and admins reach it and gives everyone else the same 404. Each PDF is
// the one the invoice's own page downloads. It is written as it is read, a page
// of invoices at a time, and nothing is stored. An organisation without
// invoices gets an empty ZIP, as one without time gets a CSV of headings. The
// file is named for the organisation and the day (TS-100), and the archive's
// comment, which an archive tool shows on opening it, says the same.

export async function loader({ request, context }: Route.LoaderArgs) {
	const { scope, organisation, today, locale, now } = await billingOf(context, request);
	const { art } = await documentBrand(scope.organisationId);
	const files = invoicePdfs(scope, organisation.name, art, { locale, today }, new Date(now));
	const comment = `${organisation.name}: all invoices, exported ${today}. ${MADE_WITH}.`;
	return new Response(zip(files, comment), {
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": `attachment; filename="${exportFilename(organisation.name, "all-invoices", today, "zip")}"`,
			"Cache-Control": "no-store",
		},
	});
}
