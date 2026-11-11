import { EMPTY_INPUT, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openGallery, test } from "./fixtures";

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
