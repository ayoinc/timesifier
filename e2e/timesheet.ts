import type { Page } from "@playwright/test";

import { destinationPath } from "../app/shell/destinations";
import { expect, openShell } from "./fixtures";

/**
 * Creates an active project in the organisation with this slug through the
 * Projects page (TS-011a), as the signed-in person, who may create one.
 */
export async function createProject(page: Page, slug: string, name: string) {
	await openShell(page, destinationPath(slug, "projects"));
	await page.getByRole("button", { name: "Create project" }).click();
	const sheet = page.getByRole("dialog", { name: "Create a project" });
	await sheet.getByLabel("Project name").fill(name);
	await sheet.getByRole("button", { name: "Create the project" }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("main")).toContainText(name);
}

/**
 * Makes every day of the week a working day of 7:30 in the organisation with
 * this slug, as its owner, so today is one whatever day the test runs: time
 * on a day not worked is overtime, which no organisation allows until it says
 * so (TS-095). For tests whose timer runs today, which no past day can stand in for.
 */
export async function workEveryDay(page: Page, slug: string) {
	await openShell(page, destinationPath(slug, "settings"));
	await page.getByRole("button", { name: "Change working week" }).click();
	const week = page.getByRole("dialog", { name: "Change the working week" });
	await week.getByLabel("Saturday").fill("7:30");
	await week.getByLabel("Sunday").fill("7:30");
	await week.getByRole("button", { name: "Save" }).click();
	await expect(week).toBeHidden();
	await expect(page.getByRole("status").first()).toHaveText("The working week is saved.");
}

/**
 * The latest Monday to Friday before today in the browser's zone, which the
 * person's becomes: a working day that has passed, whatever day the test
 * runs, so time tracked on it is regular time and never runs past now.
 */
export function pastWeekday(page: Page): Promise<string> {
	return page.evaluate(() => {
		const at = new Date();
		do at.setDate(at.getDate() - 1);
		while (at.getDay() === 0 || at.getDay() === 6);
		return at.toLocaleDateString("en-CA");
	});
}
