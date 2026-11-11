// The addresses of the two pages a person uses without a session, and the rule
// for where a person goes once they have one. This module imports only the
// shell's list, so the server, the pages and the tests all read the same rule.

import { APP_PATH } from "~/shell/destinations";

export const SIGN_IN_PATH = "/sign-in";
export const SIGN_UP_PATH = "/sign-up";

/** The query parameter that carries the page a person was on their way to. */
export const NEXT_PARAM = "next";

// `next` is resolved against an origin that is nobody's, so an address that
// names a host of its own resolves somewhere else and is told apart.
const NOWHERE = "https://next.invalid";

/**
 * Where a person goes after signing in. `next` is honoured only when it is a
 * path on our own origin at or under `/app`; anything else, or nothing, gives
 * `/app`. The path returned is the one the URL parser read, so `/app/../x`,
 * `//host/app` and `/\host/app` are judged as a browser would follow them.
 */
export function safeNext(next: string | null | undefined): string {
	if (!next?.startsWith("/")) return APP_PATH;

	let url: URL;
	try {
		url = new URL(next, NOWHERE);
	} catch {
		return APP_PATH;
	}
	if (url.origin !== NOWHERE) return APP_PATH;

	const inside = url.pathname === APP_PATH || url.pathname.startsWith(`${APP_PATH}/`);
	return inside ? `${url.pathname}${url.search}` : APP_PATH;
}

/** The address of a page with the place to go afterwards attached, when it is not just `/app`. */
function withNext(path: string, next: string): string {
	const safe = safeNext(next);
	return safe === APP_PATH ? path : `${path}?${NEXT_PARAM}=${encodeURIComponent(safe)}`;
}

/** The sign-in page for a person who was on their way to `next`. */
export function signInPath(next: string): string {
	return `${SIGN_IN_PATH}?${NEXT_PARAM}=${encodeURIComponent(next)}`;
}

/** The link from one of the two pages to the other, keeping where the person was going. */
export function signInLink(next: string): string {
	return withNext(SIGN_IN_PATH, next);
}

export function signUpLink(next: string): string {
	return withNext(SIGN_UP_PATH, next);
}
