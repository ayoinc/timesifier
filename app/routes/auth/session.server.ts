/**
 * The session, as routes use it: the guard in front of `/app`, and what the
 * sign-in page asks the server before it renders.
 */
import { env } from "cloudflare:workers";
import { createContext, type MiddlewareFunction, redirectDocument } from "react-router";

import { getSession, type SignedIn } from "~/auth/auth.server";

import { required } from "~/lib/deployment";
import { NEXT_PARAM, safeNext, signInPath } from "./paths";

/**
 * The signed-in person, for the loaders and actions under `/app`. The guard
 * sets it before any of them runs. It has no default: reading it on a route
 * the guard does not cover fails loudly.
 */
export const signedInContext = createContext<SignedIn>();

/**
 * The guard on the `/app` layout. Without a session that is still valid, the
 * request is answered with a redirect to the sign-in page, carrying the page
 * that was asked for; no loader or action under `/app` runs.
 *
 * The redirect asks for a whole page load. The sign-in page has a policy of
 * its own (docs/security.md, "Turnstile"), and a document keeps the policy it
 * was loaded with.
 */
export const requireSession: MiddlewareFunction<Response> = async ({ request, url, context }) => {
	const signedIn = await getSession(request);
	if (!signedIn) throw redirectDocument(signInPath(`${url.pathname}${url.search}`));
	context.set(signedInContext, signedIn);
};

/**
 * What the sign-in page loads: Turnstile's public site key and
 * where to go afterwards. A person who already has a session is sent there at
 * once, again as a whole page load. A deployment without a site key has no
 * widget to show, so the page is not served.
 */
export async function loadAuthPage(request: Request, url: URL) {
	const next = safeNext(url.searchParams.get(NEXT_PARAM));
	if (await getSession(request)) throw redirectDocument(next);
	return { next, turnstileSiteKey: required(env, "TURNSTILE_SITE_KEY") };
}
