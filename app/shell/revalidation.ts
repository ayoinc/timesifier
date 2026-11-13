import type { ShouldRevalidateFunctionArgs } from "react-router";

/**
 * Whether a move stays on the page it is on and changes only its address's
 * query, with nothing sent to change: a step of the Timesheet, a search typed
 * into Projects (TS-114). Such a move is the page's own: what the layouts above
 * it hold (the colour scheme, whose session it is, the organisation's band and
 * timer) is the same on either side, so they read nothing again, and a page
 * that holds what the move asks for answers it with no request at all. A move
 * to another page still asks the server, and passes the session guard.
 */
export function onlyQueryMoved({
	currentUrl,
	nextUrl,
	formMethod,
}: Pick<ShouldRevalidateFunctionArgs, "currentUrl" | "nextUrl" | "formMethod">): boolean {
	const sent = formMethod !== undefined && formMethod.toUpperCase() !== "GET";
	return !sent && currentUrl.pathname === nextUrl.pathname && currentUrl.search !== nextUrl.search;
}

/** A layout's rule: nothing again for a move of the query alone (`onlyQueryMoved`), React Router's otherwise. */
export function layoutShouldRevalidate(args: ShouldRevalidateFunctionArgs): boolean {
	return onlyQueryMoved(args) ? false : args.defaultShouldRevalidate;
}
