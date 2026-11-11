/**
 * Authentication: who a request comes from.
 *
 * Better Auth runs inside the Worker and keeps identities in our D1 database
 * (docs/decisions.md entry 8). Browsers reach it at `/api/auth/*`, which
 * `handleAuthRequest` answers; server code reads the signed-in person with
 * `getSession`.
 *
 * A person proves an email address with a six-digit code sent to it, which
 * signs them in and, the first time, creates their account. Once signed in
 * they can add a passkey and use it from then on, with the code as the
 * fallback. There are no passwords.
 */

import { env, waitUntil } from "cloudflare:workers";
import { passkey } from "@better-auth/passkey";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { captcha } from "better-auth/plugins/captcha";
import { emailOTP } from "better-auth/plugins/email-otp";
import type { Session, User } from "better-auth/types";
import { drizzle } from "drizzle-orm/d1";
import { accounts, passkeys, rateLimits, sessions, users, uuidv7, verifications } from "~/db";
import { sendEmail } from "./email.server";
import { ALLOWED_HOSTS, isOurHost } from "./hosts";
import { CODE_LIFETIME_SECONDS, signInCodeEmail } from "./sign-in-code-email";

/** Attempts one client may make on one sign-in path in `window` seconds; the next is answered 429. */
const SIGN_IN_LIMIT = { window: 60, max: 10 };

/**
 * Every path of the email-code plugin that the flows above do not use. The
 * password-reset paths would also send email, without the Turnstile check.
 */
const UNUSED_PATHS = [
	"/email-otp/check-verification-otp",
	"/email-otp/verify-email",
	"/email-otp/request-password-reset",
	"/email-otp/reset-password",
	"/forget-password/email-otp",
	"/email-otp/request-email-change",
	"/email-otp/change-email",
];

type Bindings = Pick<Env, "DB" | "BETTER_AUTH_SECRET" | "TURNSTILE_SECRET_KEY">;

function createAuth({ DB, BETTER_AUTH_SECRET, TURNSTILE_SECRET_KEY }: Bindings) {
	// Better Auth falls back to a published default secret outside production
	// mode, and nothing sets production mode in a Worker. Refuse to start instead.
	if (!BETTER_AUTH_SECRET) throw new Error("BETTER_AUTH_SECRET is not set");
	if (!TURNSTILE_SECRET_KEY) throw new Error("TURNSTILE_SECRET_KEY is not set");

	return betterAuth({
		appName: "Timesifier",
		secret: BETTER_AUTH_SECRET,
		// The address is taken from the request only when its host is one of ours.
		baseURL: { allowedHosts: ALLOWED_HOSTS },

		database: drizzleAdapter(drizzle(DB), {
			provider: "sqlite",
			// Better Auth's model names, and the house-style table behind each.
			schema: {
				user: users,
				session: sessions,
				account: accounts,
				verification: verifications,
				passkey: passkeys,
				rateLimit: rateLimits,
			},
		}),

		// Read from the database on every request, never from a copy in a cookie:
		// an ended session stops working on the very next request.
		session: { cookieCache: { enabled: false } },

		rateLimit: {
			// On everywhere. Left alone, Better Auth limits only in production mode.
			enabled: true,
			// Counted in D1: a Worker's memory is neither shared between isolates nor kept.
			storage: "database",
			customRules: {
				"/email-otp/send-verification-otp": SIGN_IN_LIMIT,
				"/sign-in/email-otp": SIGN_IN_LIMIT,
				"/passkey/verify-authentication": SIGN_IN_LIMIT,
			},
		},

		disabledPaths: UNUSED_PATHS,

		advanced: {
			// Cloudflare sets this header on every request and overwrites whatever
			// the client sent; `X-Forwarded-For`, the default, can be forged.
			ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
			database: { generateId: () => uuidv7(), validateSchema: true },
			// The `__Host-` cookie that docs/security.md requires: `Secure`, `Path=/`
			// and no `Domain`, so a browser accepts it from this host alone. Better
			// Auth 1.7.20 has no option for it. `useSecureCookies: true` would put
			// `__Secure-` in front of whatever name is chosen, so it is off, the prefix
			// carries `__Host-`, and the attributes that prefix needs are set by hand.
			// See docs/decisions.md entry 8.
			useSecureCookies: false,
			cookiePrefix: "__Host-timesifier",
			defaultCookieAttributes: { secure: true, httpOnly: true, sameSite: "lax", path: "/" },
		},

		plugins: [
			// Turnstile guards the one request that sends email, which is also the
			// only way to start an account. The token arrives in `x-captcha-response`.
			captcha({
				provider: "cloudflare-turnstile",
				secretKey: TURNSTILE_SECRET_KEY,
				endpoints: ["/email-otp/send-verification-otp"],
			}),
			emailOTP({
				// Only a hash of the code is stored, so a copy of the database signs nobody in.
				storeOTP: "hashed",
				expiresIn: CODE_LIFETIME_SECONDS,
				async sendVerificationOTP({ email, otp, type }) {
					if (type !== "sign-in") return;
					// Not awaited: how long the mail takes must not show in the response.
					waitUntil(sendEmail({ to: email, ...signInCodeEmail(otp) }));
				},
			}),
			// The relying party is the host of the request, one of ALLOWED_HOSTS, so
			// a passkey made on a preview works on that preview and nowhere else.
			passkey({ rpName: "Timesifier" }),
		],
	});
}

/**
 * Calls `build` with what `read` returns and keeps the result until `read`
 * returns a different value under any key.
 */
function builtFrom<Source extends Record<string, unknown>, Result>(
	read: () => Source,
	build: (source: Source) => Result,
): () => Result {
	let built: { source: Source; result: Result } | undefined;
	return () => {
		const source = read();
		const previous = built?.source;
		const unchanged = previous && Object.keys(source).every((key) => previous[key] === source[key]);
		if (!built || !unchanged) built = { source, result: build(source) };
		return built.result;
	};
}

/**
 * The Better Auth instance, built from the Worker's bindings on first use and
 * kept for the life of the isolate. It is built again only when a binding it
 * was built from is replaced, which happens when a test overrides one.
 */
const auth = builtFrom(
	(): Bindings => ({
		DB: env.DB,
		BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
		TURNSTILE_SECRET_KEY: env.TURNSTILE_SECRET_KEY,
	}),
	createAuth,
);

/**
 * Answers a request to `/api/auth/*`: sign-in, sign-out, sessions, passkeys.
 * A request for a host that is not ours is answered 404 before Better Auth
 * sees it, so no cookie is set for such a host and none names it in a passkey.
 */
export async function handleAuthRequest(request: Request): Promise<Response> {
	if (!isOurHost(request)) return new Response("Not Found", { status: 404 });
	return auth().handler(request);
}

/** A signed-in person and the session their request carried. */
export type SignedIn = { user: User; session: Session };

/**
 * The signed-in person behind a request, or `null` when the request carries no
 * session that is still valid or was made to a host that is not ours. Reads
 * the database every time, so an ended session is gone on the next request.
 *
 * This is what a route guard calls.
 */
export async function getSession(request: Request): Promise<SignedIn | null> {
	if (!isOurHost(request)) return null;
	// Better Auth takes the host from the `Host` header here. The platform sets
	// it from the request's address; a `Request` built in code may not have it.
	const headers = new Headers(request.headers);
	headers.set("Host", new URL(request.url).host);
	return auth().api.getSession({ headers });
}
