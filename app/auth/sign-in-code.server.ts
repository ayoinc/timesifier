/**
 * The emailed sign-in code: the rules of ours that Better Auth's email-code
 * plugin does not hold itself. Each runs after the rate limit and Turnstile
 * and before the plugin sees the request.
 *
 * - A request carries exactly the fields listed here. The plugin would also
 *   issue a code of three other kinds, and take a name and an image for a new
 *   account.
 * - An address is sent at most five codes in any hour, whoever asks. A code
 *   allows three guesses, so without this the guesses against one address are
 *   three times however many codes can be asked for.
 *
 * See docs/security.md, "Authentication".
 */
import { createAuthMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth/types";
import * as z from "zod";
import { valid } from "./input.server";
import { keyedHash } from "./keyed-hash.server";
import { type Cap, takeOne } from "./quota.server";

const ASK_PATH = "/email-otp/send-verification-otp";
const USE_PATH = "/sign-in/email-otp";

/** Whether `email` is an address is the plugin's to say, in its own words. */
const Asking = z.strictObject({ email: z.string().max(254), type: z.literal("sign-in") });
const Using = z.strictObject({ email: z.string().max(254), otp: z.string().max(64) });

const CODES_PER_ADDRESS: Cap = { max: 5, seconds: 60 * 60 };

type Bindings = { DB: D1Database; secret: string };

/** Spread into Better Auth's `plugins`. */
export function signInCodeRules({ DB, secret }: Bindings): BetterAuthPlugin {
	const asking = createAuthMiddleware(async (ctx) => {
		const { email } = await valid(Asking, ctx.body);
		// The plugin lower-cases the address and then refuses what is not one.
		// The same two steps here, so a code is counted only where one would be issued.
		const address = email.toLowerCase();
		if (!z.email().safeParse(address).success) return;

		// The key is a keyed hash: the table never holds an address in the clear.
		const key = `sign-in-code:${await keyedHash(secret, "sign-in-code-address", address)}`;
		if (!(await takeOne(DB, key, CODES_PER_ADDRESS))) {
			// The plugin's answer to a request it served, so the cap tells nobody
			// whether an address has been asking. Nothing is issued or sent.
			return ctx.json({ success: true });
		}
	});

	const using = createAuthMiddleware(async (ctx) => {
		await valid(Using, ctx.body);
	});

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
