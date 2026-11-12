import {
	ACCOUNT_SEGMENT,
	destination,
	destinationPath,
	organisationPath,
} from "../shell/destinations";

// The addresses of Integrations' own pages (TS-076, TS-081, TS-089). The route
// configuration (app/routes.ts) reads this in Node, so it imports by relative
// path, as that file does.

/** What follows the organisation in the address of the CSV import, a page below Integrations. */
export const IMPORT_SEGMENT = `${destination("integrations").segment}/import`;

/** What follows the organisation in the address of the export of all time, below Integrations. */
export const EXPORT_SEGMENT = `${destination("integrations").segment}/export`;

/** What follows the organisation in the address of the ZIP of every invoice's PDF, below Integrations. */
export const INVOICES_EXPORT_SEGMENT = `${destination("integrations").segment}/invoices-export`;

/** What follows the organisation in the address of a person's calendar feeds, below My account. */
export const CALENDAR_FEEDS_SEGMENT = `${ACCOUNT_SEGMENT}/calendar`;

/** What a CSV import brings in. */
export type ImportKind = "time" | "clients" | "projects";

/** The import page, for `kind`; with `importId`, the page of that import. */
export function importPath(slug: string, kind: ImportKind = "time", importId?: string): string {
	const search = new URLSearchParams({ kind });
	if (importId) search.set("import", importId);
	return `${destinationPath(slug, "integrations")}/import?${search}`;
}

/** The download of every entry of the organisation, in the import's columns. */
export function exportPath(slug: string): string {
	return `${destinationPath(slug, "integrations")}/export`;
}

/** The download of every invoice of the organisation, each as its PDF, in one ZIP. */
export function invoicesExportPath(slug: string): string {
	return `${destinationPath(slug, "integrations")}/invoices-export`;
}

/** The page where a person makes and revokes their calendar feeds. */
export function calendarFeedsPath(slug: string): string {
	return `${organisationPath(slug)}/${CALENDAR_FEEDS_SEGMENT}`;
}

/** Where the public API answers: `/api/v1/<resource>`. */
export const API_PATH = "/api/v1";

/** Where a calendar feed answers, without the secret that follows. */
export const FEED_PATH = "/calendar";

/** The address of a calendar feed with `token`, on `origin`. */
export function feedAddress(origin: string, token: string): string {
	return `${origin}${FEED_PATH}/${token}.ics`;
}
