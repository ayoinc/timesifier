// The destinations of the application shell: the one list that the routes
// (app/routes.ts), the navigation, the direction of a route change and the
// browser tests all read. Nothing else writes one of these paths.
//
// Every destination belongs to an organisation, and the organisation is in the
// address: `/app/<slug>` is Today, `/app/<slug>/reports` is Reports. A
// destination's address is therefore a function of the slug.
//
// This module imports nothing, so the route config (Node) and the browser tests
// (Playwright) can read it as well as the application.

/** Where the shell is mounted. An organisation's slug comes after it. */
export const APP_PATH = "/app";

/** What follows `/app` in the address of the page that creates an organisation: a word no slug can be. */
export const NEW_ORGANISATION_SEGMENT = "new";
export const NEW_ORGANISATION_PATH = `${APP_PATH}/${NEW_ORGANISATION_SEGMENT}`;

/** The name of the route parameter that holds the organisation's slug. */
export const ORGANISATION_PARAM = "organisation";

/**
 * The query on the address a person arrives at straight after creating their
 * first organisation. Today marks the moment once and takes it off the address.
 */
export const WELCOME_PARAM = "welcome";

const LIST = [
	{ id: "today", label: "Today", segment: "" },
	{ id: "reports", label: "Reports", segment: "reports" },
	{ id: "projects", label: "Projects", segment: "projects" },
	{ id: "settings", label: "Settings", segment: "settings" },
] as const;

export type DestinationId = (typeof LIST)[number]["id"];

export interface Destination {
	/** Also the name of its route module: `routes/app/<id>.tsx`. */
	id: DestinationId;
	/** Its link's words. Its page's heading and title say the same. */
	label: string;
	/** What follows the organisation in its address; empty for the destination the organisation's own address shows. */
	segment: string;
}

/** In the order they are shown: a later one is "forward" of an earlier one. */
export const destinations: readonly Destination[] = LIST;

/** The destination with this id. */
export function destination(id: DestinationId): Destination {
	const found = destinations.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`No destination is called ${id}.`);
	return found;
}

/** The address of the organisation with this slug, which is also the address of its first destination. */
export function organisationPath(slug: string): string {
	return `${APP_PATH}/${slug}`;
}

/** The address of a destination in the organisation with this slug. */
export function destinationPath(slug: string, id: DestinationId): string {
	const { segment } = destination(id);
	return segment ? `${organisationPath(slug)}/${segment}` : organisationPath(slug);
}

/**
 * What follows the organisation in the address of its members and invitations:
 * a page of its own that is reached from Settings and belongs to it.
 */
export const MEMBERS_SEGMENT = `${destination("settings").segment}/members`;

/** The address of the members page of the organisation with this slug. */
export function membersPath(slug: string): string {
	return `${organisationPath(slug)}/${MEMBERS_SEGMENT}`;
}

/**
 * The position in the list of the destination a path belongs to in the
 * organisation with this slug, or -1 when it belongs to none. A page below a
 * destination, such as the members under Settings, belongs to it.
 */
export function destinationIndex(slug: string, pathname: string): number {
	const home = organisationPath(slug);
	const path = pathname.replace(/\/+$/, "");
	if (path !== home && !path.startsWith(`${home}/`)) return -1;

	const below = path.slice(home.length + 1);
	return destinations.findIndex(({ segment }) =>
		segment === "" ? below === "" : below === segment || below.startsWith(`${segment}/`),
	);
}
