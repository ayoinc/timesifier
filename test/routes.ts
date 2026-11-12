import { env } from "cloudflare:workers";
import { routes } from "virtual:react-router/server-build";
import { organisationScope } from "~/db";
import { maySeeRates } from "~/organisations/access";
import type { Role } from "~/organisations/roles";
import { ORGANISATION_PARAM } from "~/shell/destinations";

// The application's routes as it was built, for the tests that request every
// route of some part of it. Read from the route configuration, so a route that
// is added is requested without anyone listing it.

export type RouteUnderTest = {
	/** The route's id: its file path under `app/` without the extension. */
	id: string;
	/** The route's full address, with a stand-in for each parameter. */
	address: string;
	hasAction: boolean;
	/** Whether it draws a page. A resource route, such as a file to download, does not. */
	hasPage: boolean;
	/** Whether it is the page shown at its parent's own address. A form for it is posted with `?index`. */
	isIndex: boolean;
	/** The ids of the routes it is nested in, outermost first. */
	ancestors: string[];
};

/** The slug every address stands on where a route takes an organisation. */
export const STAND_IN_ORGANISATION = "acme";

/** `:organisation` stands for a slug; any other `:name`, `:name?` or `*` for something a person typed. */
function standIn(segment: string): string {
	if (segment.replace(/\?$/, "") === `:${ORGANISATION_PARAM}`) return STAND_IN_ORGANISATION;
	return segment.startsWith(":") || segment === "*" ? "x" : segment;
}

/** A route's address: its own path after those of the routes it is nested in. */
function addressOf(id: string | undefined): string {
	const route = id === undefined ? undefined : routes[id];
	if (!route) return "";
	const own = (route.path ?? "").split("/").filter(Boolean).map(standIn);
	return [addressOf(route.parentId), ...own].filter(Boolean).join("/");
}

function ancestorsOf(id: string | undefined): string[] {
	const parent = id === undefined ? undefined : routes[id]?.parentId;
	return parent === undefined ? [] : [...ancestorsOf(parent), parent];
}

/** Every route of the application. */
export const allRoutes: RouteUnderTest[] = Object.values(routes)
	.filter((route) => route !== undefined)
	.map((route) => ({
		id: route.id,
		address: `/${addressOf(route.id)}`,
		hasAction: route.module.action !== undefined,
		hasPage: route.module.default !== undefined,
		isIndex: route.index === true,
		ancestors: ancestorsOf(route.id),
	}));

/** Every route whose address is `path` or below it, wherever it sits in the route tree. */
export function routesAtOrUnder(path: string): RouteUnderTest[] {
	return allRoutes.filter(({ address }) => address === path || address.startsWith(`${path}/`));
}

/** Whether the route answers an address that has moved (`MOVED` in app/shell/destinations.ts) with a redirect. */
export function isMoved(route: RouteUnderTest): boolean {
	return route.id.startsWith("routes/app/moved/");
}

/** The organisation's catch-all, which answers every address under it that holds no page with 404 (app/routes/app/not-found.tsx). */
export const NOT_FOUND_ROUTE = "routes/app/not-found";

/** Whether the route is the organisation's catch-all: a member is answered 404 there, not the page. */
export function isNotFound(route: RouteUnderTest): boolean {
	return route.id === NOT_FOUND_ROUTE;
}

/** What `standIn` puts where an address names a record, such as `:projectId`. */
const STAND_IN_RECORD = "x";

/**
 * The pages of one record, such as a project's own page
 * (`projects/:projectId`, TS-066), and how to make a record for each in an
 * organisation. Their stand-in address names no record and answers 404, so
 * `addressFor` gives each a real one before it is asked for.
 */
const RECORD_PAGES: Record<string, (organisationId: string) => Promise<string>> = {
	"routes/app/project": async (organisationId) => {
		const [project] = await organisationScope(env.DB, organisationId).projects.insert({
			name: "Site",
			nameKey: "site",
		});
		if (!project) throw new Error("No project was made.");
		return project.id;
	},
};

/**
 * Whether the route's address names a record of the organisation, such as an
 * expense's receipt, that `addressFor` makes none for: its stand-in names
 * none, so even a member is answered 404 there. Each such route has a test of
 * its own with a real record.
 */
export function namesARecord(route: Pick<RouteUnderTest, "id" | "address">): boolean {
	return route.address.split("/").includes(STAND_IN_RECORD) && !(route.id in RECORD_PAGES);
}

/**
 * The address to ask for the route at in the organisation `organisationId`:
 * its own address, or for a page of one record, that of a record made for it.
 */
export async function addressFor(route: RouteUnderTest, organisationId: string): Promise<string> {
	const make = RECORD_PAGES[route.id];
	if (!make) return route.address;
	if (!route.address.endsWith(`/${STAND_IN_RECORD}`)) {
		throw new Error(`${route.id}: its address does not end in a record's stand-in.`);
	}
	return `${route.address.slice(0, -STAND_IN_RECORD.length)}${await make(organisationId)}`;
}

/**
 * The pages below a destination that only some of those shown it may open,
 * and who: the default rates (`projects/rates`, TS-067) are below Projects,
 * which everyone is shown, and the Contractors report and its export
 * (TS-079) and the Profitability view (TS-071) below Reports; each holds money and is open to those who see rates
 * alone. Anyone else gets the 404 a destination they are not shown answers.
 */
const NARROWER: Record<string, (role: Role) => boolean> = {
	"routes/app/rates": maySeeRates,
	"routes/app/contractors": maySeeRates,
	"routes/app/contractors.export": maySeeRates,
	"routes/app/reports.profitability": maySeeRates,
};

/** Whether a person of `role`, who is shown the route's destination, may open the route. */
export function opensFor(route: RouteUnderTest, role: Role): boolean {
	return NARROWER[route.id]?.(role) ?? true;
}
