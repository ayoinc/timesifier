import { destination, destinationPath, organisationPath } from "../shell/destinations";

// The addresses of the activity log's export, a page below the Activity log
// and so behind its check (owners, admins, Finance and team managers), and of
// one entry's history, which any member opens for an entry they may see
// (TS-072). The route configuration (app/routes.ts) reads this in Node, so it
// imports by relative path, as that file does.

/** What follows the organisation in the address of the export. */
export const ACTIVITY_EXPORT_SEGMENT = `${destination("activity").segment}/export`;

/** What follows the organisation in the address of an entry's history. */
export const HISTORY_SEGMENT = "history";

/** The export of the records a page shows: the same query on the export's address. */
export function activityExportPath(slug: string, search: string): string {
	return `${destinationPath(slug, "activity")}/export${search}`;
}

/** The history of the time entry `entryId`. */
export function entryHistoryPath(slug: string, entryId: string): string {
	return `${organisationPath(slug)}/${HISTORY_SEGMENT}?entry=${encodeURIComponent(entryId)}`;
}
