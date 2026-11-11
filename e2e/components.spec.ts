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
	// Safari's Tab passes links by; Option-Tab stops on them, as a Safari user presses.
	const isLink = await control.evaluate((element) => element.matches("a[href]"));
	const webkit = page.context().browser()?.browserType().name() === "webkit";
	await page.keyboard.press(isLink && webkit ? "Alt+Tab" : "Tab");
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

	// From 600px it sits in the middle of the window, clear of the bottom edge
	// (the W32 tests below hold its place at 390px and at 1280px).
	await expect
		.poll(() =>
			sheet.evaluate(
				(element) => window.innerHeight - Math.round(element.getBoundingClientRect().bottom),
			),
		)
		.toBeGreaterThanOrEqual(24);

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

/** The size each element is drawn at, with what it shows for a name. */
async function boxes(targets: Locator) {
	return targets.evaluateAll((elements) =>
		elements
			.filter((element) => element.checkVisibility())
			.map((element) => {
				const box = element.getBoundingClientRect();
				return {
					name: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "",
					width: box.width,
					height: box.height,
				};
			}),
	);
}

test("W10: at 390px every button, icon button and standalone link is at least 44 by 44px", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await openGallery(page);
	const half = gallery(page);
	// A link inside a sentence is exempt (WCAG 2.5.8); every other link stands on its own.
	const targets = half.locator("button, a[href]:not(p a), [role=link]");
	const small = (await boxes(targets)).filter((box) => box.width < 44 || box.height < 44);
	expect(small).toEqual([]);
});

test("FilterField applies after typing stops and on Enter, and Clear empties it and applies", async ({
	page,
}) => {
	const field = gallery(page).getByRole("searchbox", { name: "Search projects or clients" });

	await tabTo(page, field);
	await page.keyboard.type("atlas");
	await expect(page).toHaveURL(/[?&]q=atlas(&|$)/);
	await expect(gallery(page).getByText("Applied: “atlas”")).toBeVisible();

	await page.keyboard.type(" north");
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/[?&]q=atlas(\+|%20)north(&|$)/);
	await expect(field).toBeFocused();

	const clear = gallery(page).getByRole("button", { name: "Clear search" });
	await tabTo(page, clear);
	await page.keyboard.press("Enter");
	await expect(field).toHaveValue("");
	await expect(page).not.toHaveURL(/[?&]q=/);
	await expect(clear).toBeHidden();

	// The field follows the address: opened with a search, it shows it.
	await page.goto("/design?q=borealis");
	await expect(field).toHaveValue("borealis");
});

test("PeriodStepper steps by keyboard and names each arrow by its step", async ({ page }) => {
	const stepper = gallery(page).getByRole("group", { name: "Weeks, light" });
	await expect(stepper).toContainText("9–15 November 2026");
	await expect(stepper.getByRole("link", { name: "This week" })).toHaveCount(0);

	await tabTo(page, stepper.getByRole("link", { name: "Next week" }));
	await page.keyboard.press("Enter");
	await expect(stepper).toContainText("16–22 November 2026");
	await expect(stepper.getByRole("link", { name: "No later period" })).toHaveAttribute(
		"aria-disabled",
		"true",
	);

	const back = stepper.getByRole("link", { name: "This week" });
	await tabTo(page, back);
	await page.keyboard.press("Enter");
	await expect(stepper).toContainText("9–15 November 2026");

	await tabTo(page, stepper.getByRole("link", { name: "Previous week" }));
	await page.keyboard.press("Enter");
	await expect(stepper).toContainText("2–8 November 2026");

	// One row at 390px, with the way back to this week on it.
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(back).toBeVisible();
	const height = await stepper.evaluate((element) => element.getBoundingClientRect().height);
	expect(height).toBeLessThanOrEqual(48);
});

for (const [width, place] of [
	[1280, "centred"],
	[390, "bottom"],
] as const) {
	test(`W32: at ${width}px the sheet sits ${place === "centred" ? "in the middle, clear of every edge" : "along the bottom"}`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 800 });
		await openGallery(page, "/design?open=sheet&scheme=light");
		const sheet = gallery(page).getByRole("dialog", { name: "Edit note" });
		await expect(sheet).toBeVisible();
		await page.waitForFunction(() => document.getAnimations().length === 0);
		const box = await sheet.evaluate((element) => {
			const panel = element.parentElement as HTMLElement;
			const rect = panel.getBoundingClientRect();
			return {
				left: rect.left,
				right: rect.right,
				top: rect.top,
				bottom: rect.bottom,
				radius: getComputedStyle(panel).borderBottomLeftRadius,
			};
		});
		if (place === "centred") {
			expect(800 - box.bottom).toBeGreaterThanOrEqual(24);
			expect(Math.abs(box.top - (800 - box.bottom))).toBeLessThanOrEqual(1);
			expect(Math.abs(box.left - (width - box.right))).toBeLessThanOrEqual(1);
			expect(box.right - box.left).toBeLessThanOrEqual(560);
			expect(box.radius).not.toBe("0px");
		} else {
			expect(Math.abs(800 - box.bottom)).toBeLessThanOrEqual(1);
			expect(box.radius).toBe("0px");
		}
	});
}

test("W27: a danger button is drawn in the error colour", async ({ page }) => {
	const danger = gallery(page).getByRole("button", { name: "Save", exact: true }).nth(4);
	const error = await gallery(page).evaluate((element) => {
		// The theme's colours are inlined into the utilities, so the probe reads the
		// Material tokens, mixed as the state layer mixes them so both read alike.
		const probe = document.createElement("span");
		probe.style.backgroundColor = "color-mix(in srgb, currentColor 0%, var(--md-sys-color-error))";
		probe.style.color = "var(--md-sys-color-on-error)";
		element.append(probe);
		const { backgroundColor, color } = getComputedStyle(probe);
		probe.remove();
		return { backgroundColor, color };
	});
	const drawn = await danger.evaluate((element) => {
		const { backgroundColor, color } = getComputedStyle(element);
		return { backgroundColor, color };
	});
	expect(drawn).toEqual(error);
	const disabled = gallery(page).getByRole("button", { name: "Disabled", exact: true }).nth(4);
	await expect(disabled).toBeDisabled();
	expect(await disabled.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
		error.backgroundColor,
	);
});

test("W20: Tabs and LinkTabs draw the same row and the same indicator", async ({ page }) => {
	const geometry = (selected: Locator) =>
		selected.evaluate((tab) => {
			const row = tab.parentElement as HTMLElement;
			const indicator = [...tab.querySelectorAll<HTMLElement>("*")].find(
				(child) => getComputedStyle(child).position === "absolute",
			) as HTMLElement;
			const tabBox = tab.getBoundingClientRect();
			const mark = indicator.getBoundingClientRect();
			return {
				tabHeight: tabBox.height,
				insetStart: mark.left - tabBox.left,
				insetEnd: tabBox.right - mark.right,
				indicatorHeight: mark.height,
				gapBelow: tabBox.bottom - mark.bottom,
				divider: getComputedStyle(row).borderBottomWidth,
				font: getComputedStyle(tab).font,
				color: getComputedStyle(tab).color,
			};
		});
	const links = await geometry(
		gallery(page).getByRole("group", { name: "Gallery views" }).getByRole("link", { name: "Week" }),
	);
	expect(links.indicatorHeight).toBe(3);
	expect(links.insetStart).toBe(16);
	// React Aria's indicator slides into place on a transition: wait for it to land.
	const tab = gallery(page)
		.getByRole("tablist", { name: "Report period" })
		.getByRole("tab", { name: "Week" });
	await expect.poll(() => geometry(tab)).toEqual(links);
});
