import type { Page } from "@playwright/test";

import {
	accountPath,
	destinations,
	invitationsPath,
	membersPath,
	NEW_ORGANISATION_PATH,
} from "../app/shell/destinations";

import { openAuthPage } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { expect, test } from "./fixtures";
import { homeOrganisation, homePath } from "./organisation";

// Turnstile on the page: which pages may load it, where its widget runs, and
// what it does to our document. The shared fixture fails any of these tests on a
// Content Security Policy violation or a console error, the widget's included.

const TURNSTILE = "https://challenges.cloudflare.com";

/** The Content Security Policy the server sends with a page, one directive per entry. */
async function policyOf(page: Page, path: string): Promise<string[]> {
	const response = await page.goto(path);
	expect(response?.status(), `status of ${path}`).toBe(200);
	const headers = response?.headers() ?? {};
	// The route's request to the Worker never reaches a browser.
	expect(headers).not.toHaveProperty("timesifier-policy-addition");
	return (headers["content-security-policy"] ?? "").split("; ");
}

function widgetFrames(page: Page) {
	return page.frames().filter((frame) => frame.url().startsWith(TURNSTILE));
}

test.describe("the pages that send a code", () => {
	test.use({ storageState: SIGNED_OUT });

	for (const path of ["/sign-in"]) {
		test(`${path} may load Turnstile's script and its frame, and nothing else new`, async ({
			page,
		}) => {
			const policy = await policyOf(page, path);
			const script = policy.find((directive) => directive.startsWith("script-src "));
			expect(script).toMatch(
				/^script-src 'self' 'nonce-[^']+' https:\/\/challenges\.cloudflare\.com$/,
			);
			expect(policy).toContain(`frame-src ${TURNSTILE}`);
			// Every other directive is the one every page has.
			expect(policy.filter((directive) => directive.includes(TURNSTILE))).toHaveLength(2);
			expect(policy.join("; ")).not.toContain("unsafe-inline");
			expect(policy).toContain("connect-src 'self'");
		});
	}

	test("the widget runs on the view that sends a code, and leaves our markup alone", async ({
		page,
	}) => {
		const loaded: string[] = [];
		page.on("request", (request) => {
			if (request.url().startsWith(TURNSTILE)) loaded.push(request.url());
		});

		await openAuthPage(page, "/sign-in");
		await expect.poll(() => widgetFrames(page).length).toBe(1);
		expect(loaded[0]).toBe(`${TURNSTILE}/turnstile/v0/api.js?render=explicit`);

		// What the widget added is out of the page's own markup: no style attribute,
		// no <style> element but the one React Aria adds, no frame among our elements.
		const markup = await page.evaluate(() => ({
			// React Aria leaves an empty `style=""` behind on a field it has focused.
			styled: [...document.querySelectorAll("[style]")].filter(
				(element) => element.getAttribute("style") !== "",
			).length,
			styleElements: [...document.querySelectorAll("style")].map((style) => style.id),
			frames: document.querySelectorAll("iframe").length,
			fields: document.querySelectorAll("[name='cf-turnstile-response']").length,
		}));
		expect(markup).toEqual({
			styled: 0,
			styleElements: ["react-aria-pressable-style"],
			frames: 0,
			fields: 0,
		});
	});
});

test.describe("every other page", () => {
	// Signed in, as the setup project left it: the pages under /app are served,
	// and the pages of that person's organisation are the destinations' own.
	const pages: Record<string, () => string> = {
		"/": () => "/",
		"/app/new": () => NEW_ORGANISATION_PATH,
		...Object.fromEntries(
			destinations.map(({ id, label }) => [`${label}, in an organisation`, () => homePath(id)]),
		),
		"the members of an organisation": () => membersPath(homeOrganisation().slug),
		"the invitations of an organisation": () => invitationsPath(homeOrganisation().slug),
		"My account": () => accountPath(homeOrganisation().slug),
		"/design": () => "/design",
	};
	for (const [name, path] of Object.entries(pages)) {
		test(`${name} keeps the policy it had: nothing of Turnstile's is allowed`, async ({ page }) => {
			const policy = await policyOf(page, path());
			expect(policy.join("; ")).not.toContain("cloudflare");
			expect(policy.find((directive) => directive.startsWith("script-src "))).toMatch(
				/^script-src 'self' 'nonce-[^']+'$/,
			);
			expect(policy.some((directive) => directive.startsWith("frame-src"))).toBe(false);
		});
	}
});
