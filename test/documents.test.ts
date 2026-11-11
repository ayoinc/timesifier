import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { PRIVACY_EMAIL, PRIVACY_PATH, TERMS_PATH } from "~/landing/Site";
import { COLOR_SCHEME_COOKIE } from "~/shell/color-scheme.server";

import { CODE_COOKIE, ORIGIN, SESSION_COOKIE } from "./auth/harness";

// The privacy notice and the terms, as the server sends them to anybody: no
// session, no script. What the notice says about cookies is held to the names
// the application really sets.

async function page(path: string): Promise<string> {
	const response = await exports.default.fetch(`${ORIGIN}${path}`);
	expect(response.status).toBe(200);
	expect(response.headers.get("Content-Type")).toContain("text/html");
	return response.text();
}

describe.each([PRIVACY_PATH, TERMS_PATH])("%s", (path) => {
	it("is answered whole by the server, with the date of its version and the address to write to", async () => {
		const html = await page(path);

		expect(html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
		expect(html).toMatch(/<time datetime="\d{4}-\d{2}-\d{2}"/i);
		expect(html).toContain(`href="mailto:${PRIVACY_EMAIL}"`);
	});

	it("links to the other of the two", async () => {
		const other = path === PRIVACY_PATH ? TERMS_PATH : PRIVACY_PATH;
		expect(await page(path)).toContain(`href="${other}"`);
	});
});

it("the home page links to both", async () => {
	const html = await page("/");
	expect(html).toContain(`href="${PRIVACY_PATH}"`);
	expect(html).toContain(`href="${TERMS_PATH}"`);
});

it("the privacy notice names every cookie the application sets", async () => {
	const html = await page(PRIVACY_PATH);
	for (const cookie of [SESSION_COOKIE, CODE_COOKIE, COLOR_SCHEME_COOKIE]) {
		expect(html, cookie).toContain(cookie);
	}
});
