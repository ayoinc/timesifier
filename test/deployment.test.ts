/**
 * A Worker that was deployed without one of its settings. It never falls back
 * to a value of its own: what needs the setting answers 500, and the log names
 * the setting (docs/security.md, "Secrets").
 */
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowedHosts, isOurHost } from "~/auth/hosts";
import { type Setting, setting } from "~/lib/deployment";
import {
	captureEmail,
	countRows,
	get,
	type Mailbox,
	ORIGIN,
	requestCode,
	setBinding,
} from "./auth/harness";
import { freshDatabase } from "./db/database";

const PREVIEW = "https://pr-12-timesifier.acme.workers.dev";
const LOCAL = "http://localhost:5173";

const worker = exports.default;

let mailbox: Mailbox;
let logged: string[];

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	logged = [];
	vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
		logged.push(parts.map(String).join(" "));
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** The status of the two sign-in pages and of two requests to Better Auth, on one origin. */
async function signInAnswers(origin: string): Promise<number[]> {
	const responses = [
		await worker.fetch(`${origin}/sign-in`),
		await worker.fetch(`${origin}/sign-up`),
		await get("/get-session", { origin }),
		await requestCode("ada@example.com", { origin }),
	];
	return responses.map((response) => response.status);
}

async function expectNothingDone(): Promise<void> {
	expect(mailbox.send).not.toHaveBeenCalled();
	expect(await countRows("codes")).toBe(0);
	expect(await countRows("sessions")).toBe(0);
}

describe("a Worker with every setting", () => {
	it("serves sign-in, which the tests below take away one setting at a time", async () => {
		expect(await signInAnswers(ORIGIN)).toEqual([200, 200, 200, 200]);
		expect(logged).toEqual([]);
	});
});

describe("a Worker without a setting refuses sign-in", () => {
	it.each<[Setting, string | undefined, string]>([
		["BETTER_AUTH_SECRET", undefined, "not set"],
		["BETTER_AUTH_SECRET", "", "not set"],
		["TURNSTILE_SECRET_KEY", undefined, "not set"],
		["EMAIL_FROM", undefined, "not set"],
		["EMAIL_FROM", "Timesifier <no-reply@mail.timesifier.example>", "not valid"],
		["EMAIL_FROM", "no-reply@mail.timesifier.example, someone@elsewhere.example", "not valid"],
		["ENVIRONMENT", undefined, "not set"],
		["ENVIRONMENT", "staging", "not valid"],
	])("%s is %s: Better Auth answers 500 and does nothing (%s)", async (name, value, fault) => {
		setBinding(name, value);

		const session = await get("/get-session");
		const code = await requestCode("ada@example.com");

		expect([session.status, code.status]).toEqual([500, 500]);
		expect(session.headers.getSetCookie()).toEqual([]);
		expect(logged).toContain(`deployment: ${name} is ${fault}`);
		await expectNothingDone();
	});

	it("without TURNSTILE_SITE_KEY the two pages that show the widget are not served", async () => {
		setBinding("TURNSTILE_SITE_KEY", undefined);

		const [signIn, signUp] = await signInAnswers(ORIGIN);

		expect([signIn, signUp]).toEqual([500, 500]);
		expect(logged).toContain("deployment: TURNSTILE_SITE_KEY is not set");
	});

	it.each([
		["not set", undefined],
		["empty", ""],
		["a pattern that matches every host", "*"],
		["a pattern that matches other hosts", "*.com"],
		["a URL", "https://timesifier.example"],
	])("production whose APP_HOST is %s serves nothing on any host", async (_name, value) => {
		setBinding("APP_HOST", value);

		// The host it should have had, a preview's, and a version's own address.
		for (const origin of [ORIGIN, PREVIEW, "https://41b1b1d9-timesifier.acme.workers.dev"]) {
			expect(await signInAnswers(origin), origin).toEqual([500, 500, 500, 500]);
			expect((await worker.fetch(`${origin}/`)).status, origin).toBe(500);
		}
		// A loopback host is let through to the application, which refuses it there.
		expect(await signInAnswers(LOCAL)).toEqual([500, 500, 500, 500]);
		expect(logged).toContain(`deployment: APP_HOST is ${value ? "not valid" : "not set"}`);
		await expectNothingDone();
	});

	it.each([
		["not set", undefined],
		["empty", ""],
		["every workers.dev host", ".workers.dev"],
		["every host of the account", ".acme.workers.dev"],
		["a pattern", "*"],
		["production's host", "timesifier.example"],
	])("a preview whose PREVIEW_HOST_SUFFIX is %s serves no sign-in", async (_name, value) => {
		setBinding("ENVIRONMENT", "preview");
		setBinding("PREVIEW_HOST_SUFFIX", value);

		for (const origin of [PREVIEW, ORIGIN, LOCAL]) {
			expect(await signInAnswers(origin), origin).toEqual([500, 500, 500, 500]);
		}
		expect(logged).toContain(
			`deployment: PREVIEW_HOST_SUFFIX is ${value ? "not valid" : "not set"}`,
		);
		await expectNothingDone();
	});

	it("a Worker left with a developer's settings serves no sign-in anywhere but localhost", async () => {
		// What the committed wrangler.jsonc holds, if it were ever deployed as it is.
		setBinding("ENVIRONMENT", "development");
		setBinding("APP_HOST", "");
		setBinding("PREVIEW_HOST_SUFFIX", "");

		expect((await worker.fetch(`${ORIGIN}/`)).status).toBe(500);
		expect(await signInAnswers(ORIGIN)).toEqual([500, 500, 500, 500]);
		expect(await signInAnswers(PREVIEW)).toEqual([500, 500, 500, 500]);
		await expectNothingDone();
	});
});

describe("the log, when a setting is wrong", () => {
	it("names the setting and never holds its value", async () => {
		setBinding("APP_HOST", "https://a-value-that-is-not-a-host.example/");

		await worker.fetch(`${ORIGIN}/sign-in`);

		expect(logged).toEqual(["deployment: APP_HOST is not valid"]);
	});
});

describe("the hosts an environment trusts", () => {
	const production = { ENVIRONMENT: "production", APP_HOST: "time.example.org" };
	const preview = { ENVIRONMENT: "preview", PREVIEW_HOST_SUFFIX: "-time.acme.workers.dev" };

	it("are the deployment's own and no other's", () => {
		expect(allowedHosts(production)).toEqual(["time.example.org"]);
		expect(allowedHosts(preview)).toEqual(["*-time.acme.workers.dev"]);
		expect(allowedHosts({ ENVIRONMENT: "development" })).toEqual(["localhost", "localhost:*"]);
	});

	it.each([
		[production, "https://time.example.org/", true],
		[production, "https://time.example.org:8443/", false],
		[production, "https://www.time.example.org/", false],
		[production, "https://timesifier.example/", false],
		[production, "https://pr-12-time.acme.workers.dev/", false],
		[production, "http://localhost:5173/", false],
		[preview, "https://pr-12-time.acme.workers.dev/", true],
		[preview, "https://pr-12-time.other.workers.dev/", false],
		[preview, "https://time.example.org/", false],
		[preview, "http://localhost:5173/", false],
		[{ ENVIRONMENT: "development" }, "http://localhost:5173/", true],
		[{ ENVIRONMENT: "development" }, "https://time.example.org/", false],
	])("%j, %s: %s", (env, url, ours) => {
		expect(isOurHost(new Request(url), env)).toBe(ours);
	});

	it("a preview never needs production's host, nor production a preview's suffix", () => {
		expect(() => allowedHosts({ ...preview, APP_HOST: undefined })).not.toThrow();
		expect(() => allowedHosts({ ...production, PREVIEW_HOST_SUFFIX: undefined })).not.toThrow();
	});

	it.each([
		{},
		{ ENVIRONMENT: "" },
		{ ENVIRONMENT: "Production", APP_HOST: "time.example.org" },
		{ ENVIRONMENT: "production" },
		{ ENVIRONMENT: "production", APP_HOST: "Time.Example.org" },
		{ ENVIRONMENT: "production", PREVIEW_HOST_SUFFIX: "-time.acme.workers.dev" },
		{ ENVIRONMENT: "preview" },
		{ ENVIRONMENT: "preview", APP_HOST: "time.example.org" },
		{ ENVIRONMENT: "preview", PREVIEW_HOST_SUFFIX: "time.acme.workers.dev" },
		{ ENVIRONMENT: "preview", PREVIEW_HOST_SUFFIX: "-time.acme.workers.dev.attacker.example" },
	])("are never guessed: %j throws", (env) => {
		expect(() => allowedHosts(env)).toThrow(/is not (set|valid)$/);
		expect(() => isOurHost(new Request("https://time.example.org/"), env)).toThrow();
	});
});

describe("a setting", () => {
	it("is missing when it is absent, empty or not text", () => {
		expect(setting({}, "APP_HOST")).toBeUndefined();
		expect(setting({ APP_HOST: "" }, "APP_HOST")).toBeUndefined();
		expect(setting({ APP_HOST: 12 }, "APP_HOST")).toBeUndefined();
		expect(setting({ APP_HOST: "time.example.org" }, "APP_HOST")).toBe("time.example.org");
	});
});
