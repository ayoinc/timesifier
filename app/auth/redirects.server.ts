/**
 * No request tells the application to send a browser anywhere but a path on
 * the origin the request was made to.
 *
 * Better Auth accepts a `callbackURL` on any origin it trusts, and a preview
 * trusts every preview. None of the endpoints the application offers needs a
 * place to go to at all, so the rule here is the narrow one: a path, or the
 * request is refused.
 */
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth/types";

/** Every field in which Better Auth takes a place to send the browser. */
const REDIRECT_FIELDS = ["callbackURL", "redirectTo", "errorCallbackURL", "newUserCallbackURL"];

/** Stands in for the request's origin: no value can name it. */
const OWN_ORIGIN = "https://own-origin.invalid";

/**
 * Whether `value` is a path. A browser reads `//host`, `/\host` and the same
 * with a tab inside as another host, so the value is resolved the way a
 * browser resolves it and must stay on the origin it started from.
 */
function isPath(value: unknown): boolean {
	if (typeof value !== "string" || !value.startsWith("/")) return false;
	return URL.parse(value, OWN_ORIGIN)?.origin === OWN_ORIGIN;
}

function fieldsOf(input: unknown): Record<string, unknown> {
	return typeof input === "object" && input !== null ? { ...input } : {};
}

const ownPathsOnly = createAuthMiddleware(async (ctx) => {
	for (const input of [fieldsOf(ctx.body), fieldsOf(ctx.query)]) {
		for (const field of REDIRECT_FIELDS) {
			if (field in input && !isPath(input[field])) {
				throw new APIError("FORBIDDEN", {
					code: "INVALID_REDIRECT_URL",
					message: "Invalid redirectURL",
				});
			}
		}
	}
});

/** Spread into Better Auth's `plugins`. */
export const redirectRules: BetterAuthPlugin = {
	id: "redirect-rules",
	hooks: { before: [{ matcher: () => true, handler: ownPathsOnly }] },
};
