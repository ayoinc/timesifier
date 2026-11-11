import type { Locator, Page } from "@playwright/test";

import {
	ARRIVAL,
	codeSentBy,
	newPerson,
	openAuthPage,
	ownAddress,
	signOut,
	signUp,
	TIME_WITH_TURNS,
} from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { expect, test } from "./fixtures";
import { openSettings } from "./organisation";

// Design rule 15: everything works by keyboard, with a visible focus indicator.
// Both pages and the account part of Settings are walked here with the keyboard
// alone: no pointer touches the page after it has loaded.

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

test("signing up and the code, with the keyboard alone", async ({ page }) => {
	const person = newPerson();
	await openAuthPage(page, "/sign-up");

	// The tab order follows the page: the name of the product, then the fields.
	await tabTo(page, page.getByRole("link", { name: "Timesifier" }));
	await page.keyboard.press("Tab");
	await expect(page.getByLabel("Name")).toBeFocused();
	await page.keyboard.type(person.name);
	await page.keyboard.press("Tab");
	await expect(page.getByLabel("Email")).toBeFocused();
	await page.keyboard.type(person.email);

	// Enter in a field presses the step's one primary action.
	const code = await codeSentBy(() => page.keyboard.press("Enter"));

	// The new step takes the focus into its field: the code can be typed at once.
	await expect(page.getByLabel("Code")).toBeFocused();
	await page.keyboard.type(code);
	await tabTo(page, page.getByRole("button", { name: "Create account" }));
	await tabTo(page, page.getByRole("button", { name: "Send a new code" }));
	await tabTo(page, page.getByRole("button", { name: "Use a different email" }));
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Enter");

	// The accepted code is the end of the page: the person is where they were going.
	await expect(page).toHaveURL(ARRIVAL);
});

test("signing in with an email code, with the keyboard alone", async ({ page }) => {
	const person = newPerson();
	await signUp(page, person);
	await signOut(page);

	await openAuthPage(page, "/sign-in");
	await tabTo(page, page.getByRole("link", { name: "Timesifier" }));
	await page.keyboard.press("Tab");
	await expect(page.getByLabel("Email")).toBeFocused();
	await page.keyboard.type(person.email);
	await tabTo(page, page.getByRole("button", { name: "Continue" }));
	await tabTo(page, page.getByRole("link", { name: "Create an account" }));
	await page.keyboard.press("Shift+Tab");
	const code = await codeSentBy(() => page.keyboard.press("Enter"));

	await expect(page.getByLabel("Code")).toBeFocused();
	await page.keyboard.type(code);
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(ARRIVAL);
});

test("going back a step, with the keyboard alone, returns to the field that was filled", async ({
	page,
}) => {
	const person = newPerson();
	await openAuthPage(page, "/sign-up");
	await page.getByLabel("Name").focus();
	await page.keyboard.type(person.name);
	await page.keyboard.press("Tab");
	await page.keyboard.type(person.email);
	await codeSentBy(() => page.keyboard.press("Enter"));
	await expect(page.getByLabel("Code")).toBeFocused();

	await page.keyboard.press("Tab");
	await page.keyboard.press("Tab");
	await tabTo(page, page.getByRole("button", { name: "Use a different email" }));
	await page.keyboard.press("Enter");

	// What was typed is still there, and the focus is in the first field.
	await expect(page.getByLabel("Name")).toBeFocused();
	await expect(page.getByLabel("Name")).toHaveValue(person.name);
	await expect(page.getByLabel("Email")).toHaveValue(person.email);
});

test("signing out from Settings, with the keyboard alone", async ({ page }) => {
	await signUp(page, newPerson());
	await expect(page).toHaveURL(ARRIVAL);
	await openSettings(page);

	// The two ways out follow each other in the tab order, and each shows the focus.
	const out = page.getByRole("button", { name: "Sign out", exact: true });
	await out.focus();
	await tabTo(page, page.getByRole("button", { name: "Sign out everywhere" }));
	await page.keyboard.press("Shift+Tab");
	await expectFocusShown(out);

	await page.keyboard.press("Enter");
	await expect(page).toHaveURL("/sign-in");
});
