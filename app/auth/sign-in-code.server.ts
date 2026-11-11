/**
 * The emailed sign-in code: the rules of ours that Better Auth's email-code
 * plugin does not hold itself. Each runs after the rate limit and Turnstile
 * and before the plugin sees the request.
 *
 * - A request carries exactly the fields listed here. The plugin would also
 *   issue a code of three other kinds, and take an image for a new account and
 *   a name of any length and any JSON type.
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

/**
 * The name a person gives when they sign up, which the plugin stores when the
 * code creates their account: one line of text, of the length the sign-up
 * page allows, with no control character and none that reverses the direction
 * of text, because pages show it to other members of an organisation.
 */
const PersonName = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[^\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]+$/u);

/**
 * What each request may carry: these keys and no other, and the one kind of
 * code. What an address and a code must be is the plugin's to say, in its own
 * words.
 */
const Asking = z.strictObject({ email: z.unknown(), type: z.literal("sign-in") });
const Using = z.strictObject({
	email: z.unknown(),
	otp: z.unknown(),
	name: PersonName.optional(),
});

const CODES_PER_ADDRESS: Cap = { max: 5, seconds: 60 * 60 };

/**
 * The cookie that proves a browser asked. Better Auth puts the application's
 * prefix and attributes on it: `__Host-timesifier.sign_in_code`, `HttpOnly`,
 * `Secure`, `SameSite=Lax`, `Path=/`.
 *
 * Its value is `<expiry>.<hash>`: when the proof stops counting, in seconds
 * since the epoch, which is when the code does; and the keyed hash of the
 * lower-cased address and that expiry. There is no address in it, and nobody
 * without the secret can make one or move its expiry.
 *
 * The browser keeps it for an hour, longer than it counts, for one reason: a
 * person who types their code too late is then told that it has expired, in
 * the plugin's words for that, and not that it is wrong.
 */
const PROOF_COOKIE = "sign_in_code";
const PROOF_PURPOSE = "sign-in-code-proof";
const PROOF_KEPT_SECONDS = 60 * 60;

type Bindings = { DB: D1Database; secret: string };

/** Spread into Better Auth's `plugins`. */
export function signInCodeRules({ DB, secret }: Bindings): BetterAuthPlugin {
	const asking = createAuthMiddleware(async (ctx) => {
		const { email } = await valid(Asking, ctx.body);
		// The plugin lower-cases the address and then refuses what is not one.
		// The same two steps here, so a code is counted only where one would be issued.
		if (typeof email !== "string") return;
		const address = email.toLowerCase();
		if (!z.email().safeParse(address).success) return;

		// Set whether or not a code follows, so the cookie says nothing the answer does not.
		const expiry = Math.ceil(Date.now() / 1000) + CODE_LIFETIME_SECONDS;
		const proof = await keyedHash(secret, PROOF_PURPOSE, `${address}\n${expiry}`);
		const { name, attributes } = ctx.context.createAuthCookie(PROOF_COOKIE, {
			maxAge: PROOF_KEPT_SECONDS,
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
		// Not an address at all: the plugin refuses it, and no code is compared.
		if (typeof email !== "string") return;

		const { name } = ctx.context.createAuthCookie(PROOF_COOKIE);
		const [expiry = "", proof = ""] = (ctx.getCookie(name) ?? "").split(".");
		const asked =
			/^\d+$/.test(expiry) &&
			(await isKeyedHash(secret, PROOF_PURPOSE, `${email.toLowerCase()}\n${expiry}`, proof));
		// Each refusal is the plugin's own answer, key for key, given before the
		// plugin counts a guess. A browser that never asked gets the answer to a
		// wrong code. One that asked more than five minutes ago gets the answer to
		// an expired code, whatever newer code somebody else has asked for since.
		if (!asked) throw new APIError("BAD_REQUEST", { message: "Invalid OTP", code: "INVALID_OTP" });
		if (Number(expiry) * 1000 <= Date.now()) {
			throw new APIError("BAD_REQUEST", { message: "OTP expired", code: "OTP_EXPIRED" });
		}
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
