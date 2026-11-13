import type { Locator, Page } from "@playwright/test";

import {
	ARRIVAL,
	CONTINUE,
	codeSentBy,
	newPerson,
	openAuthPage,
	ownAddress,
	signIn,
	signOut,
	TIME_WITH_TURNS,
} from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { expect, test } from "./fixtures";
import { openAccount } from "./organisation";

// Design rule 15: everything works by keyboard, with a visible focus indicator.
// The sign-in page and My account are walked here with the
// keyboard alone: no pointer touches the page after it has loaded.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

/** The element holds the keyboard focus and shows it. */
async function expectFocusShown(element: Locator) {
	await expect(element).toBeFocused();
	const outline = await element.evaluate((focused) => {
		const { outlineStyle, outlineWidth } = getComputedStyle(focused);
		return { outlineStyle, width: Number.parseFloat(outlineWidth) };
	});
	expect(outline.outlineStyle).toBe("solid");
	expect(outline.width).toBeGreaterThan(0);
}

async function tabTo(page: Page, element: Locator) {
	await page.keyboard.press("Tab");
	await expectFocusShown(element);
}

/** The first two stops of the page: the way past the band, and the product's name in it. */
async function tabThroughTheBand(page: Page) {
	await tabTo(page, page.getByRole("link", { name: "Skip to main content" }));
	await tabTo(page, page.getByRole("banner").getByRole("link", { name: "Timesifier" }));
}

test("a new address and its code, with the keyboard alone", async ({ page }) => {
	const person = newPerson();
	await openAuthPage(page);

	// The tab order follows the page: the band, then the one field, the
	// newsletter's box (TS-099) and the action.
	await tabThroughTheBand(page);
	await page.keyboard.press("Tab");
	await expect(page.getByLabel("Email")).toBeFocused();
	await page.keyboard.type(person.email);
	await page.keyboard.press("Tab");
	await expect(page.getByRole("checkbox", { name: /newsletter/ })).toBeFocused();
	await tabTo(page, page.getByRole("button", CONTINUE));
	// After the action there is only the foot of the page.
	await tabTo(page, page.getByRole("link", { name: "Privacy notice" }));
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Shift+Tab");
	await expect(page.getByLabel("Email")).toBeFocused();

	// Enter in a field presses the view's one primary action.
	const code = await codeSentBy(() => page.keyboard.press("Enter"));

	// The new view takes the focus into its field: the code can be typed at once.
	await expect(page.getByLabel("Code")).toBeFocused();
	await page.keyboard.type(code);
	await tabTo(page, page.getByRole("button", CONTINUE));
	await tabTo(page, page.getByRole("button", { name: "Send a new code" }));
	await tabTo(page, page.getByRole("button", { name: "Use a different email" }));
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Enter");

	// The accepted code is the end of the page: the person is where they were going.
	await expect(page).toHaveURL(ARRIVAL);
});

test("an address that has an account, with the keyboard alone", async ({ page }) => {
	const person = newPerson();
	await signIn(page, person.email);
	await signOut(page);

	await openAuthPage(page);
	await tabThroughTheBand(page);
	await page.keyboard.press("Tab");
	await expect(page.getByLabel("Email")).toBeFocused();
	await page.keyboard.type(person.email);
	const code = await codeSentBy(() => page.keyboard.press("Enter"));

	await expect(page.getByLabel("Code")).toBeFocused();
	await page.keyboard.type(code);
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(ARRIVAL);
});

test("the skip link moves the focus past the band, into the main region", async ({ page }) => {
	await openAuthPage(page);
	await page.keyboard.press("Tab");
	await page.keyboard.press("Enter");

	await expect(page.getByRole("main")).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(page.getByLabel("Email")).toBeFocused();
});

test("going back a view, with the keyboard alone, returns to the field that was filled", async ({
	page,
}) => {
	const person = newPerson();
	await openAuthPage(page);
	await page.getByLabel("Email").focus();
	await page.keyboard.type(person.email);
	await codeSentBy(() => page.keyboard.press("Enter"));
	await expect(page.getByLabel("Code")).toBeFocused();

	await page.keyboard.press("Tab");
	await page.keyboard.press("Tab");
	await tabTo(page, page.getByRole("button", { name: "Use a different email" }));
	await page.keyboard.press("Enter");

	// What was typed is still there, and the focus is in the field.
	await expect(page.getByLabel("Email")).toBeFocused();
	await expect(page.getByLabel("Email")).toHaveValue(person.email);
});

test("signing out from the profile menu, with the keyboard alone", async ({ page }) => {
	await signIn(page, newPerson().email);
	await expect(page).toHaveURL(ARRIVAL);
	await openAccount(page);

	// The band, from the top of the page: the skip link, the product's name, the profile menu.
	await tabThroughTheBand(page);
	const profile = page.getByRole("banner").getByRole("button", { name: /^Account menu for / });
	await tabTo(page, profile);
	await page.keyboard.press("Space");
	await expectFocusShown(page.getByRole("menuitem", { name: "Account settings" }));
	await page.keyboard.press("ArrowDown");
	// An owner sees their own time this week between the two (TS-094).
	await expectFocusShown(page.getByRole("menuitem", { name: "My time report" }));
	await page.keyboard.press("ArrowDown");
	await expectFocusShown(page.getByRole("menuitem", { name: "Sign out" }));

	await page.keyboard.press("Enter");
	await expect(page).toHaveURL("/sign-in");
});
