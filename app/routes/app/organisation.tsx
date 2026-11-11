import { Outlet } from "react-router";

import { pendingApprovalsOf } from "~/approvals/approvals.server";
import {
	membershipContext,
	notFound,
	requireMembershipOf,
	viewerOf,
} from "~/organisations/membership.server";
import { signedInContext } from "~/routes/auth/session.server";
import {
	canSee,
	destinationIndex,
	destinations,
	ORGANISATION_PARAM,
	visibleDestinations,
} from "~/shell/destinations";
import { navigationTimer } from "~/timesheet/navigation.server";

import type { Route } from "./+types/organisation";

// The layout of one organisation's pages: everything under `/app/<slug>/`. It
// draws nothing of its own. It is here for the checks below, and to hand the
// organisation, the person's role in it and the destinations they are shown
// to the pages.

/**
 * The membership check (docs/security.md, "Organisations and roles"). It runs
 * after the session guard on `/app` and before the loader or action of every
 * route under this layout, for a document and for a data request alike. The
 * organisation is the one in the address, and the person's membership of it is
 * read from the database on that request. A person who is not a member, and
 * anybody asking for a slug no organisation has, gets the same 404.
 *
 * No route below repeats the check: a loader or an action reads the
 * organisation and the role from `membershipContext` and passes that
 * organisation's id to the server. A route added under this layout is covered
 * by being here.
 */
const requireOrganisation: Route.MiddlewareFunction = async ({ params, context }) => {
	const { user } = context.get(signedInContext);
	context.set(membershipContext, await requireMembershipOf(user, params.organisation));
};

/** The address every route's pattern starts with under this layout. */
const PATTERN_SLUG = `:${ORGANISATION_PARAM}`;

/**
 * The destination check: a member at a destination their role is not shown,
 * or at any page below it, gets the same 404 as a person who is not a member.
 * The destination is read from the pattern of the route that matched, which
 * comes from the route configuration and not from what was typed, so no way of
 * spelling an address reaches a page by another route.
 */
const requireDestination: Route.MiddlewareFunction = ({ pattern, context }) => {
	const path = pattern.startsWith("/") ? pattern : `/${pattern}`;
	const at = destinations[destinationIndex(PATTERN_SLUG, path)];
	if (at && !canSee(viewerOf(context.get(membershipContext)), at.id)) throw notFound();
};

export const middleware: Route.MiddlewareFunction[] = [requireOrganisation, requireDestination];

/**
 * What every page of the organisation may show: its name, its slug, the
 * person's role and the destinations they are shown. The id stays on the
 * server. Having a loader here also means every move between the
 * organisation's pages asks the server, and so passes the checks above.
 */
export async function loader({ context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const { organisation, role } = membership;
	return {
		name: organisation.name,
		slug: organisation.slug,
		role,
		destinations: visibleDestinations(viewerOf(membership)),
		/** The periods waiting for this person's decision, for the Approvals link (TS-047). */
		pendingApprovals: await pendingApprovalsOf(membership),
		timer: await navigationTimer(membership),
	};
}

export default function Organisation() {
	return <Outlet />;
}
