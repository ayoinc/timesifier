import { Outlet } from "react-router";

import { membershipContext, requireMembershipOf } from "~/organisations/membership.server";
import { signedInContext } from "~/routes/auth/session.server";

import type { Route } from "./+types/organisation";

// The layout of one organisation's pages: everything under `/app/<slug>/`. It
// draws nothing of its own. It is here for the check below, and to hand the
// organisation and the person's role in it to the pages.

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

export const middleware: Route.MiddlewareFunction[] = [requireOrganisation];

/**
 * What every page of the organisation may show: its name, its slug and the
 * person's role. The id stays on the server. Having a loader here also means
 * every move between the organisation's pages asks the server, and so passes
 * the check above.
 */
export function loader({ context }: Route.LoaderArgs) {
	const { organisation, role } = context.get(membershipContext);
	return { name: organisation.name, slug: organisation.slug, role };
}

export default function Organisation() {
	return <Outlet />;
}
