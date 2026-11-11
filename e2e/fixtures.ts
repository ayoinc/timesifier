import { test as base, expect, type Page } from "@playwright/test";

type PolicyViolation = { directive: string; blocked: string; sample: string };

declare global {
	interface Window {
		__reportPolicyViolation?: (violation: PolicyViolation) => void;
	}
}

/**
 * Requests the server is meant to refuse: the statuses expected, by the path
 * they are answered on. An object, not a list: Playwright reads a list given
 * to `test.use` as a value with its options.
 */
export type Refusals = Record<string, number[]>;

/**
 * Every browser test imports `test` from here. A test fails when its page raises a
 * `securitypolicyviolation` event, logs a console error or throws: a page that
 * works but breaks the Content Security Policy is a failing page.
 *
 * Chromium logs a console error for every response with a status of 400 or
 * above. A test that makes the server refuse a request on purpose names the
 * refusal with `test.use({ refusals: { "/path": [403] } })`; any other error
 * still fails it.
 */
export const test = base.extend<{ pageHealth: undefined; refusals: Refusals }>({
	refusals: [{}, { option: true }],
	pageHealth: [
		async ({ page, refusals }, use) => {
			const violations: PolicyViolation[] = [];
			const errors: string[] = [];
			const meant = (text: string, url: string) =>
				(refusals[URL.parse(url)?.pathname ?? ""] ?? []).some((status) =>
					text.startsWith(
						`Failed to load resource: the server responded with a status of ${status} `,
					),
				);

			await page.exposeFunction("__reportPolicyViolation", (violation: PolicyViolation) => {
				violations.push(violation);
			});
			// Runs before any script of the page, so nothing is missed during hydration.
			await page.addInitScript(() => {
				document.addEventListener("securitypolicyviolation", (event) => {
					window.__reportPolicyViolation?.({
						directive: event.effectiveDirective,
						blocked: event.blockedURI,
						sample: event.sample,
					});
				});
			});
			page.on("console", (message) => {
				if (message.type() !== "error") return;
				if (!meant(message.text(), message.location().url)) errors.push(message.text());
			});
			page.on("pageerror", (error) => errors.push(`uncaught: ${error.message}`));

			await use(undefined);

			expect(violations, "Content Security Policy violations").toEqual([]);
			expect(errors, "console errors").toEqual([]);
		},
		{ auto: true },
	],
});

/**
 * Opens the component gallery and waits until React has taken over the page.
 * The sign is the <style> element React Aria adds from an effect; the markup the
 * server sends looks ready before that, and its controls do not yet respond.
 */
export async function openGallery(page: Page, path = "/design") {
	await page.goto(path);
	await expect(page.locator("#react-aria-pressable-style")).toBeAttached();
}

/**
 * Opens a page whose links React Router handles and waits until React has taken
 * over the page. Before that a press on a link is an ordinary one: the browser
 * loads the next page whole, with no transition and no move of the focus. The
 * sign is the record React keeps on each element it has hydrated, read from the
 * first link in `within`; nothing a person can see changes at that moment.
 */
export async function openShell(page: Page, path: string, within = "nav") {
	await page.goto(path);
	await page.waitForFunction((container) => {
		const link = document.querySelector(`${container} a`);
		return link !== null && Object.keys(link).some((key) => key.startsWith("__reactFiber"));
	}, within);
}

export { expect };
