import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, openGallery, test } from "./fixtures";

// axe-core's rules for WCAG 2.0, 2.1 and 2.2 at levels A and AA. No rule is
// disabled and nothing on the page is excluded.
const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** An input with nothing typed in it has no text to measure. */
const EMPTY_INPUT = "emptyValue";
/** Text of the page that an open overlay lies across. */
const UNDER_AN_OVERLAY = "bgOverlap";

/**
 * Scans the page and returns what is wrong with it, one line per element:
 * every violation, and every piece of text whose contrast axe could not measure
 * for a reason other than the ones named in `unmeasurable`. A scan that reports
 * no violations because it could not see the colours proves nothing.
 */
async function problems(page: Page, unmeasurable: string[]): Promise<string[]> {
	// A colour measured part-way through a fade is not the colour shown.
	await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
	const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();

	const violations = results.violations.flatMap((violation) =>
		violation.nodes.map(
			(node) => `${violation.id}: ${node.target.join(" ")} — ${node.failureSummary}`,
		),
	);
	const unmeasured = results.incomplete
		.filter((result) => result.id === "color-contrast")
		.flatMap((result) => result.nodes)
		.filter((node) => !unmeasurable.includes(node.any[0]?.data?.messageKey))
		.map((node) => `contrast not measured: ${node.target.join(" ")} — ${node.any[0]?.message}`);

	const measured = results.passes.find((result) => result.id === "color-contrast")?.nodes.length;
	expect(measured, "pieces of text whose contrast was measured").toBeGreaterThan(0);

	return [...violations, ...unmeasured];
}

test.beforeEach(async ({ page }) => {
	await openGallery(page);
});

test("the gallery has no accessibility violations, in the light and the dark scheme", async ({
	page,
}) => {
	// Both schemes are on the page, and every closed state of every component.
	await expect(page.getByRole("region", { name: "Light scheme" })).toBeVisible();
	await expect(page.getByRole("region", { name: "Dark scheme" })).toBeVisible();

	expect(await problems(page, [EMPTY_INPUT])).toEqual([]);
});

// Each overlay, opened the way a person opens it, in each scheme.
const OVERLAYS = [
	{ overlay: "select", trigger: "Project", role: "listbox", name: "Project" },
	{ overlay: "menu", trigger: "Entry actions", role: "menu", name: "Entry actions" },
	{ overlay: "dialog", trigger: "Delete entry", role: "alertdialog", name: "Delete this entry?" },
	{ overlay: "sheet", trigger: "Edit note", role: "dialog", name: "Edit note" },
	{ overlay: "snackbar", trigger: "Show snackbar", role: "alertdialog", name: "Entry saved" },
	{
		overlay: "snackbar with an action",
		trigger: "Show snackbar with an action",
		role: "alertdialog",
		name: "Entry deleted",
	},
] as const;

for (const scheme of ["Light scheme", "Dark scheme"] as const) {
	const colorScheme = scheme === "Light scheme" ? "light" : "dark";

	for (const { overlay, trigger, role, name } of OVERLAYS) {
		test(`the open ${overlay} has no accessibility violations in the ${colorScheme} scheme`, async ({
			page,
		}) => {
			const gallery = page.getByRole("region", { name: scheme });
			await gallery.getByRole("button", { name: trigger, exact: true }).click();

			const opened = page.getByRole(role, { name });
			await expect(opened).toBeVisible();
			// It is drawn in the scheme of the half it was opened from.
			expect(await opened.evaluate((element) => getComputedStyle(element).colorScheme)).toBe(
				colorScheme,
			);

			expect(await problems(page, [EMPTY_INPUT, UNDER_AN_OVERLAY])).toEqual([]);
		});
	}

	test(`the open tooltip has no accessibility violations in the ${colorScheme} scheme`, async ({
		page,
	}) => {
		const gallery = page.getByRole("region", { name: scheme });
		const button = gallery.getByRole("button", { name: "New entry" });
		await button.scrollIntoViewIfNeeded();
		await button.focus();
		// A tooltip shows on keyboard focus, so the focus arrives by key.
		await page.keyboard.press("Shift+Tab");
		await page.keyboard.press("Tab");

		const tooltip = page.getByRole("tooltip", { name: "Add a time entry" });
		await expect(tooltip).toBeVisible();
		expect(await tooltip.evaluate((element) => getComputedStyle(element).colorScheme)).toBe(
			colorScheme,
		);

		expect(await problems(page, [EMPTY_INPUT, UNDER_AN_OVERLAY])).toEqual([]);
	});
}

test("an overlay named in the address opens as the page loads", async ({ page }) => {
	await openGallery(page, "/design?open=dialog&scheme=dark");
	const dialog = page.getByRole("alertdialog", { name: "Delete this entry?" });
	await expect(dialog).toBeVisible();
	expect(await dialog.evaluate((element) => getComputedStyle(element).colorScheme)).toBe("dark");
});
