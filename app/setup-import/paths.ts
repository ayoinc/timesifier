import { destination, organisationPath } from "../shell/destinations";

// The address of the set-up import (TS-115d), a page below Projects for owners
// and admins. The route configuration (app/routes.ts) reads this in Node, so it
// imports by relative path, as that file does.

/** What follows the organisation in the address of the set-up import. */
export const SETUP_IMPORT_SEGMENT = `${destination("projects").segment}/import`;

/** The address of the set-up import of the organisation with this slug, at one import if given. */
export function setupImportPath(slug: string, importId?: string): string {
	const path = `${organisationPath(slug)}/${SETUP_IMPORT_SEGMENT}`;
	return importId ? `${path}?${new URLSearchParams({ import: importId })}` : path;
}
