import { test as base, expect, type Page } from "@playwright/test";

type PolicyViolation = { directive: string; blocked: string; sample: string };

declare global {
	interface Window {
		__reportPolicyViolation?: (violation: PolicyViolation) => void;
	}
}

/**
 * Every browser test imports `test` from here. A test fails when its page raises a
 * `securitypolicyviolation` event, logs a console error or throws: a page that
 * works but breaks the Content Security Policy is a failing page.
 */
export const test = base.extend<{ pageHealth: undefined }>({
	pageHealth: [
		async ({ page }, use) => {
			const violations: PolicyViolation[] = [];
			const errors: string[] = [];

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
				if (message.type() === "error") errors.push(message.text());
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

export { expect };
