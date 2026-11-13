import type { Page } from "@playwright/test";

import { accountPath, destinationPath } from "../app/shell/destinations";
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
 * It then waits for the person's zone to be the browser's (`zoneIsTheBrowsers`),
 * so today on the server is today in the browser.
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
	await zoneIsTheBrowsers(page, slug);
}

/**
 * Waits until the signed-in person's own zone is the browser's: the shell
 * sends the browser's zone while the person has none (TS-012a), and until it
 * arrives their days are counted in the organisation's, which is UTC.
 */
export async function zoneIsTheBrowsers(page: Page, slug: string) {
	await openShell(page, accountPath(slug));
	const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
	const main = page.getByRole("main");
	await expect(main).not.toContainText("until you choose one");
	await expect(main).toContainText(zone);
}

/** The latest Monday to Friday before `now`'s day in the zone `now` is read in. */
export function weekdayBefore(now: Date): Date {
	const at = new Date(now);
	do at.setDate(at.getDate() - 1);
	while (at.getDay() === 0 || at.getDay() === 6);
	return at;
}

/**
 * The latest Monday to Friday before today in the browser's zone, which the
 * person's becomes: a working day that has passed, whatever day and hour the
 * test runs, so time tracked on it is regular time and never runs past now.
 * On a Monday it is the Friday before, in the week before: a test that reads
 * its week opens that week (`mondayOf`), never this one.
 */
export function pastWeekday(page: Page): Promise<string> {
	return page.evaluate(`(${weekdayBefore.toString()})(new Date()).toLocaleDateString("en-CA")`);
}

/** The Monday of the week of `day`, a date as an address writes it: the start of its week. */
export function mondayOf(day: string): string {
	const at = new Date(`${day}T00:00:00Z`);
	at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7));
	return at.toISOString().slice(0, 10);
}

/**
 * A zone where `now` is early afternoon, 12:00 to 15:59, on the same date as
 * in UTC, the zone of a new organisation. For a test that must track hours
 * today, as a rate set from today prices only them: in a browser in this zone,
 * the person's today has at least 12 hours behind it and 8 ahead, whatever
 * hour the run is at. Typed hours never run past now (audit W08), so today
 * just after midnight has room for none. UTC itself when it is afternoon there.
 */
export function afternoonZone(now = new Date()): string {
	const utcDate = now.toISOString().slice(0, 10);
	for (const zone of ["UTC", ...Intl.supportedValuesOf("timeZone")]) {
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: zone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			hourCycle: "h23",
		}).formatToParts(now);
		const part = (type: Intl.DateTimeFormatPartTypes) =>
			parts.find((each) => each.type === type)?.value;
		const hour = Number(part("hour"));
		const date = `${part("year")}-${part("month")}-${part("day")}`;
		if (date === utcDate && hour >= 12 && hour < 16) return zone;
	}
	throw new Error(`No zone is in the afternoon of ${utcDate} at ${now.toISOString()}.`);
}
