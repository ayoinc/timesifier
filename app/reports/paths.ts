import { destination, destinationPath } from "../shell/destinations";

// The address of a report's export, a page below Reports and so shown to whoever
// is shown Reports. The route configuration (app/routes.ts) reads this in Node,
// so it imports by relative path, as that file does.

/** What follows the organisation in the address of the export. */
export const REPORT_EXPORT_SEGMENT = `${destination("reports").segment}/export`;

/** The export of the report a page shows: the same query on the export's address. */
export function reportExportPath(slug: string, search: string): string {
	return `${destinationPath(slug, "reports")}/export${search}`;
}
