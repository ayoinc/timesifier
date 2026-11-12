import { routes } from "virtual:react-router/server-build";
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

/**
 * Whether the route's address names a record of the organisation, such as an
 * expense's receipt: its stand-in names none, so even a member is answered 404
 * there. Each such route has a test of its own with a real record.
 */
export function namesARecord(route: Pick<RouteUnderTest, "address">): boolean {
	return route.address.split("/").includes("x");
}
