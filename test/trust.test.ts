import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SECURITY_EMAIL, SECURITY_PATH } from "~/landing/Site";
import { SECURITY_TXT_EXPIRES, SECURITY_TXT_SET } from "~/routes/security-txt";

import { ORIGIN } from "./auth/harness";

// /.well-known/security.txt, RFC 9116 (TS-105). https://www.rfc-editor.org/rfc/rfc9116

const DAY = 24 * 60 * 60 * 1000;
const ADDRESS = "/.well-known/security.txt";

/** The file's fields, in order, as `[name, value]`. */
async function securityTxt(): Promise<[string, string][]> {
	const response = await exports.default.fetch(`${ORIGIN}${ADDRESS}`);
	expect(response.status).toBe(200);
	expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
	const text = await response.text();
	expect(text.endsWith("\n")).toBe(true);
	return text
		.trimEnd()
		.split("\n")
		.map((line) => {
			const match = line.match(/^([A-Za-z-]+): (.+)$/);
			expect(match, line).not.toBeNull();
			return [match?.[1] ?? "", match?.[2] ?? ""];
		});
}

describe("security.txt", () => {
	it("security.txt has the fields RFC 9116 requires, once each", async () => {
		const fields = await securityTxt();

		expect(fields.map(([name]) => name)).toEqual([
			"Contact",
			"Expires",
			"Canonical",
			"Policy",
			"Preferred-Languages",
		]);
		const value = Object.fromEntries(fields);
		expect(value.Contact).toBe(`mailto:${SECURITY_EMAIL}`);
		// The address it is served at, on the host it was asked on: the file applies to that host alone.
		expect(value.Canonical).toBe(`${ORIGIN}${ADDRESS}`);
		expect(value["Preferred-Languages"]).toBe("en");
		// An Internet date and time (RFC 3339), as 2.5.5 asks.
		expect(value.Expires).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
	});

	it("its Policy is the security page's part on reporting, and that part names the same address", async () => {
		const policy = new URL(Object.fromEntries(await securityTxt()).Policy);
		expect(`${policy.origin}${policy.pathname}`).toBe(`${ORIGIN}${SECURITY_PATH}`);
		expect(policy.hash).toBe("#reporting");

		const page = await exports.default.fetch(`${ORIGIN}${policy.pathname}`);
		expect(page.status).toBe(200);
		const html = await page.text();
		const part = html.match(/<section id="reporting"[\s\S]*?<\/section>/)?.[0] ?? "";
		expect(part).toContain(`href="mailto:${SECURITY_EMAIL}"`);
	});

	it("security.txt expires within a year and is renewed a month before", async () => {
		const expires = Date.parse(Object.fromEntries(await securityTxt()).Expires);
		expect(expires).toBe(Date.parse(SECURITY_TXT_EXPIRES));

		// Less than a year after it was set (RFC 9116, 2.5.5), and set no later than today.
		const set = Date.parse(SECURITY_TXT_SET);
		expect(set).toBeLessThanOrEqual(Date.now());
		expect(expires - set).toBeLessThan(365 * DAY);
		// From 30 days before it lapses this fails, so the date is moved before it does:
		// a new SECURITY_TXT_EXPIRES and SECURITY_TXT_SET in app/routes/security-txt.ts.
		expect(
			expires - Date.now(),
			`security.txt expires on ${SECURITY_TXT_EXPIRES}: renew it`,
		).toBeGreaterThan(30 * DAY);
	});
});
