import { exports } from "cloudflare:workers";
import { routes } from "virtual:react-router/server-build";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureEmail, signIn } from "./auth/harness";
import { freshDatabase } from "./db/database";

/**
 * One malformed request for every route that exports an `action`, keyed by the
 * route's id (its file path under `app/` without the extension, for example
 * `routes/projects.new`). Each must be answered with status 400.
 *
 * A card that adds an action adds its case here; the registry test below fails
 * until it does. Build the request so it passes the origin check and any
 * sign-in the route needs, and is wrong only in its input.
 */
const malformedInput: Record<string, () => Request | Promise<Request>> = {
	// Better Auth validates its own endpoints; a body that is not JSON gets its 400.
	"routes/api.auth.$": async () => {
		// Its rate limit reads the database before it reads the body.
		await freshDatabase();
		return new Request("https://timesifier.com/api/auth/sign-in/email-otp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "https://timesifier.com",
				"CF-Connecting-IP": "203.0.113.7",
			},
			body: '{"email": "ada@example.com", "otp":',
		});
	},
	// The colour scheme is one of three words; this is none of them. Settings is
	// under /app, so the request carries the session of a person who has signed in.
	"routes/app/settings": async () => {
		await freshDatabase();
		const { cookie } = await signIn(captureEmail(), "ada@example.com");
		return new Request("https://timesifier.com/app/settings", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Origin: "https://timesifier.com",
				Cookie: cookie,
			},
			body: "scheme=sepia",
		});
	},
};

const routesWithAction = Object.values(routes)
	.filter((route) => route !== undefined && route.module.action !== undefined)
	.map((route) => route?.id ?? "");

afterEach(() => {
	vi.restoreAllMocks();
});
describe("every action validates its input", () => {
	it("has a malformed-input case for every route that exports an action", () => {
		const missing = routesWithAction.filter((id) => !(id in malformedInput));
		expect(missing, "routes with an action and no case in malformedInput").toEqual([]);
	});

	it("has no case for a route without an action", () => {
		const stale = Object.keys(malformedInput).filter((id) => !routesWithAction.includes(id));
		expect(stale, "cases in malformedInput whose route has no action").toEqual([]);
	});

	it.each(Object.entries(malformedInput))(
		"%s answers malformed input with 400",
		async (_id, request) => {
			const response = await exports.default.fetch(await request());
			expect(response.status).toBe(400);
		},
	);
});
