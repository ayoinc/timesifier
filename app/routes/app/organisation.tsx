import { env } from "cloudflare:workers";
import { Link, Outlet, useParams } from "react-router";

import { pendingApprovalsOf } from "~/approvals/approvals.server";
import { organisationCountOf } from "~/db";
import { pendingLeaveOf } from "~/leave/leave.server";
import { maySeeRates } from "~/organisations/access";
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
	destinationPath,
	destinations,
	ORGANISATION_PARAM,
	organisationPath,
	visibleDestinations,
} from "~/shell/destinations";
import { errorWords } from "~/shell/error-words";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading, PageLead } from "~/shell/PageHeading";
import { finishRunningTransition } from "~/shell/transitions";
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
 * spelling an address reaches a page by another route. The catch-all
 * (`routes/app/not-found.tsx`) reaches no page; for it the address typed is
 * read, so an address below a hidden destination that holds no page gets the
 * stranger's 404 too, and not the one drawn in the person's own shell.
 */
const requireDestination: Route.MiddlewareFunction = ({ pattern, params, context }) => {
	const matched = pattern.endsWith("/*") ? `${pattern.slice(0, -1)}${params["*"] ?? ""}` : pattern;
	const path = matched.startsWith("/") ? matched : `/${matched}`;
	const at = destinations[destinationIndex(PATTERN_SLUG, path)];
	const membership = context.get(membershipContext);
	if (at && !canSee(viewerOf(membership), at.id)) throw notFound();
	// A page of a destination that shows money is refused the same way to anyone who does not see rates.
	const rest = path.slice(organisationPath(PATTERN_SLUG).length);
	if (RATES_ONLY.some((page) => rest.startsWith(page)) && !maySeeRates(membership.role)) {
		throw notFound();
	}
};

/** The pages, below their organisation, that only those who see rates are shown (TS-071). */
const RATES_ONLY = ["/reports/profitability"];

export const middleware: Route.MiddlewareFunction[] = [requireOrganisation, requireDestination];

/** The title of the organisation's error page: its heading. Each page below names itself. */
export function meta({ error }: Route.MetaArgs) {
	return error ? [{ title: `${errorWords(error, "organisation").heading} · Timesifier` }] : [];
}

/**
 * What every page of the organisation may show: its name, its slug, the
 * person's role and the destinations they are shown. The id stays on the
 * server. Having a loader here also means every move between the
 * organisation's pages asks the server, and so passes the checks above.
 */
export async function loader({ context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const { organisation, role } = membership;
	const [periods, leave, timer, organisationCount] = await Promise.all([
		pendingApprovalsOf(membership),
		pendingLeaveOf(membership),
		navigationTimer(membership),
		organisationCountOf(env.DB, membership.user.id),
	]);
	return {
		name: organisation.name,
		slug: organisation.slug,
		role,
		destinations: visibleDestinations(viewerOf(membership)),
		/**
		 * What waits for this person's decision, for the Approvals link: the
		 * periods (TS-047) and the requests for leave (TS-061).
		 */
		pendingApprovals: periods === null ? null : periods + (leave ?? 0),
		timer,
		/** For "My time report" in the profile menu: Reports with this person's time. */
		userId: membership.user.id,
		/** How many organisations the person belongs to: with more than one, the menu lists them (W31). */
		organisationCount,
	};
}

export default function Organisation() {
	return <Outlet />;
}

/**
 * What a page of the organisation says when it cannot be shown (audit W14): an
 * address under the organisation that holds no page (`routes/app/not-found.tsx`),
 * an address that asks for something that is not valid, or a page that failed.
 * It is drawn where the page would have been, so the band, the organisation's
 * name and the navigation stay. A refusal by the checks above happens before
 * the organisation is known to be the person's, and is the root's error page.
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
	const slug = useParams()[ORGANISATION_PARAM] ?? "";
	const { heading, details } = errorWords(error, "organisation");
	return (
		<>
			<PageHeading>{heading}</PageHeading>
			<PageLead>{details}</PageLead>
			<p className="mt-10">
				<Link
					to={destinationPath(slug, "timesheet")}
					onClick={finishRunningTransition}
					className={TEXT_LINK}
				>
					Go to the Timesheet
				</Link>
			</p>
		</>
	);
}
