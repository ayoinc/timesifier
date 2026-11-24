/**
 * Every request the Worker makes to the internet in the tests comes here
 * (vitest.workers.config.ts, `outboundService`), and runs in Node.
 *
 * The one the tests need answered is Turnstile's `siteverify`, which the
 * request for a sign-in code makes, so every sign-in in the tests does. It is
 * answered here, as Cloudflare answers its published test secrets: they are
 * the only secrets the tests send it, and its answer to each is fixed.
 * https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 * Asking Cloudflare itself made each sign-in wait on the network, and when an
 * answer took more than the captcha plugin's ten seconds the request for a
 * code failed with a 500 (run 45308117222). A test that wants another answer
 * replaces `fetch` in the Worker, and its request never reaches this.
 *
 * Anything else is refused, so a test that would reach the network fails at
 * once and says where.
 */

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Cloudflare's answer to each published test secret, as it gave them on 2026-11-24. */
const ANSWERS: Record<string, Record<string, unknown>> = {
	"1x0000000000000000000000000000000AA": {
		success: true,
		"error-codes": [],
		hostname: "example.com",
		metadata: { result_with_testing_key: true },
	},
	"2x0000000000000000000000000000000AA": {
		success: false,
		"error-codes": ["invalid-input-response"],
		messages: [],
		metadata: { result_with_testing_key: true },
	},
	"3x0000000000000000000000000000000AA": {
		success: false,
		"error-codes": ["timeout-or-duplicate"],
		messages: [],
		metadata: { result_with_testing_key: true },
	},
};

/** Cloudflare's answer to any secret it does not know. */
const UNKNOWN_SECRET = { success: false, "error-codes": ["invalid-input-secret"], messages: [] };

export async function outbound(request: Request): Promise<Response> {
	if (request.method !== "POST" || request.url !== SITEVERIFY) {
		throw new Error(`The Worker's tests reach no network: ${request.method} ${request.url}`);
	}
	const { secret } = (await request.json()) as { secret?: unknown };
	const answer =
		typeof secret === "string" && Object.hasOwn(ANSWERS, secret) ? ANSWERS[secret] : UNKNOWN_SECRET;
	return Response.json(
		answer.success ? { ...answer, challenge_ts: new Date().toISOString() } : answer,
	);
}
