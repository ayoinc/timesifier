import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

// The test runtime builds the routes the way `pnpm build` does: without
// DESIGN_ROUTE=1 and outside the dev server.
it("answers 404 for /design in a normal build", async () => {
	const response = await exports.default.fetch("https://timesifier.example/design");
	expect(response.status).toBe(404);
});
