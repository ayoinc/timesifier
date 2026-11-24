import { organisationPath } from "../shell/destinations";

// The export of everything (TS-126): its page below Workspace settings, which
// only owners open, and the address its ZIP downloads from. The route
// configuration (app/routes.ts) reads this in Node, so it imports by relative
// path, as that file does.

/** What follows the organisation in the address of the export's page. */
export const EVERYTHING_EXPORT_SEGMENT = "settings/export";

/** What follows the organisation in the address the export's ZIP downloads from. */
export const EVERYTHING_DOWNLOAD_SEGMENT = `${EVERYTHING_EXPORT_SEGMENT}/download`;

/** The address of the export's page in the organisation with this slug. */
export function everythingExportPath(slug: string): string {
	return `${organisationPath(slug)}/${EVERYTHING_EXPORT_SEGMENT}`;
}

/** The address the export's ZIP downloads from. */
export function everythingDownloadPath(slug: string): string {
	return `${organisationPath(slug)}/${EVERYTHING_DOWNLOAD_SEGMENT}`;
}

/** Days a made export is kept, after which its file and its row are deleted. */
export const EXPORT_KEEP_DAYS = 7;

/** The version of the export's layout, which its manifest names. */
export const EXPORT_FORMAT_VERSION = 1;
