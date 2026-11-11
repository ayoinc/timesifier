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
 * - A code is used in the browser that asked for it. The answer to a request
 *   for a code sets a cookie that proves this browser asked for a code for
 *   that address; a guess without it never reaches the plugin, so a stranger
 *   cannot use up the three guesses of a code somebody else is about to type.
 *   docs/decisions.md entry 22.
 *
 * See docs/security.md, "Authentication".
 */
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth/types";
import * as z from "zod";
import { valid } from "./input.server";
import { isKeyedHash, keyedHash } from "./keyed-hash.server";
import { type Cap, takeOne } from "./quota.server";
import { CODE_LIFETIME_SECONDS } from "./sign-in-code-email";

const ASK_PATH = "/email-otp/send-verification-otp";
const USE_PATH = "/sign-in/email-otp";

/** Whether `email` is an address is the plugin's to say, in its own words. */
const Asking = z.strictObject({ email: z.string().max(254), type: z.literal("sign-in") });
const Using = z.strictObject({ email: z.string().max(254), otp: z.string().max(64) });

const CODES_PER_ADDRESS: Cap = { max: 5, seconds: 60 * 60 };

/**
 * The cookie that proves a browser asked. Better Auth puts the application's
 * prefix and attributes on it: `__Host-timesifier.sign_in_code`, `HttpOnly`,
 * `Secure`, `SameSite=Lax`, `Path=/`. It lasts as long as a code.
 *
 * Its value is `<expiry>.<hash>`: when it stops counting, in seconds since the
 * epoch, and the keyed hash of the lower-cased address and that expiry. There
 * is no address in it, and nobody without the secret can make one.
 */
const PROOF_COOKIE = "sign_in_code";
const PROOF_PURPOSE = "sign-in-code-proof";

type Bindings = { DB: D1Database; secret: string };

/** Spread into Better Auth's `plugins`. */
export function signInCodeRules({ DB, secret }: Bindings): BetterAuthPlugin {
	const asking = createAuthMiddleware(async (ctx) => {
		const { email } = await valid(Asking, ctx.body);
		// The plugin lower-cases the address and then refuses what is not one.
		// The same two steps here, so a code is counted only where one would be issued.
		const address = email.toLowerCase();
		if (!z.email().safeParse(address).success) return;

		// Set whether or not a code follows, so the cookie says nothing the answer does not.
		const expiry = Math.ceil(Date.now() / 1000) + CODE_LIFETIME_SECONDS;
		const proof = await keyedHash(secret, PROOF_PURPOSE, `${address}\n${expiry}`);
		const { name, attributes } = ctx.context.createAuthCookie(PROOF_COOKIE, {
			maxAge: CODE_LIFETIME_SECONDS,
		});
		ctx.setCookie(name, `${expiry}.${proof}`, attributes);

		// The key is a keyed hash: the table never holds an address in the clear.
		const key = `sign-in-code:${await keyedHash(secret, "sign-in-code-address", address)}`;
		if (!(await takeOne(DB, key, CODES_PER_ADDRESS))) {
			// The plugin's answer to a request it served, so the cap tells nobody
			// whether an address has been asking. Nothing is issued or sent.
			return ctx.json({ success: true });
		}
	});

	const using = createAuthMiddleware(async (ctx) => {
		const { email } = await valid(Using, ctx.body);
		const { name } = ctx.context.createAuthCookie(PROOF_COOKIE);
		const [expiry = "", proof = ""] = (ctx.getCookie(name) ?? "").split(".");
		const asked =
			/^\d+$/.test(expiry) &&
			Number(expiry) * 1000 > Date.now() &&
			(await isKeyedHash(secret, PROOF_PURPOSE, `${email.toLowerCase()}\n${expiry}`, proof));
		// The plugin's answer to a wrong code, key for key, given before the plugin
		// counts a guess.
		if (!asked) throw new APIError("BAD_REQUEST", { message: "Invalid OTP", code: "INVALID_OTP" });
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
