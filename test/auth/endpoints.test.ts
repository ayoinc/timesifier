/**
 * The mount offers the endpoints listed in `app/auth/endpoints.ts` and no
 * other. Better Auth registers many more, and an upgrade can add one: the walk
 * below fails when the installed library has an endpoint that is neither
 * listed nor refused.
 */
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { registeredEndpoints } from "~/auth/auth.server";
import { OFFERED_ENDPOINTS } from "~/auth/endpoints";
import { freshDatabase } from "../db/database";
import { CLIENT, ORIGIN, setBinding } from "./harness";

const offered = Object.keys(OFFERED_ENDPOINTS);

/** A request for `METHOD /path`, with `x` wherever the path takes a parameter. */
function ask(endpoint: string): Promise<Response> {
	const [method = "", path = ""] = endpoint.split(" ");
	const hasBody = method !== "GET" && method !== "HEAD";
	return exports.default.fetch(
		new Request(`${ORIGIN}/api/auth${path.replace(/:\w+|\*+/g, "x")}`, {
			method,
			headers: {
				Origin: ORIGIN,
				"CF-Connecting-IP": CLIENT,
				...(hasBody ? { "Content-Type": "application/json" } : {}),
			},
			body: hasBody ? "{}" : undefined,
		}),
	);
}

beforeEach(async () => {
	await freshDatabase();
});

describe("the endpoints under /api/auth", () => {
	it("are these 27 and no other", () => {
		expect([...offered].sort()).toEqual([
			"GET /get-session",
			"GET /organization/get-full-organization",
			"GET /organization/get-invitation",
			"GET /organization/list",
			"GET /organization/list-invitations",
			"GET /organization/list-members",
			"GET /organization/list-user-invitations",
			"GET /passkey/generate-authenticate-options",
			"GET /passkey/generate-register-options",
			"GET /passkey/list-user-passkeys",
			"POST /email-otp/send-verification-otp",
			"POST /organization/accept-invitation",
			"POST /organization/cancel-invitation",
			"POST /organization/create",
			"POST /organization/delete",
			"POST /organization/invite-member",
			"POST /organization/leave",
			"POST /organization/reject-invitation",
			"POST /organization/remove-member",
			"POST /organization/update",
			"POST /organization/update-member-role",
			"POST /passkey/delete-passkey",
			"POST /passkey/verify-authentication",
			"POST /passkey/verify-registration",
			"POST /revoke-sessions",
			"POST /sign-in/email-otp",
			"POST /sign-out",
		]);
	});

	it("are all endpoints the installed library has", () => {
		const registered = registeredEndpoints();

		expect(offered.filter((endpoint) => !registered.includes(endpoint))).toEqual([]);
	});

	it.each(offered)("%s is answered by the library, not refused by the mount", async (endpoint) => {
		// Nobody is signed in and the body is empty, so every answer is a refusal.
		// It is the library's refusal, and never "no such endpoint".
		const response = await ask(endpoint);

		expect(response.status).not.toBe(404);
		expect(response.status).toBeLessThan(500);
	});

	it("answers 404 for every other endpoint the installed library registers, before the database is touched", async () => {
		const others = registeredEndpoints()
			// An endpoint registered for any method is asked for with the two a browser uses.
			.flatMap((endpoint) =>
				endpoint.startsWith("* ")
					? [`GET ${endpoint.slice(2)}`, `POST ${endpoint.slice(2)}`]
					: [endpoint],
			)
			.filter((endpoint) => !offered.includes(endpoint));
		// Better Auth 1.7.19 registers 70 under this configuration, 43 of them not
		// offered. Far fewer would mean the walk no longer sees the library's list.
		expect(others.length).toBeGreaterThan(30);
		const touched: string[] = [];
		setBinding(
			"DB",
			new Proxy(
				{},
				{
					get(_target, property) {
						touched.push(String(property));
						throw new Error("the database was touched");
					},
				},
			),
		);

		const answers = await Promise.all(
			others.map(async (endpoint) => [endpoint, (await ask(endpoint)).status] as const),
		);

		expect(answers.filter(([, status]) => status !== 404)).toEqual([]);
		expect(touched).toEqual([]);
	});

	it.each([
		["Better Auth's health check", "GET /ok"],
		[
			"Better Auth's error page",
			"GET /error?error=probe&error_description=text+of+a+stranger's+choosing",
		],
		["a person's name and image", "POST /update-user"],
		["renaming a passkey, which no page does", "POST /passkey/update-passkey"],
		["a person's sessions, tokens included", "GET /list-sessions"],
		["the password-reset link, which redirects", "GET /reset-password/x?callbackURL=/app"],
		["a path nothing registers", "GET /no-such-endpoint"],
		["a path nothing registers, sent again and again", "GET /no-such-endpoint/2"],
		["another method on an offered path", "POST /get-session"],
		["HEAD on an offered path", "HEAD /get-session"],
		["an offered path with a slash after it", "GET /get-session/"],
		["an offered path in capitals", "GET /GET-SESSION"],
		["an offered path with an encoded letter", "GET /%67et-session"],
		["an offered path below another", "GET /x/get-session"],
	])("answers 404 for %s, and counts nothing against the client", async (_name, endpoint) => {
		const response = await ask(endpoint);

		expect(response.status).toBe(404);
		expect(await response.text()).not.toMatch(/better.?auth|probe|stranger/i);
		expect(response.headers.getSetCookie()).toEqual([]);
		expect(
			await env.DB.prepare("select count(*) as n from rate_limits").first("n"),
			"rows in rate_limits",
		).toBe(0);
	});
});
