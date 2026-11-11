import { describe, expect, it } from "vitest";
import { canonicalHost } from "../workers/canonical-host";

describe("canonical host in production", () => {
	it("sends www to the same path and query on the apex", () => {
		const response = canonicalHost(
			new Request("https://www.timesifier.com/reports?week=46"),
			"production",
		);

		expect(response?.status).toBe(308);
		expect(response?.headers.get("Location")).toBe("https://timesifier.com/reports?week=46");
	});

	it.each(["https://timesifier.com/", "http://localhost:5173/", "http://127.0.0.1:4173/"])(
		"serves %s",
		(url) => {
			expect(canonicalHost(new Request(url), "production")).toBeNull();
		},
	);

	it.each([
		// The address Cloudflare gives each uploaded version of the Worker.
		"https://41b1b1d9-timesifier.ayoinc.workers.dev/",
		"https://timesifier.ayoinc.workers.dev/",
		// A host that merely ends with the apex or the alias is neither.
		"https://notwww.timesifier.com/",
		"https://timesifier.com.attacker.example/",
	])("answers 404 on %s", (url) => {
		expect(canonicalHost(new Request(url), "production")?.status).toBe(404);
	});

	it("treats a missing or unknown environment as production", () => {
		const versionUrl = "https://41b1b1d9-timesifier.ayoinc.workers.dev/";

		expect(canonicalHost(new Request(versionUrl), undefined)?.status).toBe(404);
		expect(canonicalHost(new Request(versionUrl), "staging")?.status).toBe(404);
	});
});

describe("canonical host in a preview", () => {
	it.each([
		"https://pr-12-timesifier.ayoinc.workers.dev/",
		// A preview's own per-deployment address.
		"https://f09cd1cb-timesifier.ayoinc.workers.dev/",
	])("serves %s", (url) => {
		expect(canonicalHost(new Request(url), "preview")).toBeNull();
	});
});
