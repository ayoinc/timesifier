import type { BrowserContext, Page } from "@playwright/test";

import { accountPath, destination } from "../app/shell/destinations";
import { SIGNED_OUT } from "./auth-state";
import { expect, openShell, test } from "./fixtures";
import { homeOrganisation, homePath } from "./organisation";

// The colour scheme (TS-006, criterion 4, as card TS-036 changed it): light is
// the product's face, so a person who has chosen nothing gets light whatever
// their device prefers. Dark, and matching the device, are choices on My account,
// kept in a cookie the server renders from.

const timesheet = destination("timesheet");
/** My account in the organisation of the person signed in, where the scheme is chosen. */
const account = () => accountPath(homeOrganisation().slug);

type Choice = "Light" | "Dark" | "Match my device";

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
async function choose(page: Page, name: Choice): Promise<string | null> {
	const answered = page.waitForResponse((response) => response.request().method() === "POST");
	await schemes(page).getByText(name, { exact: true }).click();
	await expect(schemes(page).getByRole("radio", { name })).toBeChecked();
	return (await answered).headerValue("set-cookie");
}

const cookieOf = (value: string) =>
	`__Host-color-scheme=${value}; Max-Age=31536000; Path=/; Secure; SameSite=Lax`;

test.describe("with the device set to dark", () => {
	test.use({ colorScheme: "dark" });

	test.describe("and nobody signed in", () => {
		test.use({ storageState: SIGNED_OUT });

		for (const path of ["/", "/sign-in", "/privacy", "/terms"]) {
			test(`${path} is light: the device's preference is not asked`, async ({ page, context }) => {
				await page.goto(path);

				expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(
					true,
				);
				expect(await shown(page)).toBe("light");
				await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light");
				// Nothing was chosen, so nothing was stored.
				expect(await schemeCookies(context)).toEqual([]);
			});
		}
	});

	test("a signed-in page is light until a scheme is chosen, and Light is the choice shown", async ({
		page,
		context,
	}) => {
		await openShell(page, account());

		expect(await shown(page)).toBe("light");
		await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light");
		await expect(schemes(page).getByRole("radio")).toHaveCount(3);
		await expect(schemes(page).getByRole("radio", { name: "Light" })).toBeChecked();
		await expect(schemes(page).locator("label")).toHaveText(["Light", "Dark", "Match my device"]);
		expect(await schemeCookies(context)).toEqual([]);

		// With nothing chosen, the page does not change when the device does.
		await page.emulateMedia({ colorScheme: "light" });
		expect(await shown(page)).toBe("light");
		await page.emulateMedia({ colorScheme: "dark" });
		expect(await shown(page)).toBe("light");
	});

	test("choosing Dark makes the page dark at once, and it stays dark", async ({
		page,
		context,
	}) => {
		await openShell(page, account());
		await page.evaluate(() => {
			document.documentElement.dataset.loadedOnce = "yes";
		});

		const cookie = await choose(page, "Dark");
		await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
		expect(await shown(page)).toBe("dark");
		// The change arrived in the page that was open: the mark is still there.
		await expect(page.locator("html")).toHaveAttribute("data-loaded-once", "yes");
		await expect(page).toHaveURL(account());

		// The cookie: its name and every attribute. No Domain, and not HttpOnly.
		expect(cookie).toBe(cookieOf("dark"));

		// It holds when the device turns light…
		await page.emulateMedia({ colorScheme: "light" });
		expect(await shown(page)).toBe("dark");

		// …survives a reload…
		await page.reload();
		await expect(page.locator("html")).not.toHaveAttribute("data-loaded-once");
		expect(await shown(page)).toBe("dark");
		await expect(schemes(page).getByRole("radio", { name: "Dark" })).toBeChecked();

		// …and a new page in the same browser, on another destination and on a public page.
		const another = await context.newPage();
		await another.goto(homePath(timesheet.id));
		expect(await shown(another)).toBe("dark");
		await another.goto("/privacy");
		expect(await shown(another)).toBe("dark");

		// The server rendered it: the scheme is in the HTML before any script runs.
		const html = await (await context.request.get(homePath(timesheet.id))).text();
		expect(html).toContain('<html lang="en" data-color-scheme="dark">');
	});

	test("choosing Light stores the choice, and the page stays light after a reload", async ({
		page,
		context,
	}) => {
		await openShell(page, account());
		await choose(page, "Dark");
		await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");

		const cookie = await choose(page, "Light");
		await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light");
		expect(cookie).toBe(cookieOf("light"));
		expect(await shown(page)).toBe("light");

		await page.reload();
		expect(await shown(page)).toBe("light");
		await expect(schemes(page).getByRole("radio", { name: "Light" })).toBeChecked();
		expect((await schemeCookies(context)).map(({ value }) => value)).toEqual(["light"]);
	});

	test("choosing Match my device stores the choice, and the page follows the device from then on", async ({
		page,
		context,
	}) => {
		await openShell(page, account());

		const cookie = await choose(page, "Match my device");
		await expect(page.locator("html")).not.toHaveAttribute("data-color-scheme");
		expect(cookie).toBe(cookieOf("system"));
		expect((await schemeCookies(context)).map(({ value }) => value)).toEqual(["system"]);

		expect(await shown(page)).toBe("dark");
		await page.reload();
		expect(await shown(page)).toBe("dark");
		await expect(schemes(page).getByRole("radio", { name: "Match my device" })).toBeChecked();
		await page.emulateMedia({ colorScheme: "light" });
		expect(await shown(page)).toBe("light");

		// The server rendered it: no scheme is forced in the HTML.
		const html = await (await context.request.get(homePath(timesheet.id))).text();
		expect(html).toContain('<html lang="en">');
	});

	test("the choice is made with the keyboard alone", async ({ page }) => {
		await openShell(page, account());

		const light = schemes(page).getByRole("radio", { name: "Light" });
		// Before it: the skip link, the band, the timer's control, every destination
		// and the time-zone field on My account.
		for (let presses = 0; presses < 24; presses++) {
			if (await light.evaluate((element) => element === document.activeElement)) break;
			await page.keyboard.press("Tab");
		}
		await expect(light).toBeFocused();

		await page.keyboard.press("ArrowDown");
		await expect(schemes(page).getByRole("radio", { name: "Dark" })).toBeChecked();
		await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
		// The focus stays on the choice just made.
		await expect(schemes(page).getByRole("radio", { name: "Dark" })).toBeFocused();
	});
});

test.describe("without script, with the device set to dark", () => {
	test.use({ colorScheme: "dark", javaScriptEnabled: false });

	test("the form still saves each of the three choices", async ({ page }) => {
		await page.goto(account());
		expect(await shown(page)).toBe("light");

		const save = async (name: Choice) => {
			await schemes(page).getByText(name, { exact: true }).click();
			const answered = page.waitForResponse((response) => response.request().method() === "POST");
			await page.getByRole("button", { name: "Save" }).click();
			const answer = await answered;
			expect(answer.status()).toBe(303);
			await expect(page).toHaveURL(account());
			await expect(schemes(page).getByRole("radio", { name })).toBeChecked();
			return answer.headerValue("set-cookie");
		};

		expect(await save("Dark")).toBe(cookieOf("dark"));
		await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
		expect(await shown(page)).toBe("dark");

		expect(await save("Light")).toBe(cookieOf("light"));
		await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light");
		expect(await shown(page)).toBe("light");

		// And the device's own scheme, which here is dark.
		expect(await save("Match my device")).toBe(cookieOf("system"));
		await expect(page.locator("html")).not.toHaveAttribute("data-color-scheme");
		expect(await shown(page)).toBe("dark");
	});
});

test("with script there is no Save button: a choice is saved as it is made", async ({ page }) => {
	await openShell(page, account());
	await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
});
