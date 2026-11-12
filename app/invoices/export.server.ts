import { asc, gt } from "drizzle-orm";

import type { OrganisationScope } from "~/db";
import type { ZipEntry } from "~/lib/zip";
import type { Day } from "~/time/calendar";

import { pdfFilename, pdfOf } from "./pdf";
import { invoiceViews, VIEWS_AT_ONCE } from "./view.server";

// Every invoice of an organisation as the PDF its own page downloads (TS-076):
// the same `invoiceView` words through the same `pdfOf`, so each file in the
// export is byte for byte the file `invoices/<id>/pdf` answers. Drafts and
// void invoices are included, as Harvest's export includes every invoice and
// the PDF route serves them too.

/**
 * The PDFs, oldest invoice first, a page of invoices at a time, each named by
 * its number ("invoice-42.pdf"). Numbers are unique, but two can read the same
 * once made safe for a file name ("1/2" and "1-2"), so a later one is numbered.
 */
export async function* invoicePdfs(
	scope: OrganisationScope,
	organisationName: string,
	words: { locale: string; today: Day },
	modified: Date,
): AsyncGenerator<ZipEntry> {
	const taken = new Set<string>();
	let after: string | null = null;
	for (;;) {
		const last = after;
		const page = await scope.invoices.select((i) => (last ? gt(i.id, last) : undefined), {
			orderBy: (i) => [asc(i.id)],
			limit: VIEWS_AT_ONCE,
		});
		for (const view of await invoiceViews(scope, organisationName, page, words)) {
			yield {
				name: uniqueName(pdfFilename("Invoice", view.invoice.number), taken),
				bytes: pdfOf(view.printed),
				modified,
			};
		}
		const end = page.at(-1);
		if (!end || page.length < VIEWS_AT_ONCE) return;
		after = end.id;
	}
}

/** `name`, or `name` with "-2", "-3"… before its extension when it is taken; marked taken. */
function uniqueName(name: string, taken: Set<string>): string {
	const dot = name.lastIndexOf(".");
	let candidate = name;
	for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
		candidate = `${name.slice(0, dot)}-${n}${name.slice(dot)}`;
	}
	taken.add(candidate.toLowerCase());
	return candidate;
}
