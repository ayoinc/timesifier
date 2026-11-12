import type { Page } from "@playwright/test";

import { expect, openGallery, test } from "./fixtures";
import { movement, watchForMovement } from "./motion";

// Design rule 9: with reduced motion requested, movement and scaling are replaced
// by a fade or nothing. This drives every component through its changes while a
// watcher looks, on every frame, for anything that animates position or size.

/** Takes every component through each change it can make: open and close, toggle, select, type, press. */
async function operateEveryComponent(page: Page) {
	const gallery = page.getByRole("region", { name: "Light scheme" });

	// Button and IconButton: pressing changes the shape and the state layer.
	await gallery.getByRole("button", { name: "Add entry" }).click();
	await gallery.getByRole("button", { name: "Add one" }).click();

	// TextField: the label floats when the field takes focus.
	const field = gallery.getByRole("textbox", { name: "Project name" });
	await field.click();
	await field.fill("Atlas");
	await field.blur();

	// Checkbox and Switch, pressed on their labels as a pointer does.
	const checkbox = gallery.getByRole("checkbox", { name: "Billable" });
	await gallery.getByText("Billable", { exact: true }).click();
	await expect(checkbox).toBeChecked();
	await gallery.getByText("Billable", { exact: true }).click();
	await expect(checkbox).not.toBeChecked();
	const toggle = gallery.getByRole("switch", { name: "Weekly summary" });
	await gallery.getByText("Weekly summary", { exact: true }).click();
	await expect(toggle).toBeChecked();
	await gallery.getByText("Weekly summary", { exact: true }).click();
	await expect(toggle).not.toBeChecked();

	// RadioGroup: the dot leaves one ring and arrives in another.
	await gallery.getByText("Sunday", { exact: true }).click();
	await expect(gallery.getByRole("radio", { name: "Sunday" })).toBeChecked();

	// Select: open, choose, open again, leave.
	await gallery.getByRole("button", { name: "Project", exact: true }).click();
	await page.getByRole("option", { name: "Borealis" }).click();
	await expect(page.getByRole("listbox")).toBeHidden();
	await gallery.getByRole("button", { name: "Borealis Project" }).click();
	await expect(page.getByRole("listbox")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("listbox")).toBeHidden();

	// Menu.
	await gallery.getByRole("button", { name: "Entry actions" }).click();
	await page.getByRole("menuitem", { name: "Duplicate" }).click();
	await expect(page.getByRole("menu")).toBeHidden();

	// Dialog.
	await gallery.getByRole("button", { name: "Delete entry" }).click();
	const dialog = page.getByRole("alertdialog", { name: "Delete this entry?" });
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toBeHidden();

	// Sheet.
	await gallery.getByRole("button", { name: "Edit note" }).click();
	const sheet = page.getByRole("dialog", { name: "Edit note" });
	await expect(sheet).toBeVisible();
	await sheet.getByRole("button", { name: "Cancel" }).click();
	await expect(sheet).toBeHidden();

	// Tabs: the indicator goes from one tab to another.
	const tabs = gallery.getByRole("tablist", { name: "Report period" });
	await tabs.getByRole("tab", { name: "Month" }).click();
	await tabs.getByRole("tab", { name: "Day" }).click();

	// Snackbar: in, then out.
	await gallery.getByRole("button", { name: "Show snackbar", exact: true }).click();
	const snackbar = page.getByRole("alertdialog", { name: "Entry saved" });
	await expect(snackbar).toBeVisible();
	await snackbar.getByRole("button", { name: "Dismiss" }).click();
	await expect(snackbar).toBeHidden();

	// Tooltip: in on focus, out on Escape.
	await gallery.getByRole("button", { name: "New entry" }).focus();
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Tab");
	await expect(page.getByRole("tooltip")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("tooltip")).toBeHidden();
}

test.describe("with reduced motion requested", () => {
	test.use({ reducedMotion: "reduce" });

	test("no component animates position or scale", async ({ page }) => {
		await watchForMovement(page);
		await openGallery(page);
		expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
			true,
		);

		await operateEveryComponent(page);

		expect(await movement(page)).toEqual([]);
	});
});

test.describe("with motion allowed", () => {
	test.use({ reducedMotion: "no-preference" });

	// The same steps and the same watcher. This is what shows the test above can fail.
	test("the watcher sees each component's movement", async ({ page }) => {
		await watchForMovement(page);
		await openGallery(page);

		await operateEveryComponent(page);

		const seen = await movement(page);
		for (const moved of [
			/^transition of scale on <div> "Edit note/, // from 600px the sheet grows in the middle
			/^transition of scale on <div> "Delete this entry\?/, // the dialog grows
			/^transition of scale on <div role=dialog> "AtlasBorealis/, // the select's list grows
			/^transition of scale on <div role=dialog> "EditDuplicate/, // the menu grows
			/^transition of scale on <div role=tooltip> "Add a time entry"/,
			/^transition of translate on <div role=alertdialog> "Entry saved"/, // the snackbar rises
			/^transition of translate on <div> in "(Day|Week|Month)"/, // the tab indicator slides
			/^transition of translate on <span> in "Weekly summary"/, // the switch handle travels
			/^transition of scale on <span> in "Billable"/, // the tick grows
			/^transition of scale on <span> in "Sunday"/, // the radio's dot grows
			/^transition of top on <label> "Project name"/, // the field's label floats
		]) {
			expect(seen).toContainEqual(expect.stringMatching(moved));
		}
	});
});
