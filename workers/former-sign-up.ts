import { NEXT_PARAM, signInLink } from "../app/routes/auth/paths";

/** Where a page for new people once was. Links to it are still about. */
const FORMER_PATH = "/sign-up";

/**
 * There is one way in, the sign-in page, for a person who is new and a person
 * coming back alike. A request for the page that used to make an account is
 * sent there before the framework sees it, keeping only where the person was
 * going, judged by the one rule for that (`safeNext`).
 *
 * 302 and not a permanent redirect: a browser keeps a permanent one for good,
 * and the address may be wanted again.
 *
 * Returns the response to send instead of the page, or `null` to carry on.
 */
export function formerSignUp(request: Request): Response | null {
	const url = new URL(request.url);
	if (url.pathname !== FORMER_PATH || (request.method !== "GET" && request.method !== "HEAD")) {
		return null;
	}
	const next = url.searchParams.get(NEXT_PARAM) ?? "";
	return new Response(null, { status: 302, headers: { Location: signInLink(next) } });
}
