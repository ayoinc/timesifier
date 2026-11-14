import type { Locator, Page } from "@playwright/test";

import { organisationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import {
	DIGIT_CHANGING,
	EMPTY_INPUT,
	OVER_SEVERAL_ELEMENTS,
	problems,
	UNDER_AN_OVERLAY,
} from "./axe";
import { expect, openShell, takenOver, test } from "./fixtures";
import { createOrganisation } from "./organisation";
import { createProject, mondayOf, pastWeekday, workEveryDay, zoneIsTheBrowsers } from "./timesheet";

// The Calendar view of Timesheet in a browser (TS-062): the week on an hour
// axis and the month of days, their totals against the Day and Week views',
// the zoom by its control and by - and +, Previous, Today and Next, a block
// that opens its entry and a slot that tracks time from its start, the
// keyboard alone, and axe at 390px and 1280px in both schemes.
// Each test is a new person with an organisation of their own.

const COMPACT = { width: 390, height: 844 };
const MEDIUM = { width: 1280, height: 800 };

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

/**
 * Signs a new person in, with an organisation and a project, Site, and two
 * hours tracked from 09:00 on the latest weekday before today: on a day that
 * has passed, so the time never runs past now whatever the hour of the run
 * (TS-091, W08), and a working day, so the time is regular time whatever day
 * the run is on (TS-095). `day` is that day, which the week and month are opened at.
 */
async function personWithTime(page: Page) {
	await signIn(page, newPerson().email);
	const organisation = await createOrganisation(page);
	await createProject(page, organisation.slug, "Site");
	await zoneIsTheBrowsers(page, organisation.slug);
	const day = await pastWeekday(page);
	await openShell(page, `${organisationPath(organisation.slug)}?day=${day}`);
	await page.getByRole("button", { name: "Track time", exact: true }).click();
	const sheet = trackSheet(page);
	await sheet.getByRole("textbox", { name: "Hours" }).fill("2");
	await sheet.getByRole("button", { name: "Save entry" }).click();
	await expect(sheet).toBeHidden();
	return { ...organisation, day };
}

const trackSheet = (page: Page) => page.getByRole("dialog", { name: "Track time" });
const editSheet = (page: Page) => page.getByRole("dialog", { name: "Edit entry" });
const views = (page: Page) => page.getByRole("group", { name: "Timesheet views" });
const weekGrid = (page: Page) => page.getByRole("table", { name: /^Week calendar, / });
const monthGrid = (page: Page) => page.getByRole("table", { name: /^Month calendar, / });
const zoom = (page: Page) => page.getByRole("group", { name: "Zoom" });
/** Today's head in the week calendar, or today in the month: the link marked as today's date. */
const todayLink = (grid: Locator) => grid.locator('a[aria-current="date"]');
/** The head of `day` in the week calendar, or `day` in the month: the link that opens its Day view. */
const dayLink = (grid: Locator, day: string) => grid.locator(`a[href$="?day=${day}"]`);
const focused = (page: Page) => page.locator(":focus");
/** Waits for the focus to be in `container`, or on it: a sheet takes Escape once it is. */
async function focusIn(container: Locator) {
	await expect
		.poll(() => container.evaluate((element) => element.contains(document.activeElement)))
		.toBe(true);
}

/** A day's date as the calendar writes it for assistive technology: `Wednesday 11 November`. */
async function dayInWords(link: Locator) {
	const text = (await link.locator(".sr-only").first().textContent()) ?? "";
	return text
		.trim()
		.replace(/^Today, /, "")
		.replace(/,$/, "");
}

/** Presses Tab until `target` has the focus. */
async function tabTo(page: Page, target: Locator, most = 80) {
	for (let step = 0; step < most; step++) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press("Tab");
	}
	throw new Error("Tab never reached the control.");
}

test("the week calendar shows each entry as a block with the Week view's totals; a block opens Edit entry, and a slot tracks time from its start", async ({
	page,
}) => {
	const { slug, day } = await personWithTime(page);
	await views(page).getByRole("link", { name: "Calendar" }).click();
	await expect(page).toHaveURL(new RegExp(`${organisationPath(slug)}\\?view=calendar$`));
	// The week of the day with time, which on a Monday is the week before this one.
	await openShell(page, `${organisationPath(slug)}?view=calendar&date=${day}`);

	const grid = weekGrid(page);
	await expect(grid.getByRole("columnheader", { name: "Week total 2:00" })).toBeVisible();
	await expect(dayLink(grid, day)).toContainText("2:00");
	const yesterday = await dayInWords(dayLink(grid, day));

	// The block, from 09:00 to 11:00, opens its entry; the edit moves its end.
	await grid.getByRole("button", { name: "Site, 09:00–11:00, 2:00, edit" }).click();
	await expect(editSheet(page).getByLabel("Start")).toHaveValue("09:00");
	await editSheet(page).getByLabel("End").fill("11:30");
	await editSheet(page).getByRole("button", { name: "Save" }).click();
	await expect(editSheet(page)).toBeHidden();
	await expect(page.getByRole("main").getByRole("status")).toHaveText("Entry saved.");
	await expect(grid.getByRole("columnheader", { name: "Week total 2:30" })).toBeVisible();

	// The slot at 14:00 opens Track time from 14:00.
	await grid.getByRole("button", { name: `New entry, ${yesterday}, from 14:00` }).click();
	const sheet = trackSheet(page);
	await expect(sheet.getByLabel("Start")).toHaveValue("14:00");
	await expect(sheet.getByRole("button", { name: "Save entry" })).toBeVisible();
	await sheet.getByRole("textbox", { name: "Hours" }).fill("1");
	await sheet.getByRole("button", { name: "Save entry" }).click();
	await expect(sheet).toBeHidden();
	await expect(grid.getByRole("button", { name: "Site, 14:00–15:00, 1:00, edit" })).toBeVisible();
	await expect(dayLink(grid, day)).toContainText("3:30");

	// The Week view of that week adds up the same. It is opened at the day's week,
	// which on a Monday is the week before: the views' Week link opens this one.
	await openShell(page, `${organisationPath(slug)}?view=week&start=${mondayOf(day)}`);
	await expect(page.getByRole("table").getByText("3:30").last()).toBeVisible();
});

test("zooms from the week in detail out to the week and the month, and in to the Day view, by its control and by - and +, the address keeping it", async ({
	page,
}) => {
	const { slug } = await personWithTime(page);
	const base = `${organisationPath(slug)}\\?view=calendar`;
	await openShell(page, `${organisationPath(slug)}?view=calendar`);
	await expect(zoom(page)).toContainText("Week in detail");

	await page.keyboard.press("-");
	await expect(page).toHaveURL(new RegExp(`${base}&date=\\d{4}-\\d{2}-\\d{2}&zoom=compact$`));
	await expect(zoom(page)).toContainText("Week");
	await expect(weekGrid(page)).toBeVisible();

	await zoom(page).getByRole("button", { name: "Zoom out" }).click();
	await expect(page).toHaveURL(new RegExp(`${base}&scale=month&date=\\d{4}-\\d{2}-\\d{2}$`));
	await expect(monthGrid(page)).toBeVisible();
	await expect(zoom(page).getByRole("button", { name: "Zoom out" })).toBeDisabled();
	// The month is read back from the address alone. Its keys work once the
	// page is hydrated: the server's page shows the month before that.
	await page.reload();
	await takenOver(page);
	await expect(monthGrid(page)).toBeVisible();

	await page.keyboard.press("+");
	await expect(page).toHaveURL(/zoom=compact$/);
	await zoom(page).getByRole("button", { name: "Zoom in" }).click();
	await expect(page).toHaveURL(new RegExp(`${base}&date=\\d{4}-\\d{2}-\\d{2}$`));
	await expect(zoom(page)).toContainText("Week in detail");
	await zoom(page).getByRole("button", { name: "Zoom in" }).click();
	await expect(page).toHaveURL(new RegExp(`${organisationPath(slug)}\\?day=\\d{4}-\\d{2}-\\d{2}$`));
	await expect(page.getByRole("button", { name: "Track time", exact: true })).toBeVisible();
});

test("the week opens at the working hours; compact, the whole day is in view", async ({ page }) => {
	const { slug, day } = await personWithTime(page);
	await openShell(page, `${organisationPath(slug)}?view=calendar&date=${day}`);
	const scroller = weekGrid(page).locator("..");
	expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
	await expect(weekGrid(page).getByRole("button", { name: /^Site, 09:00–11:00/ })).toBeInViewport();

	await zoom(page).getByRole("button", { name: "Zoom out" }).click();
	await expect(page).toHaveURL(/zoom=compact$/);
	const fits = await scroller.evaluate((element) => element.scrollHeight <= element.clientHeight);
	expect(fits).toBe(true);
});

test("the month shows each day's total, today marked and the month's total; Previous, Next and Today step by month; a day opens the Day view and a week the week calendar", async ({
	page,
}) => {
	const { slug, day } = await personWithTime(page);
	await openShell(page, `${organisationPath(slug)}?view=calendar&scale=month&date=${day}`);
	const grid = monthGrid(page);
	await expect(dayLink(grid, day)).toContainText("2:00");
	await expect(page.getByText(/^Month total/)).toContainText("2:00");
	await expect(grid.getByRole("link", { name: /^Week of .*, 2:00$/ })).toHaveCount(1);

	const months = page.getByRole("group", { name: "Months" });
	await months.getByRole("link", { name: "Next month" }).click();
	await expect(page).toHaveURL(/scale=month&date=\d{4}-\d{2}-01$/);
	await expect(page.getByText(/^Month total/)).toBeVisible();
	await expect(page.getByText(/^Month total/)).toContainText("0:00");
	// Each step waits for its page: a press made while the last step's view
	// transition plays lands on the transition's picture and is lost.
	for (const _ of [1, 2]) {
		const before = page.url();
		await months.getByRole("link", { name: "Previous month" }).click();
		await expect(page).not.toHaveURL(before);
	}
	await months.getByRole("link", { name: "Back to this month" }).click();
	await expect(page).toHaveURL(
		new RegExp(`${organisationPath(slug)}\\?view=calendar&scale=month$`),
	);
	await expect(todayLink(grid)).toBeVisible();

	// The month of the day with time, opened on its first.
	await openShell(page, `${organisationPath(slug)}?view=calendar&scale=month&date=${day}`);
	await grid.getByRole("link", { name: /^Week of .*, 2:00$/ }).click();
	await expect(page).toHaveURL(/view=calendar&date=\d{4}-\d{2}-\d{2}$/);
	await expect(weekGrid(page)).toBeVisible();
	await page.goBack();
	await dayLink(monthGrid(page), day).click();
	await expect(page).toHaveURL(new RegExp(`\\?day=${day}$`));
});

test("the week steps by week, and Today returns", async ({ page }) => {
	const { slug, day } = await personWithTime(page);
	// From the week of the day with time, so the week before it has none, whatever day the run is on.
	await openShell(page, `${organisationPath(slug)}?view=calendar&date=${day}&zoom=compact`);
	const weeks = page.getByRole("group", { name: "Weeks" });
	await weeks.getByRole("link", { name: "Previous week" }).click();
	await expect(page).toHaveURL(/view=calendar&date=\d{4}-\d{2}-\d{2}&zoom=compact$/);
	await expect(todayLink(weekGrid(page))).toHaveCount(0);
	await expect(weekGrid(page).getByRole("columnheader", { name: "Week total 0:00" })).toBeVisible();
	await weeks.getByRole("link", { name: "Back to this week" }).click();
	await expect(page).toHaveURL(/view=calendar&zoom=compact$/);
	await expect(todayLink(weekGrid(page))).toBeVisible();
});

test("with the keyboard alone: arrows move between days, Enter opens a day, a slot and an entry", async ({
	page,
}) => {
	const { slug, day } = await personWithTime(page);
	await openShell(page, `${organisationPath(slug)}?view=calendar&scale=month`);

	// The month takes one stop of Tab, on today.
	const grid = monthGrid(page);
	await tabTo(page, todayLink(grid));
	const todayName = await focused(page).getAttribute("aria-current");
	expect(todayName).toBe("date");
	await page.keyboard.press("End");
	await expect(focused(page)).toHaveAccessibleName(/^Week of /);
	await page.keyboard.press("Home");
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("ArrowLeft");
	await page.keyboard.press("ArrowUp");
	const first = await focused(page).getAttribute("href");
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(new RegExp(`${first?.replace("?", "\\?")}$`));

	// The week: from the head of the day with time, along the heads and down into the day.
	await openShell(page, `${organisationPath(slug)}?view=calendar&date=${day}`);
	const week = weekGrid(page);
	// The week takes one stop of Tab, on today's head or its first day's; the
	// arrows lead along the heads to the day's.
	await tabTo(page, week.locator('a[tabindex="0"]').first());
	for (let step = 0; step < 7; step++) {
		const at = (await focused(page).getAttribute("href"))?.split("?day=")[1] ?? "";
		if (at === day) break;
		await page.keyboard.press(at < day ? "ArrowRight" : "ArrowLeft");
	}
	await expect(dayLink(week, day)).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(focused(page)).toHaveAccessibleName(/^New entry, .*, from 08:00$|^Site, 09:00/);
	for (let step = 0; step < 6; step++) {
		const id = await focused(page).getAttribute("data-focus-id");
		if (id?.startsWith("slot:")) await page.keyboard.press("ArrowDown");
	}
	await expect(focused(page)).toHaveAccessibleName(/^Site, 09:00–11:00/);
	await page.keyboard.press("Enter");
	await focusIn(editSheet(page));
	await page.keyboard.press("Escape");
	await expect(editSheet(page)).toBeHidden();
	await expect(focused(page)).toHaveAccessibleName(/^Site, 09:00–11:00/);

	await page.keyboard.press("ArrowDown");
	await expect(focused(page)).toHaveAccessibleName(/^New entry, .*, from 11:00$/);
	await page.keyboard.press("Enter");
	await expect(trackSheet(page).getByLabel("Start")).toHaveValue("11:00");
	await focusIn(trackSheet(page));
	await page.keyboard.press("Escape");
	await expect(trackSheet(page)).toBeHidden();

	// Home leads back to the first day's head, which says what is left of a working day (TS-095).
	await page.keyboard.press("Home");
	await expect(focused(page)).toHaveAccessibleName(/, \d+:\d{2} tracked\b/);
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\?day=\d{4}-\d{2}-\d{2}$/);
});

for (const viewport of [COMPACT, MEDIUM]) {
	for (const scheme of ["light", "dark"] as const) {
		test.describe(`at ${viewport.width}px in the ${scheme} scheme`, () => {
			test.use({ viewport, chosenScheme: scheme });

			test("axe finds nothing on the week in detail and compact, with an entry and Track time open, and the month; nothing overflows the window", async ({
				page,
			}) => {
				const { slug } = await personWithTime(page);
				// Track time opens on a slot of today, which a day off does not offer.
				await workEveryDay(page, slug);
				const overflows = () =>
					page.evaluate(
						() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
					);

				for (const query of ["view=calendar", "view=calendar&zoom=compact"]) {
					await openShell(page, `${organisationPath(slug)}?${query}`);
					await expect(weekGrid(page)).toBeVisible();
					expect(await overflows(), query).toBe(false);
					expect(await calendarProblems(page), query).toEqual([]);
				}

				await todayLink(weekGrid(page)).focus();
				await page.keyboard.press("ArrowDown");
				await page.keyboard.press("Enter");
				await expect(page.getByRole("dialog")).toBeVisible();
				expect(
					await problems(page, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS, EMPTY_INPUT]),
					"with a sheet open",
				).toEqual([]);
				await focusIn(page.getByRole("dialog"));
				await page.keyboard.press("Escape");

				await openShell(page, `${organisationPath(slug)}?view=calendar&scale=month`);
				await expect(monthGrid(page)).toBeVisible();
				expect(await overflows(), "month").toBe(false);
				expect(await problems(page)).toEqual([]);
			});
		});
	}
}

/** What axe says of text that a scrolled container clips. */
const PARTLY_SCROLLED_AWAY = "elmPartiallyObscured";

/**
 * What is wrong with the week calendar. It scrolls, both ways at 390px, and
 * axe cannot measure what the scroll hides: it is scanned from each corner.
 */
async function calendarProblems(page: Page): Promise<string[]> {
	const scroller = weekGrid(page).locator("..");
	const found: string[] = [];
	for (const [left, top] of [
		[0, 0],
		[1, 1],
	] as const) {
		await scroller.evaluate(
			(element, [x, y]) => {
				element.scrollLeft = x * element.scrollWidth;
				element.scrollTop = y * element.scrollHeight;
			},
			[left, top],
		);
		found.push(...(await problems(page, [EMPTY_INPUT, PARTLY_SCROLLED_AWAY, DIGIT_CHANGING])));
	}
	return found;
}
