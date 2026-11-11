import type { Locator, Page } from "@playwright/test";

import { expect, openGallery, test } from "./fixtures";

// Each component is found by its role and accessible name and operated with the
// keyboard alone. Nothing here clicks.

/** The light half of the gallery. Overlays opened from it render inside it. */
function gallery(page: Page): Locator {
	return page.getByRole("region", { name: "Light scheme" });
}

/**
 * Moves the keyboard focus onto the control with the Tab key: the focus is put on
 * the focusable element before it, then Tab is pressed. The control is brought to
 * the middle of the window first and the scrolling left to finish, because React
 * Aria closes a tooltip when the page scrolls.
 */
async function tabTo(page: Page, control: Locator) {
	await control.evaluate(async (element) => {
		element.scrollIntoView({ block: "center", behavior: "instant" });
		const settled = Promise.withResolvers<number>();
		requestAnimationFrame(() => requestAnimationFrame(settled.resolve));
		await settled.promise;

		const tabbable = [
			...document.querySelectorAll<HTMLElement>(
				"a[href], button, input, select, textarea, [tabindex]",
			),
		].filter(
			(candidate) =>
				candidate.tabIndex >= 0 &&
				!candidate.matches(":disabled") &&
				candidate.checkVisibility({ visibilityProperty: true }),
		);
		const before = tabbable[tabbable.indexOf(element as HTMLElement) - 1];
		if (!before) throw new Error("no focusable element comes before the control");
		before.focus({ preventScroll: true });
	});
	await page.keyboard.press("Tab");
	await expect(control).toBeFocused();
}

async function focusIsInside(container: Locator): Promise<boolean> {
	return container.evaluate((element) => element.contains(document.activeElement));
}

test.beforeEach(async ({ page }) => {
	await openGallery(page);
});

test("Button is pressed with Enter and with Space", async ({ page }) => {
	const button = gallery(page).getByRole("button", { name: "Add entry" });
	const count = gallery(page).getByText(/^Pressed \d+ times$/);

	await tabTo(page, button);
	await page.keyboard.press("Enter");
	await expect(count).toHaveText("Pressed 1 times");
	await page.keyboard.press("Space");
	await expect(count).toHaveText("Pressed 2 times");

	await expect(gallery(page).getByRole("button", { name: "Disabled" }).first()).toBeDisabled();
});

test("IconButton takes its name from its label and is pressed with Enter and with Space", async ({
	page,
}) => {
	const button = gallery(page).getByRole("button", { name: "Add one" });
	const count = gallery(page).getByText(/^Pressed \d+ times$/);

	await tabTo(page, button);
	await page.keyboard.press("Space");
	await expect(count).toHaveText("Pressed 1 times");
	await page.keyboard.press("Enter");
	await expect(count).toHaveText("Pressed 2 times");
});

test("TextField is typed into, and says when it is required or invalid", async ({ page }) => {
	const field = gallery(page).getByRole("textbox", { name: "Project name" });

	await tabTo(page, field);
	await page.keyboard.type("Atlas redesign");
	await expect(field).toHaveValue("Atlas redesign");

	const email = gallery(page).getByRole("textbox", { name: "Email" });
	await expect(email).toHaveAccessibleDescription("We send the weekly summary here.");

	// The asterisk is for the eye; the name stays "Required".
	await expect(
		gallery(page).getByRole("textbox", { name: "Required", exact: true }),
	).toHaveAttribute("required", "");

	const invalid = gallery(page).getByRole("textbox", { name: "Hourly rate" });
	await expect(invalid).toHaveAttribute("aria-invalid", "true");
	await expect(invalid).toHaveAccessibleDescription("Enter a number, such as 85.");

	await expect(gallery(page).getByRole("textbox", { name: "Disabled" })).toBeDisabled();
});

test("Checkbox is ticked and cleared with Space", async ({ page }) => {
	const checkbox = gallery(page).getByRole("checkbox", { name: "Billable" });

	await tabTo(page, checkbox);
	await expect(checkbox).not.toBeChecked();
	await page.keyboard.press("Space");
	await expect(checkbox).toBeChecked();
	await page.keyboard.press("Space");
	await expect(checkbox).not.toBeChecked();

	await expect(gallery(page).getByRole("checkbox", { name: "All projects" })).toBeChecked({
		indeterminate: true,
	});
	await expect(
		gallery(page).getByRole("checkbox", { name: "Disabled", exact: true }),
	).toBeDisabled();
});

test("Switch is turned on and off with Space", async ({ page }) => {
	const toggle = gallery(page).getByRole("switch", { name: "Weekly summary" });

	await tabTo(page, toggle);
	await expect(toggle).not.toBeChecked();
	await page.keyboard.press("Space");
	await expect(toggle).toBeChecked();
	await page.keyboard.press("Space");
	await expect(toggle).not.toBeChecked();

	await expect(gallery(page).getByRole("switch", { name: "Disabled off" })).toBeDisabled();
});

test("RadioGroup is entered at its chosen radio and the arrow keys move the choice", async ({
	page,
}) => {
	const group = gallery(page).getByRole("radiogroup", { name: "Week starts on" });
	const monday = group.getByRole("radio", { name: "Monday" });
	const sunday = group.getByRole("radio", { name: "Sunday" });

	await tabTo(page, monday);
	await expect(monday).toBeChecked();
	await page.keyboard.press("ArrowDown");
	await expect(sunday).toBeFocused();
	await expect(sunday).toBeChecked();
	await expect(monday).not.toBeChecked();
	await page.keyboard.press("ArrowUp");
	await expect(monday).toBeChecked();

	// Tab leaves the group: it is one stop, not three.
	await page.keyboard.press("Tab");
	await expect(group.getByRole("radio", { name: "Saturday" })).not.toBeFocused();
	expect(await focusIsInside(group)).toBe(false);

	await expect(
		gallery(page).getByRole("radio", { name: "Disabled choice", exact: true }),
	).toBeDisabled();
});

test("Select opens, moves by arrow key and by typing, chooses with Enter and closes with Escape", async ({
	page,
}) => {
	const select = gallery(page).getByRole("button", { name: "Project", exact: true });
	const list = page.getByRole("listbox", { name: "Project" });

	await tabTo(page, select);
	await page.keyboard.press("Enter");
	await expect(list).toBeVisible();
	await expect(list.getByRole("option", { name: "Atlas" })).toBeFocused();

	await page.keyboard.press("ArrowDown");
	await expect(list.getByRole("option", { name: "Borealis" })).toBeFocused();
	await page.keyboard.type("c");
	await expect(list.getByRole("option", { name: "Cascade" })).toBeFocused();
	// The disabled option is skipped.
	await page.keyboard.press("End");
	await expect(list.getByRole("option", { name: "Cascade" })).toBeFocused();
	await expect(list.getByRole("option", { name: "Delta" })).toHaveAttribute(
		"aria-disabled",
		"true",
	);

	await page.keyboard.press("Enter");
	await expect(list).toBeHidden();
	const chosen = gallery(page).getByRole("button", { name: "Cascade Project" });
	await expect(chosen).toBeFocused();

	// Escape closes the list and keeps the choice.
	await page.keyboard.press("ArrowDown");
	await expect(list).toBeVisible();
	await page.keyboard.press("ArrowUp");
	await page.keyboard.press("Escape");
	await expect(list).toBeHidden();
	await expect(chosen).toBeFocused();
});

test("Menu opens from its button, moves by arrow key and by typing, and acts on Enter", async ({
	page,
}) => {
	const trigger = gallery(page).getByRole("button", { name: "Entry actions" });
	const menu = page.getByRole("menu", { name: "Entry actions" });

	await tabTo(page, trigger);
	await page.keyboard.press("Enter");
	await expect(menu).toBeVisible();
	await expect(menu.getByRole("menuitem", { name: "Edit" })).toBeFocused();

	await page.keyboard.press("ArrowDown");
	await expect(menu.getByRole("menuitem", { name: "Duplicate" })).toBeFocused();
	await page.keyboard.type("m");
	await expect(menu.getByRole("menuitem", { name: "Move to project" })).toBeFocused();
	await expect(menu.getByRole("menuitem", { name: "Delete" })).toHaveAttribute(
		"aria-disabled",
		"true",
	);

	await page.keyboard.press("Enter");
	await expect(menu).toBeHidden();
	await expect(gallery(page).getByText("Chose move")).toBeVisible();
	await expect(trigger).toBeFocused();

	// Escape closes the menu without acting.
	await page.keyboard.press("ArrowDown");
	await expect(menu).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(menu).toBeHidden();
	await expect(trigger).toBeFocused();
	await expect(gallery(page).getByText("Chose move")).toBeVisible();
});

test("Dialog takes the focus, keeps it inside, and returns it to the button on Escape", async ({
	page,
}) => {
	const trigger = gallery(page).getByRole("button", { name: "Delete entry" });
	const dialog = page.getByRole("alertdialog", { name: "Delete this entry?" });

	await tabTo(page, trigger);
	await page.keyboard.press("Enter");
	await expect(dialog).toBeVisible();
	await expect.poll(() => focusIsInside(dialog)).toBe(true);

	// Two buttons inside: Tab goes round them and never leaves.
	const visited = new Set<string>();
	for (let presses = 0; presses < 6; presses++) {
		await page.keyboard.press("Tab");
		expect(await focusIsInside(dialog)).toBe(true);
		visited.add(await page.evaluate(() => document.activeElement?.textContent ?? ""));
	}
	expect([...visited].sort()).toEqual(["Cancel", "Delete"]);
	await page.keyboard.press("Shift+Tab");
	expect(await focusIsInside(dialog)).toBe(true);

	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await expect(trigger).toBeFocused();
});

test("Sheet is a modal dialog: it takes the focus, keeps it inside, and returns it when closed", async ({
	page,
}) => {
	const trigger = gallery(page).getByRole("button", { name: "Edit note" });
	const sheet = page.getByRole("dialog", { name: "Edit note" });

	await tabTo(page, trigger);
	await page.keyboard.press("Space");
	await expect(sheet).toBeVisible();
	await expect.poll(() => focusIsInside(sheet)).toBe(true);

	// It sits at the bottom edge of the window, over the view that opened it.
	await expect
		.poll(() =>
			sheet.evaluate(
				(element) => window.innerHeight - Math.round(element.getBoundingClientRect().bottom),
			),
		)
		.toBe(0);

	for (let presses = 0; presses < 6; presses++) {
		await page.keyboard.press("Tab");
		expect(await focusIsInside(sheet)).toBe(true);
	}

	// Closed with its own button, by keyboard.
	await tabTo(page, sheet.getByRole("button", { name: "Cancel" }));
	await page.keyboard.press("Enter");
	await expect(sheet).toBeHidden();
	await expect(trigger).toBeFocused();

	// And with Escape.
	await page.keyboard.press("Enter");
	await expect(sheet).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(sheet).toBeHidden();
	await expect(trigger).toBeFocused();
});

test("Tabs move with the arrow keys, Home and End, and Tab goes into the panel", async ({
	page,
}) => {
	const tabs = gallery(page).getByRole("tablist", { name: "Report period" });
	const week = tabs.getByRole("tab", { name: "Week" });
	const month = tabs.getByRole("tab", { name: "Month" });
	const day = tabs.getByRole("tab", { name: "Day" });

	await tabTo(page, week);
	await expect(week).toHaveAttribute("aria-selected", "true");
	await expect(gallery(page).getByRole("tabpanel", { name: "Week" })).toContainText("This week");

	await page.keyboard.press("ArrowRight");
	await expect(month).toBeFocused();
	await expect(month).toHaveAttribute("aria-selected", "true");
	await expect(gallery(page).getByRole("tabpanel", { name: "Month" })).toContainText("This month");

	await page.keyboard.press("Home");
	await expect(day).toHaveAttribute("aria-selected", "true");
	// The last tab is disabled, so End stops at the one before it.
	await page.keyboard.press("End");
	await expect(month).toHaveAttribute("aria-selected", "true");
	await expect(tabs.getByRole("tab", { name: "Year" })).toHaveAttribute("aria-disabled", "true");

	await page.keyboard.press("Tab");
	await expect(gallery(page).getByRole("tabpanel", { name: "Month" })).toBeFocused();
});

test("Snackbar appears as a polite status, leaves the focus where it was, and is dismissed by keyboard", async ({
	page,
}) => {
	const trigger = gallery(page).getByRole("button", { name: "Show snackbar", exact: true });
	const status = page.getByRole("status").filter({ hasText: "Entry saved" });

	await tabTo(page, trigger);
	await page.keyboard.press("Enter");
	await expect(status).toBeVisible();
	await expect(status).toHaveAttribute("aria-atomic", "true");
	await expect(trigger).toBeFocused();

	// F6 moves to the notifications landmark; the snackbar's Dismiss button is inside it.
	const region = page.getByRole("region", { name: /notification/i });
	await page.keyboard.press("F6");
	await expect.poll(() => focusIsInside(region)).toBe(true);
	await tabTo(page, region.getByRole("button", { name: "Dismiss" }));
	await page.keyboard.press("Enter");
	await expect(status).toBeHidden();
});

test("Snackbar offers one action, which runs and closes it", async ({ page }) => {
	const trigger = gallery(page).getByRole("button", { name: "Show snackbar with an action" });

	await tabTo(page, trigger);
	await page.keyboard.press("Enter");
	const snackbar = page.getByRole("alertdialog", { name: "Entry deleted" });
	await expect(snackbar).toBeVisible();
	await expect(trigger).toBeFocused();

	await page.keyboard.press("F6");
	await tabTo(page, snackbar.getByRole("button", { name: "Undo" }));
	await page.keyboard.press("Enter");
	await expect(gallery(page).getByText("Undid the deletion")).toBeVisible();
	await expect(snackbar).toBeHidden();
});

test("Tooltip shows on keyboard focus and on hover, describes its control, and hides on Escape", async ({
	page,
}) => {
	const button = gallery(page).getByRole("button", { name: "New entry" });
	const tooltip = page.getByRole("tooltip").filter({ hasText: "Add a time entry" });

	await tabTo(page, button);
	await expect(tooltip).toBeVisible();
	await expect(button).toHaveAccessibleDescription("Add a time entry");
	await page.keyboard.press("Escape");
	await expect(tooltip).toBeHidden();

	// The one use of the pointer in this file: the tooltip is also for people who hover.
	// The pointer moves before it arrives, as a hand on a mouse does.
	await page.keyboard.press("Tab");
	await page.mouse.move(1, 1);
	await button.hover();
	await expect(tooltip).toBeVisible();
});

test("Digits is read as one time, is not announced as it changes, and redraws only the digit that changed", async ({
	page,
}) => {
	const timer = gallery(page).getByRole("timer");
	// What is drawn. The same time is there once more, whole, for a screen reader.
	const shown = timer.locator('[aria-hidden="true"]');
	const add = gallery(page).getByRole("button", { name: "Add a second" });
	await expect(shown).toHaveText("0:59:58");
	await expect(timer).toHaveAccessibleName(/./);
	// Nothing reads a timer out every second.
	expect(await timer.evaluate((element) => element.closest("[aria-live]"))).toBeNull();

	// Each digit on the page is marked, so that one drawn again is told from one that stayed.
	const mark = () =>
		timer.evaluate((element) => {
			for (const digit of element.querySelectorAll("[aria-hidden] > span")) {
				digit.setAttribute("data-seen", "");
			}
		});
	const drawnAgain = () =>
		timer.evaluate((element) =>
			[...element.querySelectorAll("[aria-hidden] > span")]
				.filter((digit) => !digit.hasAttribute("data-seen"))
				.map((digit) => digit.textContent),
		);

	await mark();
	await tabTo(page, add);
	await page.keyboard.press("Enter");
	await expect(shown).toHaveText("0:59:59");
	expect(await drawnAgain()).toEqual(["9"]);

	// On the hour every digit but the first turns over.
	await mark();
	await page.keyboard.press("Enter");
	await expect(shown).toHaveText("1:00:00");
	expect(await drawnAgain()).toEqual(["1", "0", "0", "0", "0"]);
});

test("Ledger is a list of rows under a heading: a row is read as its title, its detail and its figure", async ({
	page,
}) => {
	const rows = gallery(page).getByRole("listitem").filter({ hasText: "Receipts" });

	await expect(rows).toHaveCount(1);
	await expect(rows).toContainText("Admin");
	await expect(rows).toContainText("0:35");
	// The total is on the sheet, after its rows.
	const total = gallery(page).getByText("1:50", { exact: true });
	await expect(total).toBeVisible();
	expect(
		await total.evaluate(
			(element, row) =>
				Boolean(row && element.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_PRECEDING),
			await rows.elementHandle(),
		),
	).toBe(true);
});
