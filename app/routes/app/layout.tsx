import { useEffect, useLayoutEffect, useRef, ViewTransition } from "react";
import { Outlet, useLocation, useNavigationType, useParams } from "react-router";

import { cx } from "~/components/cx";
import { requireSession, signedInContext } from "~/routes/auth/session.server";
import { destinationIndex, NEW_ORGANISATION_PATH, ORGANISATION_PARAM } from "~/shell/destinations";
import { Navigation } from "~/shell/Navigation";
import { OUTSIDE_FRAME, ProductName } from "~/shell/Outside";
import { finishRunningTransition, TRANSITION, useTravel } from "~/shell/transitions";

import type { Route } from "./+types/layout";
import { SignedInAs } from "./SignedInAs";

// The application shell: a skip link, the navigation and the main region every
// destination renders into. docs/design-system.md, "Shell", describes it.
//
// The navigation belongs to an organisation, which is in the address. The two
// pages under `/app` that have none, the chooser and the page that creates an
// organisation, are drawn in the same main region without it, under the
// product's name, like the pages a person signs in on.

/**
 * The session guard. It runs before the loader or action of every route under
 * `/app`, for a document and for a data request alike, and answers a request
 * without a session with a redirect to the sign-in page (docs/security.md,
 * "The guard on /app"). A route added under this layout is covered by being here.
 */
export const middleware: Route.MiddlewareFunction[] = [requireSession];

/**
 * Whose session it is. Having a loader here also means that every move between
 * pages asks the server, and so passes the guard: without a loader on the way,
 * React Router moves between pages that have none without a request, and a
 * person whose session has ended would go on seeing the shell.
 */
export function loader({ context }: Route.LoaderArgs) {
	return { email: context.get(signedInContext).user.email };
}

const MAIN_ID = "main";

export default function Shell({ loaderData }: Route.ComponentProps) {
	const { pathname } = useLocation();
	const organisation = useParams()[ORGANISATION_PARAM];
	// No destination is on screen outside an organisation. Arriving in one from
	// there is a move forward, and leaving one for there a move back.
	const index = organisation ? destinationIndex(organisation, pathname) : -1;
	const travel = useTravel(index);
	const main = useRef<HTMLElement>(null);

	// After a move to another page the keyboard focus goes to that page's heading.
	// A layout effect, so it happens as the page changes and not after the
	// transition has played. A page the browser loaded whole is left alone: a full
	// page load does not take the focus. Such a page arrives as "POP", so the
	// focus starts caught up with it; a page reached by a link from outside the
	// shell does not, and gets the focus like any other move.
	const loadedWhole = useNavigationType() === "POP";
	const arrivedAt = useRef(loadedWhole ? pathname : null);
	useLayoutEffect(() => {
		if (arrivedAt.current === pathname) return;
		arrivedAt.current = pathname;
		main.current?.querySelector("h1")?.focus();
	}, [pathname]);

	// Back and Forward interrupt a running transition as a press on a destination does.
	useEffect(() => {
		window.addEventListener("popstate", finishRunningTransition);
		return () => window.removeEventListener("popstate", finishRunningTransition);
	}, []);

	return (
		<div className={organisation ? "min-h-dvh max-medium:pb-16 medium:ps-24" : OUTSIDE_FRAME}>
			{/* Off the top edge until it is focused. With script it moves the focus
			    without adding a history entry; without, the browser follows the fragment. */}
			{organisation && (
				<a
					href={`#${MAIN_ID}`}
					onClick={(event) => {
						event.preventDefault();
						main.current?.focus();
					}}
					className="fixed start-4 top-4 z-20 -translate-y-20 rounded-large-increased bg-primary px-4 py-2.5 text-label-large text-on-primary shadow-level2 outline-none focus:translate-y-0 focus-visible:focus-indicator"
				>
					Skip to main content
				</a>
			)}

			{/* The navigation takes no part in a transition. An element in one cannot be
			    pressed until the transition ends, and the next press on a destination
			    must land (design rule 8). The boundary also keeps what changes in the
			    navigation from counting as a change of the whole page. Its active
			    indicator is the one part that travels (Navigation.tsx). */}
			{organisation && (
				<ViewTransition default="none">
					<Navigation organisation={organisation} activeIndex={index} />
				</ViewTransition>
			)}

			{/* Outside an organisation there is nothing to navigate, so the product's
			    name stands at the top (~/shell/Outside). */}
			{!organisation && <ProductName />}

			{/* The content slides in the direction of travel, and only when the
			    destination changes: React would otherwise start a transition for every
			    render that reaches it, and each would hold back the next. */}
			<ViewTransition default="none" update={travel ? TRANSITION[travel] : "none"}>
				<main
					id={MAIN_ID}
					ref={main}
					tabIndex={-1}
					className={cx(
						"outline-none focus-visible:focus-indicator-inner",
						organisation && "max-w-2xl p-4 medium:p-6",
					)}
				>
					<Outlet />
				</main>
			</ViewTransition>

			{/* The page that creates an organisation is where a new account lands, and
			    signing in with the wrong one of two addresses makes one: its way out says so. */}
			{!organisation && (
				<SignedInAs
					email={loaderData.email}
					wayOut={pathname === NEW_ORGANISATION_PATH ? "Use a different email" : "Sign out"}
				/>
			)}
		</div>
	);
}
