import type { Locator, Page } from "@playwright/test";

import { destinationPath, organisationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { contrast, EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";
import { createProject } from "./timesheet";

// Leave and time together in a browser (TS-090), on the person's own time:
// an owner nobody else decides for sets the timesheet rules with the keyboard,
// asks for overtime, asks for annual leave at short notice with a reason, and
// records half a day of sick leave today, which leaves the day 3:45: more is
// refused with the time left, 3:45 fits, and the day then takes no more. A
// whole day of leave closes the day in every view. Then the pages and sheets
// at both window sizes and in both schemes, with no WCAG 2.2 A or AA
// violation. Each test is a new person with an organisation of their own.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS * 2 });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

/** The local date `offset` days from today in UTC. */
function dayFromToday(offset: number): string {
	const at = new Date();
	at.setUTCDate(at.getUTCDate() + offset);
	return at.toISOString().slice(0, 10);
}

/** Presses Tab until `target` has the focus. */
async function tabTo(page: Page, target: Locator, most = 80) {
	for (let step = 0; step < most; step++) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press("Tab");
	}
	throw new Error("Tab never reached the control.");
}

/** What axe leaves unmeasured in a grid that scrolls sideways in a narrow window. */
const PARTLY_SCROLLED_AWAY = "elmPartiallyObscured";

const status = (page: Page) => page.getByRole("status").first();

/** A new owner with an organisation, a project, and every day of the week worked, so today is a working day. */
async function ownerWithWeek(page: Page) {
	await signIn(page, newPerson().email);
	const { slug } = await createOrganisation(page);
	await createProject(page, slug, "Site");
	await openShell(page, destinationPath(slug, "settings"));
	await page.getByRole("button", { name: "Change working week" }).click();
	const week = page.getByRole("dialog", { name: "Change the working week" });
	await week.getByLabel("Saturday").fill("7:30");
	await week.getByLabel("Sunday").fill("7:30");
	await week.getByRole("button", { name: "Save" }).click();
	await expect(week).toBeHidden();
	await expect(status(page)).toHaveText("The working week is saved.");
	return { slug };
}

/** Records sick leave from `first` to `last`, `half` at the start when asked. */
async function recordSickLeave(
	page: Page,
	slug: string,
	first: string,
	last: string,
	half = false,
) {
	await openShell(page, destinationPath(slug, "time-off"));
	await page.getByRole("button", { name: "Request time off" }).click();
	const sheet = page.getByRole("dialog", { name: "Request time off" });
	await sheet.getByRole("button", { name: /Kind of leave/ }).click();
	await page
		.getByRole("listbox", { name: "Kind of leave" })
		.getByRole("option", { name: "Sick leave" })
		.click();
	await expect(sheet).toContainText("Sick leave needs no notice.");
	await sheet.getByRole("textbox", { name: "First day" }).fill(first);
	await sheet.getByRole("textbox", { name: "Last day" }).fill(last);
	if (half) await sheet.getByText("Half a day", { exact: true }).click();
	await sheet.getByRole("button", { name: "Request" }).click();
	await expect(sheet).toBeHidden();
	await expect(status(page)).toHaveText("Recorded. It needs nobody's approval.");
}

test("the owner sets the timesheet rules with the keyboard alone, then asks for overtime, approved as it is sent", async ({
	page,
}) => {
	const { slug } = await ownerWithWeek(page);
	await openShell(page, destinationPath(slug, "settings"));
	const rules = page.getByRole("list", { name: "Timesheet rules" });
	// Overtime is not allowed until an owner or admin says otherwise (TS-095).
	await expect(rules).toContainText("Not allowed");

	await tabTo(page, page.getByRole("button", { name: "Change timesheet rules" }));
	await page.keyboard.press("Enter");
	const sheet = page.getByRole("dialog", { name: "Change the timesheet rules" });
	await expect(sheet).toBeVisible();
	// Arrow keys move the choice within a group of radios.
	const overtime = sheet.getByRole("radiogroup", { name: "Overtime" });
	await tabTo(page, overtime.getByRole("radio", { checked: true }));
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("ArrowDown");
	await expect(overtime.getByRole("radio", { name: "Only with pre-approval" })).toBeChecked();
	await tabTo(page, sheet.getByRole("button", { name: "Save" }));
	await page.keyboard.press("Enter");
	await expect(sheet).toBeHidden();
	await expect(status(page)).toHaveText("The timesheet rules are saved.");
	await expect(rules).toContainText("Only with pre-approval");

	await openShell(page, destinationPath(slug, "time-off"));
	// Time on a day not worked counts as overtime, so weekend work is asked for too.
	await expect(page.getByRole("button", { name: "Request weekend work" })).toBeVisible();
	await page.getByRole("button", { name: "Request overtime" }).click();
	const asking = page.getByRole("dialog", { name: "Request overtime" });
	await asking.getByRole("textbox", { name: "First day" }).fill(dayFromToday(7));
	await asking.getByRole("textbox", { name: "Last day" }).fill(dayFromToday(8));
	await asking.getByRole("textbox", { name: "Hours a day" }).fill("1:30");
	await asking.getByRole("textbox", { name: "Reason (optional)" }).fill("Release week");
	await asking.getByRole("button", { name: "Request" }).click();
	await expect(asking).toBeHidden();
	await expect(status(page)).toHaveText("Approved automatically: nobody else can decide it.");
	await expect(
		page.getByRole("list", { name: "Your requests for overtime and weekend work" }),
	).toContainText("Overtime");
});

test("annual leave at short notice says so, asks why, and is sent with the reason", async ({
	page,
}) => {
	await signIn(page, newPerson().email);
	const { slug } = await createOrganisation(page);
	await openShell(page, destinationPath(slug, "time-off"));
	await page.getByRole("button", { name: "Request time off" }).click();
	const sheet = page.getByRole("dialog", { name: "Request time off" });
	await sheet.getByRole("button", { name: /Kind of leave/ }).click();
	await page
		.getByRole("listbox", { name: "Kind of leave" })
		.getByRole("option", { name: "Annual leave" })
		.click();
	await expect(sheet).toContainText(
		/Annual leave needs 14 days' notice: the earliest well-noticed first day is/,
	);
	await sheet.getByRole("textbox", { name: "First day" }).fill(dayFromToday(5));
	await sheet.getByRole("textbox", { name: "Last day" }).fill(dayFromToday(5));
	await expect(sheet).toContainText(/This is short notice \(\d+ days?\)\./);
	const why = sheet.getByRole("textbox", { name: "Why at short notice?" });
	await expect(why).toBeVisible();
	await why.fill("A family wedding moved forward");
	await sheet.getByRole("button", { name: "Request" }).click();
	await expect(sheet).toBeHidden();
	await expect(status(page)).toHaveText("Approved automatically: nobody else can decide it.");
});

/** Records half a day of sick leave today, the sheet's own first and last day, which are the person's today. */
async function halfDaySickToday(page: Page, slug: string) {
	await openShell(page, destinationPath(slug, "time-off"));
	await page.getByRole("button", { name: "Request time off" }).click();
	const sheet = page.getByRole("dialog", { name: "Request time off" });
	await sheet.getByRole("button", { name: /Kind of leave/ }).click();
	await page
		.getByRole("listbox", { name: "Kind of leave" })
		.getByRole("option", { name: "Sick leave" })
		.click();
	await expect(sheet).toContainText("Sick leave needs no notice.");
	await sheet.getByText("Half a day", { exact: true }).click();
	await sheet.getByRole("button", { name: "Request" }).click();
	await expect(sheet).toBeHidden();
	await expect(status(page)).toHaveText("Recorded. It needs nobody's approval.");
}

const trackTime = (page: Page) => page.getByRole("button", { name: "Track time", exact: true });
const trackSheet = (page: Page) => page.getByRole("dialog", { name: "Track time" });

test("half a day of leave leaves the day 3:45: the Day view shows what is left, and the Week grid refuses more with what is left", async ({
	page,
}) => {
	const { slug } = await ownerWithWeek(page);
	await halfDaySickToday(page, slug);

	await openShell(page, organisationPath(slug));
	await expect(trackTime(page)).toHaveAccessibleDescription("3:45 left of 3:45");
	await trackTime(page).click();
	await trackSheet(page).getByRole("textbox", { name: "Hours" }).fill("1");
	await trackSheet(page).getByRole("button", { name: "Save entry" }).click();
	await expect(trackSheet(page)).toBeHidden();
	await expect(trackTime(page)).toHaveAccessibleDescription("2:45 left of 3:45");

	// The Week grid shows what is left in the cell's name, and refuses more before it
	// sends: the cell's own hour is replaced by what is typed, so 3:45 fits in it.
	await openShell(page, `${organisationPath(slug)}?view=week`);
	const cell = page.getByRole("textbox", { name: /^Site, .*, 2:45 left$/ });
	await cell.fill("4");
	await cell.press("Enter");
	await expect(page.getByRole("alert").filter({ hasText: "left" })).toContainText(
		"This day has 3:45 left.",
	);
	await cell.fill("3:45");
	await cell.press("Enter");
	await expect(page.getByRole("textbox", { name: /^Site, .*, 0:00 left$/ })).toHaveValue("3:45");

	// The day is full: Track time is closed and says so.
	await openShell(page, organisationPath(slug));
	await expect(trackTime(page)).toBeDisabled();
	await expect(trackTime(page)).toHaveAccessibleDescription("This day has 0:00 left.");
});

test("a whole day of leave closes the day: no Track time, no calendar slots", async ({ page }) => {
	const { slug } = await ownerWithWeek(page);
	await recordSickLeave(page, slug, dayFromToday(-1), dayFromToday(1));

	await openShell(page, organisationPath(slug));
	await expect(trackTime(page)).toBeDisabled();
	await expect(trackTime(page)).toHaveAccessibleDescription(
		"You are on sick leave that day: no time can be tracked on it.",
	);

	await openShell(page, `${organisationPath(slug)}?view=calendar`);
	const grid = page.getByRole("table", { name: /^Week calendar, / });
	await expect(grid.getByRole("button", { name: /^New entry, / }).first()).toBeAttached();
	const long = new Intl.DateTimeFormat("en-GB", {
		weekday: "long",
		day: "numeric",
		month: "long",
		timeZone: "UTC",
	});
	for (const offset of [-1, 0, 1]) {
		const words = long.format(new Date(`${dayFromToday(offset)}T00:00:00Z`));
		await expect(grid.getByRole("button", { name: `New entry, ${words}, from 09:00` })).toHaveCount(
			0,
		);
	}
});

/** `unmeasurable`: what axe may leave unmeasured, such as an empty field. */
async function expectNoProblems(page: Page, heading: string, unmeasurable: string[] = []) {
	await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
	expect(await problems(page, unmeasurable), `problems in "${heading}"`).toEqual([]);
}

async function expectNoProblemsInSheet(page: Page, sheet: Locator, text: Locator) {
	await expect(sheet).toBeVisible();
	expect(
		await problems(page, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS, EMPTY_INPUT]),
		"problems with the sheet open",
	).toEqual([]);
	expect(await contrast(text), "contrast of the sheet's text").toBeGreaterThanOrEqual(4.5);
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

			test("the timesheet rules, overtime on Time off, and a day's limit and overage on the Timesheet", async ({
				page,
			}) => {
				const { slug } = await ownerWithWeek(page);

				await openShell(page, destinationPath(slug, "settings"));
				await page.getByRole("button", { name: "Change timesheet rules" }).click();
				const rules = page.getByRole("dialog", { name: "Change the timesheet rules" });
				await expectNoProblemsInSheet(
					page,
					rules,
					rules.getByText("Not allowed", { exact: true }).first(),
				);
				await page.getByRole("button", { name: "Change timesheet rules" }).click();
				await rules
					.getByRole("radiogroup", { name: "Overtime" })
					.getByText("Only with pre-approval", { exact: true })
					.click();
				await rules.getByRole("button", { name: "Save" }).click();
				await expect(rules).toBeHidden();
				await expectNoProblems(page, "Workspace settings");

				await openShell(page, destinationPath(slug, "time-off"));
				await page.getByRole("button", { name: "Request overtime" }).click();
				const asking = page.getByRole("dialog", { name: "Request overtime" });
				await expectNoProblemsInSheet(page, asking, asking.getByText("Hours a day").first());

				await page.getByRole("button", { name: "Request time off" }).click();
				const sheet = page.getByRole("dialog", { name: "Request time off" });
				await sheet.getByRole("button", { name: /Kind of leave/ }).click();
				await page
					.getByRole("listbox", { name: "Kind of leave" })
					.getByRole("option", { name: "Annual leave" })
					.click();
				await sheet.getByRole("textbox", { name: "First day" }).fill(dayFromToday(3));
				await expect(sheet.getByRole("textbox", { name: "Why at short notice?" })).toBeVisible();
				await expectNoProblemsInSheet(
					page,
					sheet,
					sheet.getByText(/^This is short notice/).first(),
				);
				await expectNoProblems(page, "Time off", [EMPTY_INPUT]);

				// Track 7:30 today, then record half a day of sick leave: the day is over by 3:45.
				await openShell(page, organisationPath(slug));
				await trackTime(page).click();
				await trackSheet(page).getByRole("textbox", { name: "Hours" }).fill("7:30");
				await trackSheet(page).getByRole("button", { name: "Save entry" }).click();
				await expect(trackSheet(page)).toBeHidden();
				await halfDaySickToday(page, slug);
				await openShell(page, organisationPath(slug));
				await expect(page.getByRole("main")).toContainText("Over by 3:45");
				await expect(page.getByRole("button", { name: "Submit week" })).toBeDisabled();
				await expectNoProblems(page, "Timesheet");

				await openShell(page, `${organisationPath(slug)}?view=week`);
				await expect(page.getByRole("main")).toContainText("Over by 3:45");
				// Where the grid is wider than the window it scrolls, and axe cannot measure what the scroll hides.
				await expectNoProblems(page, "Timesheet", [EMPTY_INPUT, PARTLY_SCROLLED_AWAY]);

				await openShell(page, `${organisationPath(slug)}?view=calendar`);
				await expect(page.getByRole("main")).toContainText("Over by 3:45");
				await expectNoProblems(page, "Timesheet", [PARTLY_SCROLLED_AWAY]);
			});
		});
	}
}
