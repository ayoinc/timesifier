import { destination, destinationPath } from "../shell/destinations";

// The addresses of the Contractors report (TS-079), a page below Reports, and
// of its export. Being below Reports, they are behind Reports' own check, and
// each route narrows it to the people who see money (`maySeeRates`). The route
// configuration (app/routes.ts) reads this in Node, so it imports by relative
// path, as that file does.

/** What follows the organisation in the address of the report. */
export const CONTRACTORS_SEGMENT = `${destination("reports").segment}/contractors`;

/** What follows the organisation in the address of its export. */
export const CONTRACTORS_EXPORT_SEGMENT = `${CONTRACTORS_SEGMENT}/export`;

/** The report, with `search` (which starts with `?`, or is empty) after it. */
export function contractorsPath(slug: string, search = ""): string {
	return `${destinationPath(slug, "reports")}/contractors${search}`;
}

/** The export of the report a page shows: the same query on the export's address. */
export function contractorsExportPath(slug: string, search = ""): string {
	return `${destinationPath(slug, "reports")}/contractors/export${search}`;
}
