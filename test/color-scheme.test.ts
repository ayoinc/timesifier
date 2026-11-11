import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { destination } from "../app/shell/destinations";

// The colour scheme a person chooses in Settings: the action that stores it in
// the `__Host-color-scheme` cookie, and the root loader that renders it on <html>.
// Both are driven through the Worker's real fetch handler.

const ORIGIN = "https://timesifier.com";
const SETTINGS = destination("settings").path;
const TODAY = destination("today").path;

const worker = exports.default;

/** The Settings form as a browser posts it from our own page. */
function choose(body: string): Promise<Response> {
	return worker.fetch(
		new Request(`${ORIGIN}${SETTINGS}`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
			body,
			redirect: "manual",
		}),
	);
}

/** The opening tag of the page the server renders for a request with this `Cookie` header. */
async function htmlTag(cookie?: string): Promise<string> {
	const response = await worker.fetch(
		new Request(`${ORIGIN}${TODAY}`, { headers: cookie ? { Cookie: cookie } : {} }),
	);
	expect(response.status).toBe(200);
	return (await response.text()).match(/<html[^>]*>/)?.[0] ?? "";
}

describe("the colour-scheme action", () => {
	it.each(["light", "dark"])("stores %s in the cookie for a year", async (scheme) => {
		const response = await choose(`scheme=${scheme}`);

		expect(response.status).toBe(303);
		expect(response.headers.get("Location")).toBe(SETTINGS);
		// `__Host-` needs Secure, Path=/ and no Domain. No HttpOnly: the value is no secret.
		expect(response.headers.getSetCookie()).toEqual([
			`__Host-color-scheme=${scheme}; Max-Age=31536000; Path=/; Secure; SameSite=Lax`,
		]);
	});

	it("deletes the cookie for system", async () => {
		const response = await choose("scheme=system");

		expect(response.status).toBe(303);
		expect(response.headers.get("Location")).toBe(SETTINGS);
		expect(response.headers.getSetCookie()).toEqual([
			"__Host-color-scheme=; Max-Age=0; Path=/; Secure; SameSite=Lax",
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
			new Request(`${ORIGIN}${SETTINGS}`, {
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
	it("follows the device when there is no cookie", async () => {
		expect(await htmlTag()).toBe('<html lang="en">');
	});

	it.each(["light", "dark"])("forces %s from the cookie", async (scheme) => {
		expect(await htmlTag(`__Host-color-scheme=${scheme}`)).toBe(
			`<html lang="en" data-color-scheme="${scheme}">`,
		);
	});

	it("finds the cookie among others", async () => {
		expect(await htmlTag("a=1; __Host-color-scheme=dark; b=light")).toBe(
			'<html lang="en" data-color-scheme="dark">',
		);
	});

	it.each([
		["a value that is not a scheme", "__Host-color-scheme=sepia"],
		["system, which is the absence of the cookie", "__Host-color-scheme=system"],
		["an attempt to write markup", '__Host-color-scheme="><script>alert(1)</script>'],
		["an empty value", "__Host-color-scheme="],
		["a cookie of another name", "color-scheme=dark"],
	])("ignores %s", async (_case, cookie) => {
		expect(await htmlTag(cookie)).toBe('<html lang="en">');
	});

	it("renders the scheme on every page, the home page included", async () => {
		const response = await worker.fetch(
			new Request(`${ORIGIN}/`, { headers: { Cookie: "__Host-color-scheme=dark" } }),
		);
		expect(await response.text()).toContain('<html lang="en" data-color-scheme="dark">');
	});
});
