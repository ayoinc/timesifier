import type { BrowserContext, Page } from "@playwright/test";

import { destination } from "../app/shell/destinations";
import { expect, openShell, test } from "./fixtures";
import { homePath } from "./organisation";

// The colour scheme (TS-006, criterion 4): it follows the device, a person can
// override it in Settings, and the override is a cookie the server renders from.

const settings = destination("settings");
const today = destination("today");

/** What a person sees: a dark page has a dark background, a light page a light one. */
async function shown(page: Page): Promise<"light" | "dark"> {
	// A page still arriving has no stylesheet yet, and so no background to read.
	await page.waitForLoadState("load");
	const [red = 0, green = 0, blue = 0] = await page.evaluate(() =>
		(getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g) ?? []).map(Number),
	);
	return red + green + blue < 3 * 128 ? "dark" : "light";
}

/** The colour-scheme cookies the browser holds. It also holds the session's, which is not this test's. */
async function schemeCookies(context: BrowserContext) {
	return (await context.cookies()).filter(({ name }) => name === "__Host-color-scheme");
}

function schemes(page: Page) {
	return page.getByRole("radiogroup", { name: "Colour scheme" });
}

/** Chooses a scheme the way a pointer does, and returns the `Set-Cookie` header of the answer. */
async function choose(page: Page, name: "System" | "Light" | "Dark"): Promise<string | null> {
	const answered = page.waitForResponse((response) => response.request().method() === "POST");
	await schemes(page).getByText(name, { exact: true }).click();
	await expect(schemes(page).getByRole("radio", { name })).toBeChecked();
	return (await answered).headerValue("set-cookie");
}

test.describe("with the device set to dark", () => {
	test.use({ colorScheme: "dark" });

	test("the page follows the device until a scheme is chosen", async ({ page }) => {
		await openShell(page, homePath(settings.id));

		expect(await shown(page)).toBe("dark");
		await expect(page.locator("html")).not.toHaveAttribute("data-color-scheme");
		await expect(schemes(page).getByRole("radio", { name: "System" })).toBeChecked();
		await expect(schemes(page).getByRole("radio")).toHaveCount(3);

		// With nothing chosen, the page changes when the device does.
		await page.emulateMedia({ colorScheme: "light" });
		expect(await shown(page)).toBe("light");
	});

	test("choosing Light makes the page light at once, and it stays light", async ({
		page,
		context,
	}) => {
		await openShell(page, homePath(settings.id));
		await page.evaluate(() => {
			document.documentElement.dataset.loadedOnce = "yes";
		});

		const cookie = await choose(page, "Light");
		await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light");
		expect(await shown(page)).toBe("light");
		// The change arrived in the page that was open: the mark is still there.
		await expect(page.locator("html")).toHaveAttribute("data-loaded-once", "yes");
		await expect(page).toHaveURL(homePath(settings.id));

		// The cookie: its name and every attribute. No Domain, and not HttpOnly.
		expect(cookie).toBe(
			"__Host-color-scheme=light; Max-Age=31536000; Path=/; Secure; SameSite=Lax",
		);

		// It survives a reload…
		await page.reload();
		await expect(page.locator("html")).not.toHaveAttribute("data-loaded-once");
		expect(await shown(page)).toBe("light");
		await expect(schemes(page).getByRole("radio", { name: "Light" })).toBeChecked();

		// …and a new page in the same browser, on another destination.
		const another = await context.newPage();
		await another.goto(homePath(today.id));
		expect(await shown(another)).toBe("light");

		// The server rendered it: the scheme is in the HTML before any script runs.
		const html = await (await context.request.get(homePath(today.id))).text();
		expect(html).toContain('<html lang="en" data-color-scheme="light">');
	});

	test("choosing Dark holds the page dark when the device turns light", async ({ page }) => {
		await openShell(page, homePath(settings.id));

		const cookie = await choose(page, "Dark");
		await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
		expect(cookie).toBe("__Host-color-scheme=dark; Max-Age=31536000; Path=/; Secure; SameSite=Lax");

		await page.emulateMedia({ colorScheme: "light" });
		expect(await shown(page)).toBe("dark");
	});

	test("choosing System deletes the cookie and the page follows the device again", async ({
		page,
		context,
	}) => {
		await openShell(page, homePath(settings.id));
		await choose(page, "Light");
		await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light");
		expect(await schemeCookies(context)).toHaveLength(1);

		const cookie = await choose(page, "System");
		await expect(page.locator("html")).not.toHaveAttribute("data-color-scheme");
		expect(cookie).toBe("__Host-color-scheme=; Max-Age=0; Path=/; Secure; SameSite=Lax");
		expect(await schemeCookies(context)).toEqual([]);

		expect(await shown(page)).toBe("dark");
		await page.reload();
		expect(await shown(page)).toBe("dark");
		await page.emulateMedia({ colorScheme: "light" });
		expect(await shown(page)).toBe("light");
	});

	test("the choice is made with the keyboard alone", async ({ page }) => {
		await openShell(page, homePath(settings.id));

		const system = schemes(page).getByRole("radio", { name: "System" });
		for (let presses = 0; presses < 12; presses++) {
			if (await system.evaluate((element) => element === document.activeElement)) break;
			await page.keyboard.press("Tab");
		}
		await expect(system).toBeFocused();

		await page.keyboard.press("ArrowDown");
		await expect(schemes(page).getByRole("radio", { name: "Light" })).toBeChecked();
		await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light");
		// The focus stays on the choice just made.
		await expect(schemes(page).getByRole("radio", { name: "Light" })).toBeFocused();
	});
});

test.describe("without script, with the device set to dark", () => {
	test.use({ colorScheme: "dark", javaScriptEnabled: false });

	test("the form still changes the scheme", async ({ page }) => {
		await page.goto(homePath(settings.id));
		expect(await shown(page)).toBe("dark");

		await schemes(page).getByText("Light", { exact: true }).click();
		const answered = page.waitForResponse((response) => response.request().method() === "POST");
		await page.getByRole("button", { name: "Save" }).click();

		const answer = await answered;
		expect(answer.status()).toBe(303);
		expect(await answer.headerValue("set-cookie")).toBe(
			"__Host-color-scheme=light; Max-Age=31536000; Path=/; Secure; SameSite=Lax",
		);
		await expect(page).toHaveURL(homePath(settings.id));
		await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light");
		expect(await shown(page)).toBe("light");
		await expect(schemes(page).getByRole("radio", { name: "Light" })).toBeChecked();

		// And back to the device's scheme.
		await schemes(page).getByText("System", { exact: true }).click();
		await page.getByRole("button", { name: "Save" }).click();
		await expect(page.locator("html")).not.toHaveAttribute("data-color-scheme");
		expect(await shown(page)).toBe("dark");
	});
});

test("with script there is no Save button: a choice is saved as it is made", async ({ page }) => {
	await openShell(page, homePath(settings.id));
	await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
});
