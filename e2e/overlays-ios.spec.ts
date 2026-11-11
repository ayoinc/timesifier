import type { Page } from "@playwright/test";

import { expect, openGallery, test } from "./fixtures";

// On iOS, React Aria stops the page scrolling behind an overlay by inserting a
// <style> element (`overscroll-behavior: contain`) while the overlay is open.
// The Content Security Policy allows that element by its hash. These tests open
// and close each overlay in WebKit and fail, through the shared fixture, if the
// policy blocks anything.
//
// The library takes that path when `navigator.platform` starts with "iPhone".
// Playwright's iPhone gives WebKit an iPhone's screen, touch and user agent but
// leaves `navigator.platform` as the host's, so the tests set it.

test.beforeEach(async ({ page }, testInfo) => {
	testInfo.annotations.push({
		type: "navigator.platform before the tests set it",
		description: await page.evaluate(() => navigator.platform),
	});
	await page.addInitScript(() => {
		Object.defineProperty(Navigator.prototype, "platform", { get: () => "iPhone" });
	});
	await openGallery(page);
	// What React Aria's own test for iOS WebKit reads.
	expect(
		await page.evaluate(
			() => /^iPhone/i.test(navigator.platform) && /AppleWebKit/i.test(navigator.userAgent),
		),
	).toBe(true);
});

/** The number of rules in each scroll-lock <style> element in the page: [1] while locked, [] when not. */
async function scrollLock(page: Page): Promise<number[]> {
	return page.evaluate(() =>
		[...document.head.querySelectorAll("style")]
			.filter((style) => style.textContent?.includes("overscroll-behavior"))
			// A <style> the policy blocked has no sheet.
			.map((style) => style.sheet?.cssRules.length ?? 0),
	);
}

function gallery(page: Page) {
	return page.getByRole("region", { name: "Light scheme" });
}

test("Dialog opens and closes on iOS with the scroll lock in place", async ({ page }) => {
	await gallery(page).getByRole("button", { name: "Delete entry" }).tap();
	const dialog = page.getByRole("alertdialog", { name: "Delete this entry?" });
	await expect(dialog).toBeVisible();
	expect(await scrollLock(page)).toEqual([1]);

	await dialog.getByRole("button", { name: "Cancel" }).tap();
	await expect(dialog).toBeHidden();
	expect(await scrollLock(page)).toEqual([]);
});

test("Sheet opens and closes on iOS with the scroll lock in place", async ({ page }) => {
	await gallery(page).getByRole("button", { name: "Edit note" }).tap();
	const sheet = page.getByRole("dialog", { name: "Edit note" });
	await expect(sheet).toBeVisible();
	expect(await scrollLock(page)).toEqual([1]);

	await sheet.getByRole("button", { name: "Save note" }).tap();
	await expect(sheet).toBeHidden();
	expect(await scrollLock(page)).toEqual([]);
});

test("Select opens and closes on iOS with the scroll lock in place", async ({ page }) => {
	await gallery(page).getByRole("button", { name: "Project", exact: true }).tap();
	const list = page.getByRole("listbox", { name: "Project" });
	await expect(list).toBeVisible();
	expect(await scrollLock(page)).toEqual([1]);

	await list.getByRole("option", { name: "Cascade" }).tap();
	await expect(list).toBeHidden();
	await expect(gallery(page).getByRole("button", { name: "Cascade Project" })).toBeVisible();
	expect(await scrollLock(page)).toEqual([]);
});

test("Menu opens and closes on iOS with the scroll lock in place", async ({ page }) => {
	await gallery(page).getByRole("button", { name: "Entry actions" }).tap();
	const menu = page.getByRole("menu", { name: "Entry actions" });
	await expect(menu).toBeVisible();
	expect(await scrollLock(page)).toEqual([1]);

	await menu.getByRole("menuitem", { name: "Duplicate" }).tap();
	await expect(menu).toBeHidden();
	await expect(gallery(page).getByText("Chose duplicate")).toBeVisible();
	expect(await scrollLock(page)).toEqual([]);
});
