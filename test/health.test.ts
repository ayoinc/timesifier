/**
 * `/health`, which the monitors outside the application ask (TS-107a): whether
 * the Worker can reach its database and its files, and nothing more.
 */
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEALTH_CACHE, HEALTH_PATH, healthCacheKey } from "~/routes/health";
import { ORIGIN } from "./auth/harness";

const ask = (method: "GET" | "HEAD" = "GET") =>
	exports.default.fetch(new Request(`${ORIGIN}${HEALTH_PATH}`, { method }));

/** Every line written to the console's error stream from here on. */
function errorLines(): string[] {
	const lines: string[] = [];
	vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
		lines.push(parts.map(String).join(" "));
	});
	return lines;
}

beforeEach(async () => {
	// Each test starts with nothing cached in this location.
	await (await caches.open(HEALTH_CACHE)).delete(healthCacheKey(ORIGIN));
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("health", () => {
	it("health answers ok when the database and the files answer", async () => {
		const response = await ask();

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok", database: "ok", files: "ok" });
		expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.has("Set-Cookie")).toBe(false);
	});

	it("health answers 503 naming the part that failed: the database", async () => {
		const lines = errorLines();
		vi.spyOn(env.DB, "prepare").mockImplementation(() => {
			throw new Error("D1_ERROR: no such table: secret_table");
		});

		const response = await ask();

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ status: "failing", database: "failing", files: "ok" });
		// The log names the part and the error's name, never its message.
		expect(lines).toEqual(["health: database failing: Error"]);
	});

	it("health answers 503 naming the part that failed: the files", async () => {
		const lines = errorLines();
		vi.spyOn(env.BRAND, "head").mockRejectedValue(
			new TypeError("R2 is unreachable at secret-host"),
		);

		const response = await ask();

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ status: "failing", database: "ok", files: "failing" });
		expect(lines).toEqual(["health: files failing: TypeError"]);
	});

	it("reads no row and writes nothing: one SELECT 1, and the head of a key that holds nothing", async () => {
		const prepare = vi.spyOn(env.DB, "prepare");
		const head = vi.spyOn(env.BRAND, "head");
		const put = vi.spyOn(env.BRAND, "put");

		await ask();

		expect(prepare.mock.calls).toEqual([["SELECT 1"]]);
		expect(head.mock.calls).toEqual([["health"]]);
		expect(put).not.toHaveBeenCalled();
		expect(await env.BRAND.head("health")).toBeNull();
	});

	it("a second check within 30 seconds reaches neither D1 nor R2", async () => {
		await ask();
		const prepare = vi.spyOn(env.DB, "prepare");
		const head = vi.spyOn(env.BRAND, "head");

		const again = await ask();

		expect(again.status).toBe(200);
		expect(await again.json()).toEqual({ status: "ok", database: "ok", files: "ok" });
		expect(again.headers.get("Cache-Control")).toBe("no-store");
		expect(prepare).not.toHaveBeenCalled();
		expect(head).not.toHaveBeenCalled();
	});

	it("answers HEAD with the status and no body", async () => {
		const response = await ask("HEAD");

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("");
	});
});
