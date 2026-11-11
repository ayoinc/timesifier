import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalHost } from "../workers/canonical-host";

const PRODUCTION = { ENVIRONMENT: "production", APP_HOST: "timesifier.example" };

afterEach(() => {
	vi.restoreAllMocks();
});

describe("canonical host in production", () => {
	it("sends www to the same path and query on the deployment's host", () => {
		const response = canonicalHost(
			new Request("https://www.timesifier.example/reports?week=46"),
			PRODUCTION,
		);

		expect(response?.status).toBe(308);
		expect(response?.headers.get("Location")).toBe("https://timesifier.example/reports?week=46");
	});

	it.each(["https://timesifier.example/", "http://localhost:5173/", "http://127.0.0.1:4173/"])(
		"serves %s",
		(url) => {
			expect(canonicalHost(new Request(url), PRODUCTION)).toBeNull();
		},
	);

	it.each([
		// The address Cloudflare gives each uploaded version of the Worker.
		"https://41b1b1d9-timesifier.acme.workers.dev/",
		"https://timesifier.acme.workers.dev/",
		// A host that merely ends with the host or the alias is neither.
		"https://notwww.timesifier.example/",
		"https://timesifier.example.attacker.example/",
	])("answers 404 on %s", (url) => {
		expect(canonicalHost(new Request(url), PRODUCTION)?.status).toBe(404);
	});

	it("treats a missing or unknown environment as production", () => {
		const versionUrl = "https://41b1b1d9-timesifier.acme.workers.dev/";
		const { APP_HOST } = PRODUCTION;

		expect(canonicalHost(new Request(versionUrl), { APP_HOST })?.status).toBe(404);
		expect(
			canonicalHost(new Request(versionUrl), { APP_HOST, ENVIRONMENT: "staging" })?.status,
		).toBe(404);
	});

	it("is the host the deployment names, whatever that is", () => {
		const elsewhere = { ENVIRONMENT: "production", APP_HOST: "time.example.org" };

		expect(canonicalHost(new Request("https://time.example.org/"), elsewhere)).toBeNull();
		expect(canonicalHost(new Request("https://timesifier.example/"), elsewhere)?.status).toBe(404);
		expect(
			canonicalHost(new Request("https://www.time.example.org/a"), elsewhere)?.headers.get(
				"Location",
			),
		).toBe("https://time.example.org/a");
	});
});

describe("canonical host where the deployment names no host", () => {
	it.each([
		["no APP_HOST", { ENVIRONMENT: "production" }, "deployment: APP_HOST is not set"],
		["an empty APP_HOST", { APP_HOST: "" }, "deployment: APP_HOST is not set"],
		// Each of these would otherwise be compared with, or redirected to, as a host.
		["a pattern", { APP_HOST: "*.workers.dev" }, "deployment: APP_HOST is not valid"],
		["a URL", { APP_HOST: "https://timesifier.example" }, "deployment: APP_HOST is not valid"],
		[
			"a host and a port",
			{ APP_HOST: "timesifier.example:8443" },
			"deployment: APP_HOST is not valid",
		],
		["one label", { APP_HOST: "localhost" }, "deployment: APP_HOST is not valid"],
	])(
		"serves nothing with %s: 500 on every host, and the log names the setting",
		(_name, env, line) => {
			const logged = vi.spyOn(console, "error").mockImplementation(() => {});

			for (const url of [
				"https://timesifier.example/",
				"https://www.timesifier.example/",
				"https://41b1b1d9-timesifier.acme.workers.dev/",
				"https://attacker.example/",
			]) {
				const response = canonicalHost(new Request(url), env);
				expect(response?.status, url).toBe(500);
				expect(response?.headers.has("Location"), url).toBe(false);
			}
			expect(logged.mock.calls).toEqual([[line], [line], [line], [line]]);
		},
	);
});

describe("canonical host in a preview", () => {
	it.each([
		"https://pr-12-timesifier.acme.workers.dev/",
		// A preview's own per-deployment address.
		"https://f09cd1cb-timesifier.acme.workers.dev/",
	])("serves %s", (url) => {
		expect(canonicalHost(new Request(url), { ENVIRONMENT: "preview" })).toBeNull();
	});
});
