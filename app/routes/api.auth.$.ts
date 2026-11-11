/**
 * Mounts Better Auth at `/api/auth/*`. Every sign-in request from a browser
 * comes through here, because the rate limit and the Turnstile check act only
 * on requests that reach Better Auth's own handler.
 *
 * This is the one action that does not call `parseRequest`: Better Auth checks
 * each endpoint's body against its own schema and answers 400 itself
 * (docs/security.md, "Authentication").
 */
import { handleAuthRequest } from "~/auth/auth.server";
import type { Route } from "./+types/api.auth.$";

export function loader({ request }: Route.LoaderArgs) {
	return handleAuthRequest(request);
}

export function action({ request }: Route.ActionArgs) {
	return handleAuthRequest(request);
}
