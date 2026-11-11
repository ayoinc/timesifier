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

/**
 * Every field in which Better Auth takes a place to send the browser, with
 * Better Auth's own answer to one it does not trust. A refusal made here is
 * that same answer, so a page reads one vocabulary.
 */
const REDIRECT_FIELDS: Record<string, { message: string; code: string }> = {
	callbackURL: { message: "Invalid callbackURL", code: "INVALID_CALLBACK_URL" },
	redirectTo: { message: "Invalid redirectURL", code: "INVALID_REDIRECT_URL" },
	errorCallbackURL: { message: "Invalid errorCallbackURL", code: "INVALID_ERROR_CALLBACK_URL" },
	newUserCallbackURL: {
		message: "Invalid newUserCallbackURL",
		code: "INVALID_NEW_USER_CALLBACK_URL",
	},
};

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

const ownPathsOnly = createAuthMiddleware(async (ctx) => {
	for (const input of [ctx.body, ctx.query]) {
		if (typeof input !== "object" || input === null) continue;
		for (const [field, refusal] of Object.entries(REDIRECT_FIELDS)) {
			if (field in input && !isPath(input[field])) throw new APIError("FORBIDDEN", refusal);
		}
	}
});

/** Spread into Better Auth's `plugins`. */
export const redirectRules: BetterAuthPlugin = {
	id: "redirect-rules",
	hooks: { before: [{ matcher: () => true, handler: ownPathsOnly }] },
};
