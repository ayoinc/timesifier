import type { Locator, Page } from "@playwright/test";

import { organisationPath, schedulesPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";
import { createProject, pastWeekday } from "./timesheet";

// Work schedules in a browser (TS-097), on the person's own organisation: an
// owner opens Settings › Work schedules, adds "Early" (07:00 to 15:00, half an
// hour's break, Monday to Friday) with the times typed, gives it to
// themselves from today with the keyboard alone, and sees it hold: the Day
// view and the Week view's header say the day's hours, the week calendar
// draws them, and My account shows the schedule, why it is theirs, read
// only. Then axe at 390px and 1280px in both schemes on the page and its
// sheets. Each test is a new person with an organisation of their own.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS * 2 });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

const status = (page: Page) => page.getByRole("status").first();
const main = (page: Page) => page.getByRole("main");

/** Presses Tab until `target` has the focus. */
async function tabTo(page: Page, target: Locator, most = 120) {
	for (let step = 0; step < most; step++) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press("Tab");
	}
	throw new Error("Tab never reached the control.");
}

/** A new owner with an organisation and a project, Site, and the latest weekday before today. */
async function owner(page: Page) {
	await signIn(page, newPerson().email);
	const { slug } = await createOrganisation(page);
	await createProject(page, slug, "Site");
	return { slug, day: await pastWeekday(page) };
}

/** Adds "Early", 07:00 to 15:00 with a 30 minute break on Monday to Friday, its times typed. */
async function addEarly(page: Page, slug: string) {
	await openShell(page, schedulesPath(slug));
	await page.getByRole("button", { name: "New schedule" }).click();
	const sheet = page.getByRole("dialog", { name: "New schedule" });
	await sheet.getByLabel("Name").fill("Early");
	for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
		await sheet.getByLabel(`${day} start`).fill("07:00");
		await sheet.getByLabel(`${day} finish`).fill("15:00");
		await sheet.getByLabel(`${day} break (minutes)`).fill("30");
	}
	await sheet.getByRole("button", { name: "Save" }).click();
	await expect(sheet).toBeHidden();
	await expect(status(page)).toHaveText("Early is added. Assign it to give it to people.");
	await expect(page.getByRole("list", { name: "Schedules" })).toContainText(
		"Monday to Friday, 07:00–15:00 · 37:30 a week",
	);
}

/** Gives Early to the signed-in person from today, with the keyboard alone. */
async function assignEarlyToSelf(page: Page) {
	const people = page.getByRole("list", { name: "People" });
	const assign = people.getByRole("button", { name: /^Assign a schedule to / }).first();
	await tabTo(page, assign);
	await page.keyboard.press("Enter");
	const sheet = page.getByRole("dialog", { name: /^Assign a schedule to / });
	await expect(sheet).toBeVisible();
	const schedule = sheet.getByRole("button", { name: /Schedule/ });
	await tabTo(page, schedule);
	await page.keyboard.press("Enter");
	const options = page.getByRole("listbox", { name: "Schedule" });
	await expect(options).toBeVisible();
	await page.keyboard.type("Early");
	await page.keyboard.press("Enter");
	await expect(options).toBeHidden();
	await tabTo(page, sheet.getByRole("button", { name: "Assign" }));
	await page.keyboard.press("Enter");
	await expect(sheet).toBeHidden();
	await expect(status(page)).toContainText("Assigned from");
	await expect(people).toContainText("Early: Monday to Friday, 07:00–15:00 · 37:30 a week");
	await expect(people).toContainText("Assigned to them.");
}

test("an owner adds a schedule, gives it to themselves with the keyboard, and it holds on their days", async ({
	page,
}) => {
	const { slug } = await owner(page);
	// Workspace settings sums up the default and leads to the page.
	await openShell(page, `${organisationPath(slug)}/settings`);
	await expect(main(page)).toContainText("Everyone without another schedule");
	await main(page).getByRole("link", { name: "Work schedules" }).click();
	await expect(page.getByRole("heading", { level: 1, name: "Work schedules" })).toBeVisible();
	await expect(page.getByRole("list", { name: "Schedules" })).toContainText("Standard (default)");

	await addEarly(page, slug);
	await assignEarlyToSelf(page);

	// From today: the Day view, the Week view's header and the week calendar.
	const today = await page.evaluate(() => new Date().toLocaleDateString("en-CA"));
	const weekday = await page.evaluate(() => [0, 6].includes(new Date().getDay()) === false);
	await openShell(page, `${organisationPath(slug)}?day=${today}`);
	if (weekday) {
		await expect(main(page)).toContainText("07:00–15:00, 7:30 expected.");
		await openShell(page, `${organisationPath(slug)}?view=week&start=${today}`);
		await expect(
			page.getByRole("columnheader").filter({ hasText: "07:00–15:00" }).first(),
		).toBeVisible();
		await openShell(page, `${organisationPath(slug)}?view=calendar&date=${today}`);
		await expect(page.locator('[data-working-hours="07:00–15:00"]').first()).toBeAttached();
	} else {
		await expect(main(page)).toContainText("Not a working day");
	}

	// My account: the schedule, why, and nothing to change it with.
	await openShell(page, `${organisationPath(slug)}/account`);
	const mine = page.getByRole("list", { name: "Your work schedule" });
	await expect(mine).toContainText("Monday07:00–15:00, 0:30 break · 7:30");
	await expect(main(page)).toContainText(
		"Early: Monday to Friday, 07:00–15:00 · 37:30 a week. Assigned to you.",
	);
	await expect(main(page).getByRole("button", { name: /schedule/i })).toHaveCount(0);
});

test("a day that finishes before it starts is refused in the sheet, which stays open", async ({
	page,
}) => {
	const { slug } = await owner(page);
	await openShell(page, schedulesPath(slug));
	await page.getByRole("button", { name: "New schedule" }).click();
	const sheet = page.getByRole("dialog", { name: "New schedule" });
	await sheet.getByLabel("Name").fill("Backwards");
	await sheet.getByLabel("Monday start").fill("17:00");
	await sheet.getByLabel("Monday finish").fill("09:00");
	await sheet.getByRole("button", { name: "Save" }).click();
	await expect(sheet.getByRole("alert")).toHaveText(
		"Monday finishes before it starts. A day ends by midnight.",
	);
	await expect(sheet).toBeVisible();
});

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });

			test("axe finds nothing on Work schedules, its sheets, and the schedule on My account", async ({
				page,
			}) => {
				const { slug, day } = await owner(page);
				await addEarly(page, slug);
				expect(await problems(page), "Work schedules").toEqual([]);

				await page.getByRole("button", { name: "Change Early" }).click();
				const sheet = page.getByRole("dialog", { name: "Change Early" });
				await expect(sheet.getByLabel("Monday start")).toHaveValue("07:00");
				expect(
					await problems(page, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS, EMPTY_INPUT]),
					"the schedule's sheet",
				).toEqual([]);
				await page.keyboard.press("Escape");
				await expect(sheet).toBeHidden();

				await page.getByRole("button", { name: "Assign a schedule to the organisation" }).click();
				const assign = page.getByRole("dialog", { name: /^Assign a schedule to / });
				await expect(assign).toBeVisible();
				expect(
					await problems(page, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS, EMPTY_INPUT]),
					"the Assign sheet",
				).toEqual([]);
				await page.keyboard.press("Escape");
				await expect(assign).toBeHidden();

				await openShell(page, `${organisationPath(slug)}/account`);
				await expect(page.getByRole("list", { name: "Your work schedule" })).toBeVisible();
				expect(await problems(page), "My account").toEqual([]);

				await openShell(page, `${organisationPath(slug)}?view=calendar&date=${day}`);
				await expect(page.locator("[data-working-hours]").first()).toBeAttached();
				expect(await problems(page), "the week calendar's working hours").toEqual([]);
			});
		});
	}
}
