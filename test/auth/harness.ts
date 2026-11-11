import { env, exports } from "cloudflare:workers";
import { expect, type MockInstance, onTestFinished, vi } from "vitest";
import * as z from "zod";
import { SIGN_IN_CODE_LENGTH } from "~/auth/code";

export const ORIGIN = "https://timesifier.com";

/** A client address from the block reserved for documentation (RFC 5737). */
export const CLIENT = "203.0.113.7";

/**
 * The token Turnstile's test widgets produce. Only the published test secret
 * keys accept it: https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 */
export const TURNSTILE_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
/** Turnstile's published test secret that fails every check. Not a secret. */
export const TURNSTILE_SECRET_THAT_FAILS = "2x0000000000000000000000000000000AA";

export const SESSION_COOKIE = "__Host-timesifier.session_token";
/** Proves that a browser asked for a code for an address (app/auth/sign-in-code.server.ts). */
export const CODE_COOKIE = "__Host-timesifier.sign_in_code";
/** Proves that a browser has signed in as an address before (app/auth/known-browser.server.ts). */
export const KNOWN_COOKIE = "__Host-timesifier.known_browser";

/** A sign-in code where it stands alone in a message. */
const CODE = new RegExp(`\\b\\d{${SIGN_IN_CODE_LENGTH}}\\b`);

/** A code of the right length that is not `code`. */
export function wrongCode(code: string): string {
	const zeros = "0".repeat(SIGN_IN_CODE_LENGTH);
	return code === zeros ? `${zeros.slice(1)}1` : zeros;
}

type RequestOptions = {
	/** The address the request is made to. Defaults to production's. */
	origin?: string;
	/** The value of the `Cookie` header. */
	cookie?: string;
	/** What Cloudflare would put in `CF-Connecting-IP`. */
	client?: string;
	headers?: Record<string, string>;
};

function headersFor({ origin = ORIGIN, cookie, client = CLIENT, headers }: RequestOptions) {
	return {
		// A browser sends `Origin` on a POST; the Worker's origin check reads it.
		Origin: origin,
		"CF-Connecting-IP": client,
		...(cookie ? { Cookie: cookie } : {}),
		...headers,
	};
}

/** A GET to Better Auth through the Worker's real fetch handler (workers/app.ts). */
export function get(path: string, options: RequestOptions = {}): Promise<Response> {
	const { origin = ORIGIN } = options;
	return exports.default.fetch(
		new Request(`${origin}/api/auth${path}`, { headers: headersFor(options) }),
	);
}

/** A JSON POST to Better Auth through the Worker's real fetch handler. */
export function post(path: string, body: unknown, options: RequestOptions = {}): Promise<Response> {
	const { origin = ORIGIN } = options;
	return exports.default.fetch(
		new Request(`${origin}/api/auth${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headersFor(options) },
			body: JSON.stringify(body),
		}),
	);
}

/** Asks for a sign-in code the way the sign-in page will, with a Turnstile token. */
export function requestCode(email: string, options: RequestOptions = {}): Promise<Response> {
	return post(
		"/email-otp/send-verification-otp",
		{ email, type: "sign-in" },
		{ ...options, headers: { "x-captcha-response": TURNSTILE_TOKEN, ...options.headers } },
	);
}

const SentEmail = z.object({
	from: z.object({ name: z.string(), email: z.string() }),
	to: z.string(),
	subject: z.string(),
	text: z.string(),
	html: z.string(),
});

/** What the Worker tried to send while `EMAIL.send` was replaced. */
export interface Mailbox {
	/** The replaced `send`, for a test that makes it fail or checks it was not called. */
	send: MockInstance<SendEmail["send"]>;
	/** Every message handed to the binding, oldest first. */
	sent(): z.infer<typeof SentEmail>[];
	/** The code in the latest message to `email`. */
	codeFor(email: string): Promise<string>;
}

/**
 * Replaces the `EMAIL` binding's `send` until `vi.restoreAllMocks()`, so no
 * test hands a message to anything.
 */
export function captureEmail(): Mailbox {
	const send = vi.spyOn(env.EMAIL, "send").mockResolvedValue({ messageId: "test" });
	const sent = () => send.mock.calls.map(([message]) => SentEmail.parse(message));

	return {
		send,
		sent,
		codeFor(email) {
			return vi.waitFor(() => {
				const message = sent()
					.filter(({ to }) => to === email)
					.at(-1);
				const code = message?.text.match(CODE)?.[0];
				if (!code) throw new Error("no code has been sent to that address");
				return code;
			});
		},
	};
}

function cookieNamed(name: string, response: Response): string {
	const cookie = response.headers.getSetCookie().find((header) => header.startsWith(`${name}=`));
	if (!cookie) throw new Error(`the response set no ${name} cookie`);
	return cookie.slice(0, cookie.indexOf(";"));
}

/** The `name=value` of the session cookie a response sets, ready for a `Cookie` header. */
export function sessionCookie(response: Response): string {
	return cookieNamed(SESSION_COOKIE, response);
}

/**
 * The `name=value` of the cookie that the answer to a request for a code sets:
 * what the browser that asked sends back with the code.
 */
export function codeCookie(response: Response): string {
	return cookieNamed(CODE_COOKIE, response);
}

/**
 * The `name=value` of the cookie that the answer to a sign-in sets: what makes
 * the browser one the address has been signed in from before.
 */
export function knownCookie(response: Response): string {
	return cookieNamed(KNOWN_COOKIE, response);
}

const SignedIn = z.object({ user: z.object({ id: z.string(), email: z.string() }) });

let journeys = 0;

/**
 * The whole email journey: ask for a code, read it from the message, sign in with it.
 *
 * Each journey comes from a client address of its own (TEST-NET-2, RFC 5737)
 * unless the test names one: a client may ask for three codes a minute, and a
 * test that signs four people in is not one client asking four times.
 *
 * A `cookie` in the options is what the browser already holds, and goes with
 * both requests.
 */
export async function signIn(mailbox: Mailbox, email: string, options: RequestOptions = {}) {
	const from = { ...options, client: options.client ?? `198.51.100.${(journeys++ % 250) + 1}` };
	const asked = await requestCode(email, from);
	expect(asked.status).toBe(200);
	const response = await post(
		"/sign-in/email-otp",
		{ email, otp: await mailbox.codeFor(email) },
		{ ...from, cookie: [options.cookie, codeCookie(asked)].filter(Boolean).join("; ") },
	);
	expect(response.status).toBe(200);
	const { user } = SignedIn.parse(await response.clone().json());
	return { response, user, cookie: sessionCookie(response) };
}

const Session = z
	.object({ user: z.object({ id: z.string(), email: z.string(), emailVerified: z.boolean() }) })
	.nullable();

/** Who the Worker says a cookie belongs to, or `null`. */
export async function whoIs(cookie: string, options: RequestOptions = {}) {
	const response = await get("/get-session", { ...options, cookie });
	expect(response.status).toBe(200);
	return Session.parse(await response.json())?.user ?? null;
}

/**
 * Gives the Worker a different value for one binding until the test ends, or
 * removes the binding when the value is `undefined`. `withEnv` does not reach
 * a request made through `exports.default.fetch`; the imported `env` object is
 * the one the Worker reads, because tests run in the Worker's own isolate.
 */
export function setBinding(name: keyof Env, value: unknown): void {
	const original = env[name];
	if (value === undefined) Reflect.deleteProperty(env, name);
	else Reflect.set(env, name, value);
	onTestFinished(() => {
		Reflect.set(env, name, original);
	});
}

const COUNTED = {
	users: "users",
	sessions: "sessions",
	// `verifications` also holds the rows that count the codes sent to an
	// address (app/auth/quota.server.ts); a code's row is named after its kind.
	codes: "verifications where identifier like '%-otp-%'",
};

/** Counts rows straight from D1, to show what a request did or did not store. */
export async function countRows(of: keyof typeof COUNTED): Promise<number> {
	return (await env.DB.prepare(`select count(*) as n from ${COUNTED[of]}`).first<number>("n")) ?? 0;
}
