import type { Page } from "@playwright/test";

import { accountPath, organisationPath } from "../app/shell/destinations";
import {
	ARRIVAL,
	accountMenuName,
	newPerson,
	openProfileMenu,
	ownAddress,
	profileButton,
	setName,
	signIn,
	TIME_WITH_TURNS,
} from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, takenOver, test } from "./fixtures";
import { createOrganisation } from "./organisation";

// The profile menu (TS-063): the person's initials in a circle at the end of
// the band, which opens Account settings and Sign out, as Harvest opens profile
// and sign out from the person at the top. Each test is a person of their own,
// with an organisation of their own.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

const COMPACT = { width: 390, height: 844 };
const MEDIUM = { width: 1280, height: 800 };

/** Who the server says this browser is signed in as, or `null`. */
async function whoIs(page: Page): Promise<{ email: string } | null> {
	const response = await page.request.get("/api/auth/get-session");
	const session: { user: { email: string } } | null = await response.json();
	return session && { email: session.user.email };
}

/** Signs a new person in, who creates an organisation; its Timesheet is open, taken over by React. */
async function personWithOrganisation(page: Page) {
	const person = newPerson();
	await signIn(page, person.email);
	const organisation = await createOrganisation(page);
	await openShell(page, organisationPath(organisation.slug));
	return { person, organisation };
}

test("opens by a click and holds Account settings, My time report and Sign out, under the person's name, address and organisation", async ({
	page,
}) => {
	const { person, organisation } = await personWithOrganisation(page);

	// Until a name is given: the address, and its first letter.
	await expect(profileButton(page)).toHaveAccessibleName(accountMenuName(person.email));
	await expect(profileButton(page)).toHaveText(person.email.charAt(0).toUpperCase());

	await setName(page, "Ada King Lovelace");
	await openShell(page, organisationPath(organisation.slug));
	const avatar = profileButton(page);
	await expect(avatar).toHaveAccessibleName("Account menu for Ada King Lovelace, AL");
	await expect(avatar).toHaveText("AL");
	// A circle, 40px across: a touch target of 40px at the least.
	const size = await avatar.boundingBox();
	expect(size?.width).toBeGreaterThanOrEqual(40);
	expect(size?.height).toBeGreaterThanOrEqual(40);

	const menu = await openProfileMenu(page);
	await expect(menu).toHaveAccessibleName("Account menu for Ada King Lovelace, AL");
	await expect(menu.getByRole("menuitem")).toHaveText([
		"Account settings",
		"My time report",
		"Sign out",
	]);
	await expect(menu.getByText(organisation.name, { exact: true })).toBeVisible();
	await expect(page.getByText("Ada King Lovelace", { exact: true })).toBeVisible();
	await expect(page.getByText(person.email, { exact: true })).toBeVisible();

	await menu.getByRole("menuitem", { name: "Account settings" }).click();
	await expect(page).toHaveURL(accountPath(organisation.slug));
	await expect(page.getByRole("heading", { level: 1, name: "My account" })).toBeFocused();
	await expect(menu).toBeHidden();
	// My account keeps the other way out, and not this one.
	await expect(page.getByRole("button", { name: "Sign out everywhere" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
});

test("opens with Enter, Space and ArrowDown; Escape closes it and gives the focus back", async ({
	page,
}) => {
	await personWithOrganisation(page);
	const avatar = profileButton(page);
	const menu = page.getByRole("menu");
	const settings = page.getByRole("menuitem", { name: "Account settings" });

	for (const key of ["Enter", "Space", "ArrowDown"]) {
		await avatar.focus();
		await page.keyboard.press(key);
		await expect(menu, key).toBeVisible();
		await expect(settings, key).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(menu, key).toBeHidden();
		await expect(avatar, key).toBeFocused();
		await expect(avatar, key).toHaveAttribute("data-focus-visible", "true");
	}

	// The arrows move between the items, and Enter follows Account settings.
	await page.keyboard.press("Enter");
	await page.keyboard.press("ArrowDown");
	await expect(page.getByRole("menuitem", { name: "My time report" })).toBeFocused();
	await page.keyboard.press("ArrowUp");
	await expect(settings).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("heading", { level: 1, name: "My account" })).toBeFocused();
});

test("Sign out ends the session and lands on the sign-in page", async ({ page }) => {
	const { person } = await personWithOrganisation(page);
	expect((await whoIs(page))?.email).toBe(person.email);

	await (await openProfileMenu(page)).getByRole("menuitem", { name: "Sign out" }).click();

	await expect(page).toHaveURL("/sign-in");
	expect(await whoIs(page)).toBeNull();
	await expect(page.getByRole("heading", { level: 1, name: "Enter your email" })).toBeVisible();
});

test("outside an organisation it holds the way out alone, called Use a different email where a new account lands", async ({
	page,
}) => {
	const person = newPerson();
	await signIn(page, person.email);
	await expect(page).toHaveURL(ARRIVAL);
	await takenOver(page, "header");

	const menu = await openProfileMenu(page);
	await expect(menu.getByRole("menuitem")).toHaveText(["Use a different email"]);
	await menu.getByRole("menuitem").click();
	await expect(page).toHaveURL("/sign-in");
	expect(await whoIs(page)).toBeNull();
});

for (const viewport of [COMPACT, MEDIUM]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });

			test("the band and the open menu have no accessibility violations, and the menu fits the window", async ({
				page,
			}) => {
				await personWithOrganisation(page);
				const avatar = profileButton(page);
				await avatar.focus();
				await page.keyboard.press("Enter");
				const menu = page.getByRole("menu");
				await expect(menu).toBeVisible();

				const box = await page.locator("[data-trigger=MenuTrigger]").boundingBox();
				expect(box?.x).toBeGreaterThanOrEqual(0);
				expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
				// The page lies under the open menu.
				expect(await problems(page, [UNDER_AN_OVERLAY])).toEqual([]);

				await page.keyboard.press("Escape");
				await expect(avatar).toBeFocused();
				expect(await problems(page)).toEqual([]);
			});
		});
	}
}

test("My time report opens Reports with the person's own time this week; with a second organisation the menu lists them (W31)", async ({
	page,
}) => {
	const { organisation } = await personWithOrganisation(page);
	let menu = await openProfileMenu(page);
	await menu.getByRole("menuitem", { name: "My time report" }).click();
	await expect(page).toHaveURL(/\/reports\?range=this-week&group=project&person=/);
	await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();

	const second = await createOrganisation(page);
	await openShell(page, organisationPath(second.slug));
	menu = await openProfileMenu(page);
	await expect(menu.getByRole("menuitem")).toHaveText([
		"Account settings",
		"My time report",
		"Your organisations",
		"Sign out",
	]);
	await menu.getByRole("menuitem", { name: "Your organisations" }).click();
	await expect(page).toHaveURL("/app");
	await expect(page.getByRole("heading", { level: 1, name: "Your organisations" })).toBeVisible();
	await expect(page.getByRole("link", { name: organisation.name })).toBeVisible();
	await expect(page.getByRole("link", { name: second.name })).toBeVisible();
});
