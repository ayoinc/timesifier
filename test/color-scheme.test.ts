import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { accountPath, destinationPath } from "../app/shell/destinations";
import { captureEmail, type Mailbox, signIn } from "./auth/harness";
import { freshDatabase } from "./db/database";
import { createOrganisation } from "./organisations/harness";

// The colour scheme a person chooses on My account: the action that stores it in
// the `__Host-color-scheme` cookie, and the root loader that renders it on <html>.
// Both are driven through the Worker's real fetch handler.

const ORIGIN = "https://timesifier.example";
const ACCOUNT = accountPath("acme");
const TIMESHEET = destinationPath("acme", "timesheet");

const worker = exports.default;

// My account and Timesheet belong to an organisation, under /app/<slug>, which needs a
// session and a member: every request these helpers make carries the session
// cookie of a person who has signed in and created the organisation at /app/acme. The
// sign-in happens in the test, not in a hook: the first request to the Worker
// loads the whole application, and a hook is given less time than a test.
let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function session(): Promise<string> {
	const { cookie } = await signIn(mailbox, "ada@example.com");
	expect((await createOrganisation(cookie, "Acme")).slug).toBe("acme");
	return cookie;
}

/** The My account form as a browser posts it from our own page. */
async function choose(body: string): Promise<Response> {
	return worker.fetch(
		new Request(`${ORIGIN}${ACCOUNT}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Origin: ORIGIN,
				Cookie: await session(),
			},
			body,
			redirect: "manual",
		}),
	);
}

/** The opening tag of the page the server renders for a request with this cookie beside the session's. */
async function htmlTag(cookie?: string): Promise<string> {
	const signedIn = await session();
	const response = await worker.fetch(
		new Request(`${ORIGIN}${TIMESHEET}`, {
			headers: { Cookie: cookie ? `${signedIn}; ${cookie}` : signedIn },
		}),
	);
	expect(response.status).toBe(200);
	return (await response.text()).match(/<html[^>]*>/)?.[0] ?? "";
}

describe("the colour-scheme action", () => {
	it.each(["light", "dark", "system"])("stores %s in the cookie for a year", async (scheme) => {
		const response = await choose(`scheme=${scheme}`);

		expect(response.status).toBe(303);
		expect(response.headers.get("Location")).toBe(ACCOUNT);
		// `__Host-` needs Secure, Path=/ and no Domain. No HttpOnly: the value is no secret.
		expect(response.headers.getSetCookie()).toEqual([
			`__Host-color-scheme=${scheme}; Max-Age=31536000; Path=/; Secure; SameSite=Lax`,
		]);
	});

	it.each([
		["a scheme that does not exist", "scheme=sepia"],
		["a scheme in the wrong case", "scheme=Dark"],
		["an empty scheme", "scheme="],
		["no scheme", "theme=dark"],
		["two schemes", "scheme=light&scheme=dark"],
	])("answers %s with 400 and sets no cookie", async (_case, body) => {
		const response = await choose(body);

		expect(response.status).toBe(400);
		expect(response.headers.getSetCookie()).toEqual([]);
	});

	it("is refused from another origin before it runs", async () => {
		const response = await worker.fetch(
			new Request(`${ORIGIN}${ACCOUNT}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Origin: "https://example.com",
				},
				body: "scheme=dark",
			}),
		);

		expect(response.status).toBe(403);
		expect(response.headers.getSetCookie()).toEqual([]);
	});
});

describe("the colour scheme the server renders", () => {
	// Light is the product's face: nothing in the request can say what the
	// device prefers, so a person who has chosen nothing is held to light.
	it("is light when there is no cookie, whatever the device prefers", async () => {
		expect(await htmlTag()).toBe('<html lang="en" data-color-scheme="light">');
	});

	it.each(["light", "dark"])("holds the page to %s from the cookie", async (scheme) => {
		expect(await htmlTag(`__Host-color-scheme=${scheme}`)).toBe(
			`<html lang="en" data-color-scheme="${scheme}">`,
		);
	});

	it("follows the device for a person who chose that", async () => {
		expect(await htmlTag("__Host-color-scheme=system")).toBe('<html lang="en">');
	});

	it("finds the cookie among others", async () => {
		expect(await htmlTag("a=1; __Host-color-scheme=dark; b=light")).toBe(
			'<html lang="en" data-color-scheme="dark">',
		);
	});

	it.each([
		["a value that is not a scheme", "__Host-color-scheme=sepia"],
		["an attempt to write markup", '__Host-color-scheme="><script>alert(1)</script>'],
		["an empty value", "__Host-color-scheme="],
		["a cookie of another name", "color-scheme=dark"],
	])("is light for %s", async (_case, cookie) => {
		expect(await htmlTag(cookie)).toBe('<html lang="en" data-color-scheme="light">');
	});

	it("names the colour of the browser's frame once for a held scheme, and for each where the page follows the device", async () => {
		const themes = async (cookie?: string) => {
			const response = await worker.fetch(
				new Request(`${ORIGIN}/`, { headers: cookie ? { Cookie: cookie } : {} }),
			);
			return (await response.text()).match(/<meta name="theme-color"[^>]*>/g) ?? [];
		};

		const light = await themes();
		expect(light).toHaveLength(1);
		expect(light[0]).not.toContain("media=");
		const dark = await themes("__Host-color-scheme=dark");
		expect(dark).toHaveLength(1);
		expect(dark[0]).not.toBe(light[0]);
		const device = await themes("__Host-color-scheme=system");
		expect(device).toHaveLength(2);
		for (const each of device) expect(each).toContain("prefers-color-scheme");
	});

	it("renders the scheme on every page, the home page included", async () => {
		const response = await worker.fetch(
			new Request(`${ORIGIN}/`, { headers: { Cookie: "__Host-color-scheme=dark" } }),
		);
		expect(await response.text()).toContain('<html lang="en" data-color-scheme="dark">');
	});
});
