// The destinations of the application shell: the one list that the routes
// (app/routes.ts), the navigation, the direction of a route change and the
// browser tests all read. Nothing else writes one of these paths.
//
// This module imports nothing, so the route config (Node) and the browser tests
// (Playwright) can read it as well as the application.

/** Where the shell is mounted. A later card puts an organisation segment after it. */
export const APP_PATH = "/app";

const LIST = [
	{ id: "today", label: "Today", segment: "", icon: "today" },
	{ id: "reports", label: "Reports", segment: "reports", icon: "bar_chart" },
	{ id: "projects", label: "Projects", segment: "projects", icon: "folder" },
	{ id: "settings", label: "Settings", segment: "settings", icon: "settings" },
] as const;

export type DestinationId = (typeof LIST)[number]["id"];
/** The Material Symbol a destination is drawn with; the navigation holds the drawings. */
export type DestinationIcon = (typeof LIST)[number]["icon"];

export interface Destination {
	/** Also the name of its route module: `routes/app/<id>.tsx`. */
	id: DestinationId;
	/** The text under its icon. Its page's heading and title say the same. */
	label: string;
	/** What follows `APP_PATH` in its address; empty for the destination `APP_PATH` itself shows. */
	segment: string;
	/** Its full address. */
	path: string;
	icon: DestinationIcon;
}

/** In the order they are shown: a later one is "forward" of an earlier one. */
export const destinations: readonly Destination[] = LIST.map((destination) => ({
	...destination,
	path: destination.segment ? `${APP_PATH}/${destination.segment}` : APP_PATH,
}));

/** The destination with this id. */
export function destination(id: DestinationId): Destination {
	const found = destinations.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`No destination is called ${id}.`);
	return found;
}

/**
 * The position in the list of the destination a path belongs to, or -1 when it
 * belongs to none. A page below a destination, such as one report, belongs to it.
 */
export function destinationIndex(pathname: string): number {
	const path = pathname.replace(/\/+$/, "");
	return destinations.findIndex(
		(candidate) =>
			path === candidate.path ||
			(candidate.segment !== "" && path.startsWith(`${candidate.path}/`)),
	);
}
