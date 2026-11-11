/**
 * The session, as routes use it: the guard in front of `/app`, and what the
 * sign-in and sign-up pages ask the server before they render.
 */
import { env } from "cloudflare:workers";
import { createContext, type MiddlewareFunction, redirectDocument } from "react-router";
import * as z from "zod";

import { getSession, handleAuthRequest, type SignedIn } from "~/auth/auth.server";

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
 * What the sign-in and sign-up pages load: Turnstile's public site key and
 * where to go afterwards. A person who already has a session is sent there at
 * once, again as a whole page load.
 */
export async function loadAuthPage(request: Request, url: URL) {
	const next = safeNext(url.searchParams.get(NEXT_PARAM));
	if (await getSession(request)) throw redirectDocument(next);
	return { next, turnstileSiteKey: env.TURNSTILE_SITE_KEY };
}

/** What Settings shows of a passkey. The public key and the credential's id stay on the server. */
const passkeyList = z.array(
	z.object({
		id: z.string(),
		createdAt: z.iso.datetime(),
		/** Whether the authenticator said the passkey is synced to the person's other devices. */
		backedUp: z.boolean(),
	}),
);

export type PasskeySummary = z.output<typeof passkeyList>[number];

/**
 * The signed-in person's passkeys, oldest first, or `null` when they could not
 * be read. Asked of Better Auth's own endpoint with the request's cookie, so it
 * lists the passkeys of the session the request carries and nobody else's.
 */
export async function listPasskeys(request: Request): Promise<PasskeySummary[] | null> {
	const response = await handleAuthRequest(
		new Request(new URL("/api/auth/passkey/list-user-passkeys", request.url), {
			headers: request.headers,
		}),
	);
	if (!response.ok) return null;
	const passkeys = passkeyList.safeParse(await response.json());
	if (!passkeys.success) return null;
	return passkeys.data.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
