import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";

import { organisationPath } from "../app/shell/destinations";
import { problems } from "./axe";
import { expect, takenOver, test } from "./fixtures";
import { expectRefusal, homeOrganisation, homePath } from "./organisation";

// Audit W14: an address in the organisation that holds no page, or asks for
// something that is not valid, is answered inside the shell, with the band,
// the organisation's name and the navigation kept. Every error page keeps the
// scheme the person chose: a person who chose dark is not shown a white page.
// Each is looked at in both schemes, at a phone's width and a desktop's.

/** What a person sees: a dark page has a dark background. */
async function shown(page: Page): Promise<"light" | "dark"> {
	await page.waitForLoadState("load");
	const [red = 0, green = 0, blue = 0] = await page.evaluate(() =>
		(getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g) ?? []).map(Number),
	);
	return red + green + blue < 3 * 128 ? "dark" : "light";
}

const MAIN_NAVIGATION = { name: "Main" } as const;

for (const [scheme, width] of [
	["light", 390],
	["light", 1280],
	["dark", 390],
	["dark", 1280],
] as const) {
	test.describe(`${scheme}, at ${width}px`, () => {
		test.use({ chosenScheme: scheme, viewport: { width, height: 844 } });

		test("an address in the organisation that holds no page: 404 inside the shell, in the chosen scheme, and a way to the Timesheet", async ({
			page,
			refusals,
		}) => {
			const missing = `${homePath("timesheet")}/does-not-exist`;
			expectRefusal(refusals, missing, 404);

			const response = await page.goto(missing);
			expect(response?.status()).toBe(404);
			await expect(page.locator("html")).toHaveAttribute("data-color-scheme", scheme);
			expect(await shown(page)).toBe(scheme);
			await expect(page.getByRole("banner")).toContainText(homeOrganisation().name);
			await expect(page.getByRole("navigation", MAIN_NAVIGATION)).toBeVisible();
			await expect(
				page.getByRole("heading", { level: 1, name: "There's no page here" }),
			).toBeVisible();
			expect(await problems(page), "accessibility problems").toEqual([]);

			await takenOver(page);
			await page.getByRole("main").getByRole("link", { name: "Go to the Timesheet" }).click();
			await expect(page).toHaveURL(homePath("timesheet"));
			expect(await shown(page)).toBe(scheme);
		});

		test("an address that asks for something not valid: 400 inside the shell, said as such", async ({
			page,
			refusals,
		}) => {
			expectRefusal(refusals, homePath("approvals"), 400);

			const response = await page.goto(`${homePath("approvals")}?status=bogus`);
			expect(response?.status()).toBe(400);
			expect(await shown(page)).toBe(scheme);
			await expect(page.getByRole("navigation", MAIN_NAVIGATION)).toBeVisible();
			await expect(
				page.getByRole("heading", {
					level: 1,
					name: "That address asks for something that isn't valid",
				}),
			).toBeVisible();
			await expect(page.getByText("Internal Server Error")).toHaveCount(0);
			expect(await problems(page), "accessibility problems").toEqual([]);
		});

		test("an organisation that is not the person's: 404 outside any shell, in the chosen scheme", async ({
			page,
			refusals,
		}) => {
			const nobodys = organisationPath(`nobody-${randomUUID().slice(0, 8)}`);
			expectRefusal(refusals, nobodys, 404);

			const response = await page.goto(nobodys);
			expect(response?.status()).toBe(404);
			await expect(page.locator("html")).toHaveAttribute("data-color-scheme", scheme);
			expect(await shown(page)).toBe(scheme);
			await expect(page.getByRole("navigation", MAIN_NAVIGATION)).toHaveCount(0);
			await expect(
				page.getByRole("heading", { level: 1, name: "There's no page here" }),
			).toBeVisible();
			expect(await problems(page), "accessibility problems").toEqual([]);
		});
	});
}
