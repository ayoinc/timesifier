import { organisationPath } from "../shell/destinations";

// The address of an organisation's logo (TS-100), below the organisation, so the
// organisation layout answers 404 to anyone who is not a member; and the
// logo of an estimate's organisation, below the estimate's link, for the
// client who opens it without signing in. The route configuration
// (app/routes.ts) reads this in Node, so it imports by relative path.

/** What follows the organisation in the address of its logo. */
export const LOGO_SEGMENT = "logo";

/** The address of the logo of the organisation at `slug`, as uploaded at `version`. */
export function logoPath(slug: string, version: number): string {
	return `${organisationPath(slug)}/${LOGO_SEGMENT}?v=${version}`;
}
