import {
	createContext,
	data,
	type MiddlewareFunction,
	redirect,
	redirectDocument,
} from "react-router";

import { getSession, type SignedIn } from "~/auth/auth.server";
import { signInPath } from "~/routes/auth/paths";

import { isPlatformOwner } from "./owners.server";
import { PLATFORM_PATH, VERIFY_PATH } from "./paths";
import { isSteppedUp } from "./step-up.server";

// The two checks in front of every page of the platform console (TS-099).
// The first, on `/platform` and everything under it: a session, whose address
// is one of the platform's owners. Anyone else, signed in or not, gets the
// same 404 as an address that does not exist, so the console's existence is
// not confirmed to them; only a request without a session is sent to sign
// in, as every signed-in page does. The second, on every page but the one
// that asks for the code: the session has proved the owner's inbox.

/** The platform owner behind the request. */
export const platformOwnerContext = createContext<SignedIn>();

/** The 404 every page of the console answers to anybody who is not a platform owner. */
export function notFound() {
	return data("Not Found", { status: 404 });
}

export const requirePlatformOwner: MiddlewareFunction<Response> = async ({
	request,
	url,
	context,
}) => {
	const signedIn = await getSession(request);
	if (!signedIn) throw redirectDocument(signInPath(`${url.pathname}${url.search}`));
	if (!isPlatformOwner(signedIn.user.email)) throw notFound();
	context.set(platformOwnerContext, signedIn);
};

export const requireStepUp: MiddlewareFunction<Response> = async ({ url, context }) => {
	const signedIn = context.get(platformOwnerContext);
	if (await isSteppedUp(signedIn, new Date())) return;
	const next = url.pathname === PLATFORM_PATH ? "" : `?next=${encodeURIComponent(url.pathname)}`;
	throw redirect(`${VERIFY_PATH}${next}`);
};
