import type { Locator, Page } from "@playwright/test";

import { destinationPath, organisationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";
import { createProject, pastWeekday } from "./timesheet";

// Expected hours as a ceiling, overtime as its own field, in a browser
// (TS-095), on the person's own time: where an owner allows overtime, a day
// whose 7:30 is tracked asks for Overtime in Track time, the keyboard alone
// doing it; the Day view marks the entry and reads its total apart, the Week
// grid has an overtime row whose cell takes typed hours, and both calendars
// say how much of a day is overtime. Where overtime is not allowed, as in
// every organisation until it says so, the full day takes no more and the
// Week grid has no overtime row. Then axe at 390px and 1280px in both
// schemes. Time is tracked on the latest weekday before today, a working day
// that has passed, whatever day the run is on. Each test is a new person with
// an organisation of their own.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS * 2 });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

/** Presses Tab until `target` has the focus. */
async function tabTo(page: Page, target: Locator, most = 80) {
	for (let step = 0; step < most; step++) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press("Tab");
	}
	throw new Error("Tab never reached the control.");
}

/** The Monday of the week `day` is in: the start of the Week view's period, whose weeks start on Monday. */
function mondayOf(day: string): string {
	const at = new Date(`${day}T00:00:00Z`);
	at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7));
	return at.toISOString().slice(0, 10);
}

/** Where `day` is in its week from Monday: 0 to 6. */
const columnOf = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;

const status = (page: Page) => page.getByRole("status").first();
const main = (page: Page) => page.getByRole("main");
const trackTime = (page: Page) =>
	main(page).getByRole("button", { name: "Track time", exact: true });
const trackSheet = (page: Page) => page.getByRole("dialog", { name: "Track time" });
const dayPath = (slug: string, day: string) => `${organisationPath(slug)}?day=${day}`;
const weekPath = (slug: string, day: string) =>
	`${organisationPath(slug)}?view=week&start=${mondayOf(day)}`;
/** The cell of the Week grid of `day` in the overtime row of the one project. */
const overtimeCell = (page: Page, day: string) =>
	page.locator('tr[data-row$=":overtime"] td').nth(columnOf(day)).getByRole("textbox");

/** A new owner with an organisation and a project, Site; the working week is Monday to Friday, 7:30 a day. */
async function owner(page: Page) {
	await signIn(page, newPerson().email);
	const { slug } = await createOrganisation(page);
	await createProject(page, slug, "Site");
	return { slug, day: await pastWeekday(page) };
}

/** Allows overtime with no cap, through Settings › Timesheet rules, with a pointer. */
async function allowOvertime(page: Page, slug: string) {
	await openShell(page, destinationPath(slug, "settings"));
	await page.getByRole("button", { name: "Change timesheet rules" }).click();
	const sheet = page.getByRole("dialog", { name: "Change the timesheet rules" });
	await sheet
		.getByRole("radiogroup", { name: "Overtime" })
		.getByText("Allowed", { exact: true })
		.click();
	await sheet.getByRole("button", { name: "Save" }).click();
	await expect(sheet).toBeHidden();
	await expect(status(page)).toHaveText("The timesheet rules are saved.");
}

/** Tracks `hours` on `day` through Track time on its Day view, in the field named `field`. */
async function track(page: Page, slug: string, day: string, field: string, hours: string) {
	await openShell(page, dayPath(slug, day));
	await trackTime(page).click();
	const sheet = trackSheet(page);
	await sheet.getByRole("textbox", { name: field, exact: true }).fill(hours);
	await sheet.getByRole("button", { name: "Save entry" }).click();
	await expect(sheet).toBeHidden();
}

test("where overtime is allowed, a full day asks for Overtime, the keyboard alone doing it; Day, Week and Calendar show it apart", async ({
	page,
}) => {
	const { slug, day } = await owner(page);

	// The owner allows overtime with the keyboard: arrows move the choice within the radios.
	await openShell(page, destinationPath(slug, "settings"));
	await tabTo(page, page.getByRole("button", { name: "Change timesheet rules" }));
	await page.keyboard.press("Enter");
	const rules = page.getByRole("dialog", { name: "Change the timesheet rules" });
	const overtime = rules.getByRole("radiogroup", { name: "Overtime" });
	await tabTo(page, overtime.getByRole("radio", { checked: true }));
	await page.keyboard.press("ArrowDown");
	await expect(overtime.getByRole("radio", { name: "Allowed", exact: true })).toBeChecked();
	await tabTo(page, rules.getByRole("button", { name: "Save" }));
	await page.keyboard.press("Enter");
	await expect(rules).toBeHidden();
	await expect(status(page)).toHaveText("The timesheet rules are saved.");

	// The day's 7:30, then Track time asks for Overtime, and says why.
	await openShell(page, dayPath(slug, day));
	await tabTo(page, trackTime(page));
	await page.keyboard.press("Enter");
	const sheet = trackSheet(page);
	const hours = sheet.getByRole("textbox", { name: "Hours", exact: true });
	await tabTo(page, hours);
	await hours.fill("7:30");
	await hours.press("Enter");
	await expect(sheet).toBeHidden();

	await tabTo(page, trackTime(page));
	await page.keyboard.press("Enter");
	await expect(sheet.getByRole("textbox", { name: "Hours", exact: true })).toHaveCount(0);
	await expect(sheet).toContainText(
		"This day's 7:30 of regular time is tracked: more is overtime.",
	);
	const extra = sheet.getByRole("textbox", { name: "Overtime", exact: true });
	await tabTo(page, extra);
	await extra.fill("1");
	await extra.press("Enter");
	await expect(sheet).toBeHidden();

	// The Day view marks the entry and reads its total apart.
	const entries = main(page).getByRole("list", { name: "Entries" });
	await expect(entries.getByText("Overtime", { exact: true })).toHaveCount(1);
	await expect(main(page)).toContainText("7:30 + 1:00 overtime");

	// The Week grid: an overtime row under the project's, its day's cell 1:00, typed to 1:30.
	await openShell(page, weekPath(slug, day));
	await expect(page.getByRole("rowheader", { name: "Site, Overtime" })).toBeVisible();
	const cell = overtimeCell(page, day);
	await expect(cell).toHaveValue("1:00");
	await expect(cell).toHaveAccessibleName(/^Site, overtime, /);
	await tabTo(page, cell, 120);
	await cell.fill("1:30");
	await cell.press("Enter");
	await expect(page.getByRole("status").filter({ hasText: "Saved." }).first()).toBeAttached();
	await openShell(page, weekPath(slug, day));
	await expect(overtimeCell(page, day)).toHaveValue("1:30");
	await expect(main(page)).toContainText("1:30 overtime");

	// The calendars say how much of the day is overtime.
	await openShell(page, `${organisationPath(slug)}?view=calendar&date=${day}`);
	await expect(page.getByRole("table", { name: /^Week calendar, / })).toContainText(
		"1:30 overtime",
	);
	await expect(main(page).getByRole("button", { name: /, 1:30, overtime, edit$/ })).toBeVisible();
	await openShell(page, `${organisationPath(slug)}?view=calendar&scale=month&date=${day}`);
	await expect(main(page).getByRole("link", { name: /9:00, 1:30 of it overtime/ })).toBeVisible();
});

test("where overtime is not allowed, a full day takes no more, and the Week grid has no overtime row", async ({
	page,
}) => {
	const { slug, day } = await owner(page);
	await track(page, slug, day, "Hours", "7:30");

	await expect(trackTime(page)).toBeDisabled();
	await expect(trackTime(page)).toHaveAccessibleDescription("This day has 0:00 left.");

	await openShell(page, weekPath(slug, day));
	await expect(page.getByRole("rowheader", { name: "Site, Overtime" })).toHaveCount(0);
	const regular = page.locator('tr[data-row]:not([data-row$=":overtime"]) td').nth(columnOf(day));
	const cell = regular.getByRole("textbox");
	await cell.fill("8");
	await cell.press("Enter");
	await expect(page.getByRole("alert").filter({ hasText: "left" })).toContainText(
		"This day has 7:30 left.",
	);
});

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });

			test("axe finds nothing with Track time asking for Overtime, an overtime entry, the Week grid's overtime row and the calendars", async ({
				page,
			}) => {
				const { slug, day } = await owner(page);
				await allowOvertime(page, slug);
				await track(page, slug, day, "Hours", "7:30");
				await track(page, slug, day, "Overtime", "1");

				await openShell(page, dayPath(slug, day));
				await expect(main(page)).toContainText("7:30 + 1:00 overtime");
				expect(await problems(page), "the Day view").toEqual([]);

				await trackTime(page).click();
				const sheet = trackSheet(page);
				await expect(sheet.getByRole("textbox", { name: "Overtime", exact: true })).toBeVisible();
				expect(
					await problems(page, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS, EMPTY_INPUT]),
					"Track time asking for Overtime",
				).toEqual([]);
				await page.keyboard.press("Escape");
				await expect(sheet).toBeHidden();

				await openShell(page, weekPath(slug, day));
				await expect(overtimeCell(page, day)).toHaveValue("1:00");
				expect(
					await problems(page, ["elmPartiallyObscured", EMPTY_INPUT]),
					"the Week grid",
				).toEqual([]);

				await openShell(page, `${organisationPath(slug)}?view=calendar&date=${day}`);
				await expect(page.getByRole("table", { name: /^Week calendar, / })).toContainText(
					"1:00 overtime",
				);
				expect(await problems(page), "the week calendar").toEqual([]);

				await openShell(page, `${organisationPath(slug)}?view=calendar&scale=month&date=${day}`);
				await expect(main(page).getByRole("link", { name: /1:00 of it overtime/ })).toBeVisible();
				expect(await problems(page), "the month calendar").toEqual([]);
			});
		});
	}
}
