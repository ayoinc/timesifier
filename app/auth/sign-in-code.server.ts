/**
 * The emailed sign-in code: the rules of ours that Better Auth's email-code
 * plugin does not hold itself. Each runs before the plugin sees the request.
 *
 * See docs/security.md, "Authentication".
 */
import { createAuthMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth/types";
import * as z from "zod";
import { valid } from "./input.server";

const ASK_PATH = "/email-otp/send-verification-otp";
const USE_PATH = "/sign-in/email-otp";

/**
 * Exactly what each of the two requests may carry. The plugin would also issue
 * a code of three other kinds, and take a name and an image for a new account.
 * Whether `email` is an address is the plugin's to say, in its own words.
 */
const Asking = z.strictObject({ email: z.string().max(254), type: z.literal("sign-in") });
const Using = z.strictObject({ email: z.string().max(254), otp: z.string().max(64) });

const asking = createAuthMiddleware(async (ctx) => {
	await valid(Asking, ctx.body);
});

const using = createAuthMiddleware(async (ctx) => {
	await valid(Using, ctx.body);
});

/** Spread into Better Auth's `plugins`. */
export function signInCodeRules(): BetterAuthPlugin {
	return {
		id: "sign-in-code-rules",
		hooks: {
			before: [
				{ matcher: (ctx) => ctx.path === ASK_PATH, handler: asking },
				{ matcher: (ctx) => ctx.path === USE_PATH, handler: using },
			],
		},
	};
}
