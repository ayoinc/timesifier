import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Locator, Page } from "@playwright/test";

import {
	ACCOUNTS_PATH,
	MAIL_PATH,
	ORGANISATIONS_PATH,
	PLATFORM_PATH,
	VERIFY_PATH,
} from "../app/platform/paths";
import { COLOR_SCHEME_COOKIE } from "../app/shell/color-scheme.server";
import { accountPath, destinationPath, organisationPath } from "../app/shell/destinations";
import {
	CONTINUE,
	codeSentBy,
	newPerson,
	openAuthPage,
	ownAddress,
	signIn,
	TIME_WITH_TURNS,
} from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { contrast, EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation, type Organisation } from "./organisation";
import { aPlatformOwner } from "./platform-owners";

// The platform console in a browser (TS-099). A platform owner (one of the
// addresses of e2e/platform-owners.ts) signs in
// and is asked for a second code before the console opens, done with the
// keyboard alone; an organisation's owner grants support access, and the
// console then reads the organisation and says until when; a new person asks
// for the newsletter on the sign-in page and finds it on in My account. Then
// every page of the console, and the organisation's Plan, Support access and
// Wellbeing, at both window sizes in both schemes, with no WCAG 2.2 A or AA
// violation. The screenshots go where the card's review reads them.

const SHOTS =
	process.env.SHOT_DIR ??
	"/Users/ayodele.ajayi/Workspace/Personal/cmux-assets/browser/timesifier/TS-099";

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS * 3 });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

/** Presses Tab until `target` has the focus. */
async function tabTo(page: Page, target: Locator, most = 60) {
	for (let step = 0; step < most; step++) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press("Tab");
	}
	throw new Error("Tab never reached the control.");
}

/**
 * Signs the platform's owner in and proves the session with the console's
 * code, by the keyboard alone: Tab to the button that sends it, Enter, type
 * it, Enter. The page is left on Health.
 */
async function openConsole(page: Page) {
	await signIn(page, aPlatformOwner());
	await openShell(page, PLATFORM_PATH, "header");
	await expect(page).toHaveURL(VERIFY_PATH);
	await expect(
		page.getByRole("heading", { level: 1, name: "Open the platform console" }),
	).toBeVisible();
	const send = page.getByRole("button", { name: "Send a code", exact: true });
	await tabTo(page, send);
	const code = await codeSentBy(() => page.keyboard.press("Enter"));
	const field = page.getByLabel("Code");
	await expect(field).toBeFocused();
	await page.keyboard.type(code);
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(PLATFORM_PATH);
	await expect(page.getByRole("heading", { level: 1, name: "Health" })).toBeVisible();
}

/** A new person with an organisation of their own, signed in, in a window of their own. */
async function organisationOwner(
	browser: Browser,
	baseURL: string | undefined,
	{
		viewport,
		scheme,
	}: { viewport?: { width: number; height: number }; scheme?: "light" | "dark" } = {},
): Promise<{ page: Page; email: string; organisation: Organisation; close: () => Promise<void> }> {
	const context = await browser.newContext({ viewport, storageState: SIGNED_OUT, baseURL });
	await ownAddress(context, baseURL);
	if (scheme) {
		// The cookie My account sets, as the `chosenScheme` fixture gives the test's own page.
		await context.addCookies([
			{
				name: COLOR_SCHEME_COOKIE,
				value: scheme,
				domain: new URL(baseURL ?? "http://localhost").hostname,
				path: "/",
				secure: true,
				sameSite: "Lax",
			},
		]);
	}
	const page = await context.newPage();
	const { email } = newPerson();
	await signIn(page, email);
	const organisation = await createOrganisation(page);
	return { page, email, organisation, close: () => context.close() };
}

/** Grants support access for 72 hours from Workspace settings › Support access, by the keyboard. */
async function grantSupport(page: Page, organisation: Organisation) {
	await openShell(page, destinationPath(organisation.slug, "settings"));
	await page.getByRole("link", { name: /Support access/ }).click();
	await expect(page.getByRole("heading", { level: 1, name: "Support access" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Not granted" })).toBeVisible();
	const grant = page.getByRole("button", { name: "Grant support access" });
	await tabTo(page, grant);
	await page.keyboard.press("Enter");
	const sheet = page.getByRole("dialog", { name: "Grant support access" });
	await expect(sheet).toBeVisible();
	await sheet.getByText("Three days (72 hours)", { exact: true }).click();
	await expect(sheet.getByRole("radio", { name: "Three days (72 hours)" })).toBeChecked();
	await sheet.getByRole("button", { name: "Grant access" }).press("Enter");
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("heading", { name: /^Granted until / })).toBeVisible();
}

test("the console asks a signed-in platform owner for a code of its own, and opens to it", async ({
	page,
}) => {
	await openConsole(page);
	// The tabs, in order, with Health current; the Brand page comes with TS-100.
	const tabs = page.getByRole("group", { name: "Platform console sections" }).getByRole("link");
	await expect(tabs).toHaveText(["Health", "Organisations", "Accounts", "Mail", "Log"]);
	await expect(tabs.first()).toHaveAttribute("aria-current", "page");
	await expect(page.getByRole("heading", { level: 1, name: "Health" })).toBeVisible();
});

test("a person who is not a platform owner is answered as if the console did not exist", async ({
	page,
}) => {
	await signIn(page, newPerson().email);
	// Asked with the page's own cookies; a page that loads a 404 logs it as an error.
	for (const address of [
		PLATFORM_PATH,
		VERIFY_PATH,
		ACCOUNTS_PATH,
		`${PLATFORM_PATH}-nothing-here`,
	]) {
		expect((await page.request.get(address, { maxRedirects: 0 })).status(), address).toBe(404);
	}
});

test("an owner grants support access; the console reads the organisation until it ends, and the owner ends it", async ({
	page,
	browser,
	baseURL,
}) => {
	const owner = await organisationOwner(browser, baseURL);
	await grantSupport(owner.page, owner.organisation);

	await openConsole(page);
	await page.getByRole("link", { name: "Organisations", exact: true }).click();
	await page.getByLabel("Name or web address").fill(owner.organisation.name);
	await page.keyboard.press("Enter");
	await page.getByRole("link", { name: owner.organisation.name }).click();
	await expect(
		page.getByRole("heading", { level: 1, name: owner.organisation.name }),
	).toBeVisible();
	await page.getByRole("link", { name: "Read the organisation" }).click();
	await expect(page.getByRole("heading", { level: 1, name: "Support view" })).toBeVisible();
	await expect(page.getByRole("note")).toContainText("it ends");
	// It reads; nothing on it changes anything.
	await expect(page.locator("main form[method='post']")).toHaveCount(0);

	// The reading is in the organisation's own activity log.
	await openShell(owner.page, destinationPath(owner.organisation.slug, "activity"));
	await expect(owner.page.getByText(/support/i).first()).toBeVisible();

	// The owner ends it; the console's view is then a 404.
	await openShell(owner.page, `${organisationPath(owner.organisation.slug)}/settings/support`);
	await owner.page.getByRole("button", { name: "End support access" }).click();
	const ending = owner.page.getByRole("dialog", { name: "End support access?" });
	await ending.getByRole("button", { name: /End/ }).click();
	await expect(ending).toBeHidden();
	await expect(owner.page.getByRole("heading", { name: "Not granted" })).toBeVisible();
	expect((await page.request.get(page.url(), { maxRedirects: 0 })).status()).toBe(404);
	await owner.close();
});

test("a new person asks for the newsletter on the sign-in page and finds it on in My account", async ({
	page,
}) => {
	const { email } = newPerson();
	await openAuthPage(page);
	await page.getByLabel("Email").fill(email);
	const box = page.getByRole("checkbox", { name: /newsletter/ });
	await expect(box).not.toBeChecked();
	await page.getByText(/^New here\? Send me the Timesifier newsletter/).click();
	await expect(box).toBeChecked();
	const code = await codeSentBy(() => page.getByRole("button", CONTINUE).click());
	await page.getByLabel("Code").fill(code);
	await page.getByRole("button", CONTINUE).click();
	await page.waitForURL((url) => url.pathname !== "/sign-in");
	const organisation = await createOrganisation(page);

	await openShell(page, accountPath(organisation.slug));
	const newsletter = page.getByRole("switch", { name: "Newsletter" });
	await expect(newsletter).toBeChecked();
	await expect(page.getByRole("switch", { name: "Product announcements" })).toBeChecked();
	// Turned off from the keyboard, and still off after a reload.
	await newsletter.focus();
	await page.keyboard.press("Space");
	await expect(page.getByRole("status")).not.toBeEmpty();
	await page.reload();
	await expect(page.getByRole("switch", { name: "Newsletter" })).not.toBeChecked();
	await expect(page.getByRole("link", { name: "Download my data" })).toBeVisible();
});

/** Checks the page with axe and saves its picture as `<name>-<width>-<scheme>.png`. */
async function check(page: Page, heading: string | RegExp, name: string, at: string) {
	await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
	expect(await problems(page, [EMPTY_INPUT]), `problems in ${name}`).toEqual([]);
	await page.screenshot({ path: join(SHOTS, `${name}-${at}.png`), fullPage: true });
}

/** The same for a sheet that is open, which is then closed with Escape. */
async function checkSheet(page: Page, sheet: Locator, text: Locator, name: string, at: string) {
	await expect(sheet).toBeVisible();
	expect(
		await problems(page, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS, EMPTY_INPUT]),
		`problems with ${name} open`,
	).toEqual([]);
	expect(await contrast(text), `contrast of ${name}`).toBeGreaterThanOrEqual(4.5);
	await page.screenshot({ path: join(SHOTS, `${name}-${at}.png`) });
	await page.keyboard.press("Escape");
	await expect(sheet).toBeHidden();
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });
			const at = `${viewport.width}-${colorScheme}`;

			test("the console's pages, and the organisation's plan, support access and wellbeing", async ({
				page,
				browser,
				baseURL,
			}) => {
				mkdirSync(SHOTS, { recursive: true });
				const owner = await organisationOwner(browser, baseURL, { viewport, scheme: colorScheme });
				const { slug } = owner.organisation;
				await openShell(owner.page, destinationPath(slug, "settings"));
				await check(owner.page, "Workspace settings", "settings-plan", at);
				await grantSupport(owner.page, owner.organisation);
				await check(owner.page, "Support access", "support-access", at);
				await openShell(owner.page, `${organisationPath(slug)}/settings/wellbeing`);
				await check(owner.page, "Wellbeing", "wellbeing", at);
				await openShell(owner.page, accountPath(slug));
				await check(owner.page, "My account", "my-account", at);

				await signIn(page, aPlatformOwner());
				await openShell(page, VERIFY_PATH, "header");
				await check(page, "Open the platform console", "verify", at);
				const code = await codeSentBy(() =>
					page.getByRole("button", { name: "Send a code", exact: true }).click(),
				);
				await page.getByLabel("Code").fill(code);
				await page.getByRole("button", { name: "Open the console" }).click();
				await check(page, "Health", "health", at);

				await openShell(
					page,
					`${ORGANISATIONS_PATH}?q=${encodeURIComponent(owner.organisation.name)}`,
					"header",
				);
				await check(page, "Organisations", "organisations", at);
				await page.getByRole("link", { name: owner.organisation.name }).click();
				await check(page, owner.organisation.name, "organisation", at);
				await page.getByRole("button", { name: "Change the plan" }).click();
				const plan = page.getByRole("dialog", { name: "Change the plan" });
				await checkSheet(
					page,
					plan,
					plan.getByText("Plan", { exact: true }).first(),
					"organisation-plan-sheet",
					at,
				);
				await page.getByRole("link", { name: "Read the organisation" }).click();
				await check(page, "Support view", "support-view", at);

				await openShell(page, ACCOUNTS_PATH, "header");
				await check(page, "Accounts", "accounts", at);
				// The organisation's owner has no name yet: the console finds them by address.
				await page.getByLabel("Name or address").fill(owner.email);
				await page.keyboard.press("Enter");
				await page.getByRole("main").getByRole("link", { name: "No name yet" }).click();
				await check(page, "No name yet", "account", at);
				await page.getByRole("button", { name: "End sessions" }).click();
				const ending = page.getByRole("dialog", { name: "End every session?" });
				await checkSheet(
					page,
					ending,
					ending.getByText("Reason").first(),
					"account-tool-sheet",
					at,
				);

				await openShell(page, MAIL_PATH, "header");
				await page.getByLabel("Subject").fill("What is new in November");
				await page.getByLabel("Message").fill("Hello.\n\nCalendars now show leave.");
				await page.getByRole("button", { name: "Preview" }).click();
				await expect(page.getByText("Preview: What is new in November")).toBeVisible();
				await check(page, "Mail", "mail", at);

				await openShell(page, `${PLATFORM_PATH}/activity`, "header");
				await check(page, "Log", "log", at);
				await owner.close();
			});
		});
	}
}
