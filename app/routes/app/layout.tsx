import { useEffect, useLayoutEffect, useRef, ViewTransition } from "react";
import { Outlet, useLocation, useNavigationType } from "react-router";

import { destinationIndex } from "~/shell/destinations";
import { Navigation } from "~/shell/Navigation";
import { finishRunningTransition, TRANSITION, useTravel } from "~/shell/transitions";

// The application shell: a skip link, the navigation and the main region every
// destination renders into. docs/design-system.md, "Shell", describes it.
//
// This route has no `middleware` and no `loader` yet. The authentication card
// adds both here as the session guard; until then /app is open and holds no data.

const MAIN_ID = "main";

export default function Shell() {
	const { pathname } = useLocation();
	const index = destinationIndex(pathname);
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
		<div className="min-h-dvh max-medium:pb-16 medium:ps-24">
			{/* Off the top edge until it is focused. With script it moves the focus
			    without adding a history entry; without, the browser follows the fragment. */}
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

			{/* The navigation takes no part in a transition. An element in one cannot be
			    pressed until the transition ends, and the next press on a destination
			    must land (design rule 8). The boundary also keeps what changes in the
			    navigation from counting as a change of the whole page. Its active
			    indicator is the one part that travels (Navigation.tsx). */}
			<ViewTransition default="none">
				<Navigation activeIndex={index} />
			</ViewTransition>

			{/* The content slides in the direction of travel, and only when the
			    destination changes: React would otherwise start a transition for every
			    render that reaches it, and each would hold back the next. */}
			<ViewTransition default="none" update={travel ? TRANSITION[travel] : "none"}>
				<main
					id={MAIN_ID}
					ref={main}
					tabIndex={-1}
					className="max-w-2xl p-4 outline-none focus-visible:focus-indicator-inner medium:p-6"
				>
					<Outlet />
				</main>
			</ViewTransition>
		</div>
	);
}
