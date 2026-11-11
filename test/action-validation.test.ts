import { exports } from "cloudflare:workers";
import { routes } from "virtual:react-router/server-build";
import { describe, expect, it } from "vitest";

/**
 * One malformed request for every route that exports an `action`, keyed by the
 * route's id (its file path under `app/` without the extension, for example
 * `routes/projects.new`). Each must be answered with status 400.
 *
 * A card that adds an action adds its case here; the registry test below fails
 * until it does. Build the request so it passes the origin check and any
 * sign-in the route needs, and is wrong only in its input.
 */
const malformedInput: Record<string, () => Request | Promise<Request>> = {};

const routesWithAction = Object.values(routes)
	.filter((route) => route !== undefined && route.module.action !== undefined)
	.map((route) => route?.id ?? "");

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
