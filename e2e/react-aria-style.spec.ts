import type { Page } from "@playwright/test";

import { expect, openGallery, test } from "./fixtures";

// Audit W19: a WebKit console showed "Refused to apply a stylesheet because its
// hash, its nonce, or 'unsafe-inline' does not appear in the style-src
// directive" on every page. The policy allows React Aria's pressable <style> by
// its hash (docs/security.md, "The two hashes"), and WebKit applies it: the
// refused stylesheet was the one Playwright inserts to take a screenshot. These
// tests run in WebKit only, at a desktop's size and on an iPhone, and never
// take a screenshot. They fail, through the shared fixture, on any policy
// violation or console error, and here on a style React Aria inserted that the
// page did not apply.

const PRESSABLE_STYLE = "#react-aria-pressable-style";

/** React Aria's pressable <style> is in the page and applied: a blocked one has no sheet. */
async function expectPressableStyleApplied(page: Page) {
	await expect(page.locator(PRESSABLE_STYLE)).toBeAttached();
	expect(
		await page.evaluate(
			(selector) =>
				(document.querySelector(selector) as HTMLStyleElement | null)?.sheet?.cssRules.length ?? 0,
			PRESSABLE_STYLE,
		),
	).toBe(1);
	// What the rule does: a pressable element does not wait for a double tap.
	expect(
		await page.evaluate(() => {
			const pressable = document.querySelector("[data-react-aria-pressable]");
			return pressable ? getComputedStyle(pressable).touchAction : null;
		}),
	).toBe("pan-x pan-y pinch-zoom");
}

test("the component gallery: React Aria's pressable style is applied, and pressing raises no violation", async ({
	page,
}) => {
	await openGallery(page);
	await expectPressableStyleApplied(page);
	const gallery = page.getByRole("region", { name: "Light scheme" });
	await gallery.getByRole("button", { name: "Add entry" }).click();
	await gallery.getByRole("button", { name: "Add one" }).click();
});

test("the sign-in page: React Aria's pressable style is applied", async ({ page }) => {
	await page.goto("/sign-in");
	await expectPressableStyleApplied(page);
});
