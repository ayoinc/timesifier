// The destinations of the application shell: the one list that the routes
// (app/routes.ts), the navigation, the direction of a route change, the check
// of who may open which (app/routes/app/organisation.tsx) and the browser tests
// all read. Nothing else writes one of these paths.
//
// Every destination belongs to an organisation, and the organisation is in the
// address: `/app/<slug>` is Timesheet, `/app/<slug>/reports` is Reports. A
// destination's address is therefore a function of the slug.
//
// The list is `docs/navigation.md`, "The navigation, top to bottom": each
// destination sits under a heading or under none, and is shown to the people
// its audience names. A person who is not shown a destination gets 404 at its
// address and at every address below it.
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
 * first organisation. Timesheet marks the moment once and takes it off the address.
 */
export const WELCOME_PARAM = "welcome";

/** The headings the navigation groups its links under, in their order. */
export const HEADINGS = ["Track", "Organize", "Review"] as const;
export type Heading = (typeof HEADINGS)[number];

/**
 * Who is shown a destination. `everyone` is every member of the organisation;
 * `managers` adds, to owners and admins, a person who manages at least one
 * team (TS-038); `administrators` is owners and admins alone.
 */
export type Audience = "everyone" | "managers" | "administrators";

const LIST = [
	{ id: "timesheet", label: "Timesheet", segment: "", heading: "Track", audience: "everyone" },
	{
		id: "time-off",
		label: "Time off",
		segment: "time-off",
		heading: "Track",
		audience: "everyone",
	},
	{
		id: "projects",
		label: "Projects",
		segment: "projects",
		heading: "Organize",
		audience: "everyone",
	},
	{
		id: "clients",
		label: "Clients",
		segment: "clients",
		heading: "Organize",
		audience: "administrators",
		// Hidden for everyone when the organisation turns Clients off (TS-048).
		needsClients: true,
	},
	{ id: "team", label: "Team", segment: "team", heading: "Organize", audience: "managers" },
	{
		id: "approvals",
		label: "Approvals",
		segment: "approvals",
		heading: "Review",
		audience: "managers",
	},
	{ id: "reports", label: "Reports", segment: "reports", heading: "Review", audience: "everyone" },
	{
		id: "settings",
		label: "Workspace settings",
		// Eight links share the bar of a 390px window only if this one is short there (TS-061).
		barLabel: "Settings",
		segment: "settings",
		heading: null,
		audience: "administrators",
	},
] as const;

export type DestinationId = (typeof LIST)[number]["id"];

export interface Destination {
	/** Also the name of its route module: `routes/app/<id>.tsx`. */
	id: DestinationId;
	/** Its link's words. Its page's heading and title say the same. */
	label: string;
	/** What follows the organisation in its address; empty for the destination the organisation's own address shows. */
	segment: string;
	/** The heading its link sits under in the navigation, or null for none. */
	heading: Heading | null;
	audience: Audience;
	/** Whether it is shown only while the organisation has Clients turned on. */
	needsClients?: boolean;
	/** The shorter words its link shows in the bar under 600px; its label is still what is read out. */
	barLabel?: string;
}

/** In the order they are shown: a later one is "forward" of an earlier one. */
export const destinations: readonly Destination[] = LIST;

/** The destination with this id. */
export function destination(id: DestinationId): Destination {
	const found = destinations.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`No destination is called ${id}.`);
	return found;
}

/** What decides which destinations a person is shown in one organisation. */
export interface Viewer {
	role: "owner" | "admin" | "member";
	/** Whether they manage at least one of the organisation's teams. */
	managesTeams: boolean;
	/** Whether the organisation has Clients turned on. */
	clientsEnabled: boolean;
}

/** Whether `viewer` is shown the destination `id`, and so may open it and every page below it. */
export function canSee(viewer: Viewer, id: DestinationId): boolean {
	const { audience, needsClients } = destination(id);
	if (needsClients && !viewer.clientsEnabled) return false;
	const administrator = viewer.role === "owner" || viewer.role === "admin";
	switch (audience) {
		case "everyone":
			return true;
		case "managers":
			return administrator || viewer.managesTeams;
		case "administrators":
			return administrator;
	}
}

/** The ids of the destinations `viewer` is shown, in the list's order. */
export function visibleDestinations(viewer: Viewer): DestinationId[] {
	return destinations.filter(({ id }) => canSee(viewer, id)).map(({ id }) => id);
}

/** A heading of the navigation and the links under it, or the links under no heading. */
export interface NavigationGroup {
	heading: Heading | null;
	destinations: Destination[];
}

/**
 * The navigation as drawn for a person shown `visible`: each heading with
 * the links under it, in the list's order. A heading with no link shown is
 * left out, so a member sees Track, Organize and Review with one link each.
 */
export function navigationGroups(visible: readonly DestinationId[]): NavigationGroup[] {
	const groups: NavigationGroup[] = [];
	for (const each of destinations) {
		if (!visible.includes(each.id)) continue;
		const last = groups.at(-1);
		if (last && last.heading === each.heading) last.destinations.push(each);
		else groups.push({ heading: each.heading, destinations: [each] });
	}
	return groups;
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

/** What follows the organisation in the address of its members: a page of Team. */
export const MEMBERS_SEGMENT = `${destination("team").segment}/members`;
/** What follows the organisation in the address of its invitations: a page of Team. */
export const INVITATIONS_SEGMENT = `${destination("team").segment}/invitations`;

/** The address of the members page of the organisation with this slug. */
export function membersPath(slug: string): string {
	return `${organisationPath(slug)}/${MEMBERS_SEGMENT}`;
}

/** The address of the invitations page of the organisation with this slug. */
export function invitationsPath(slug: string): string {
	return `${organisationPath(slug)}/${INVITATIONS_SEGMENT}`;
}

/**
 * What follows the organisation in the address of My account: the person's
 * own name, colour scheme, sign-out and leaving. It is a utility item, not a
 * destination: every member opens it, and the navigation has no link to it.
 */
export const ACCOUNT_SEGMENT = "account";

/** The address of My account in the organisation with this slug. */
export function accountPath(slug: string): string {
	return `${organisationPath(slug)}/${ACCOUNT_SEGMENT}`;
}

/**
 * Addresses that have moved, by what follows the organisation: each answers
 * with a redirect to its new place. They belong to no destination.
 */
export const MOVED: Readonly<Record<string, string>> = {
	"settings/members": MEMBERS_SEGMENT,
};

/**
 * The position in the list of the destination a path belongs to in the
 * organisation with this slug, or -1 when it belongs to none. A page below a
 * destination, such as the members under Team, belongs to it. Pass
 * `:organisation` as the slug to ask about a route's pattern.
 */
export function destinationIndex(slug: string, pathname: string): number {
	const home = organisationPath(slug);
	const path = pathname.replace(/\/+$/, "");
	if (path !== home && !path.startsWith(`${home}/`)) return -1;

	const below = path.slice(home.length + 1);
	if (Object.hasOwn(MOVED, below)) return -1;
	return destinations.findIndex(({ segment }) =>
		segment === "" ? below === "" : below === segment || below.startsWith(`${segment}/`),
	);
}
