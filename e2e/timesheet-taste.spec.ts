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
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";
import { afternoonZone, createProject, workEveryDay } from "./timesheet";

// The Timesheet as Harvest makes it feel (TS-093, research/harvest-taste.md):
// Start again on a finished entry, a deletion taken back with Undo in the
// snackbar and the changed row marked (HT-A); amber for the running timer and
// today (HT-B); Track time over any page, with a date (HT-C, audit W01); the
// keys and the day title's month (HT-D); the project picker (HT-E); the empty
// day's action and the copy of the last working day (HT-F); and the mobile
// Week view and day strip (audit W02, W16). Each test is a new person with an
// organisation of their own.

const COMPACT = { width: 390, height: 844 };
const MEDIUM = { width: 1280, height: 800 };

// Hours are tracked today, which has room for them only once they have passed
// (W08): the browser, and so the person, is where it is afternoon now.
test.use({ storageState: SIGNED_OUT, timezoneId: afternoonZone() });
test.describe.configure({ timeout: TIME_WITH_TURNS });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

/**
 * A new person's organisation with a project, Site, that works every day of
 * the week: Start again runs a timer today, whatever day the test runs (TS-095).
 */
async function trackingOrganisation(page: Page) {
	await signIn(page, newPerson().email);
	const organisation = await createOrganisation(page);
	await createProject(page, organisation.slug, "Site");
	await workEveryDay(page, organisation.slug);
	await openShell(page, organisationPath(organisation.slug));
	return organisation;
}

const navigation = (page: Page) => page.getByRole("navigation", { name: "Main" });
const main = (page: Page) => page.getByRole("main");
const trackSheet = (page: Page) => page.getByRole("dialog", { name: "Track time" });
const pageTrackTime = (page: Page) =>
	main(page).getByRole("button", { name: "Track time", exact: true });
const entryRows = (page: Page) =>
	main(page).getByRole("list", { name: "Entries" }).getByRole("listitem");
const snackbar = (page: Page) => page.locator("[data-snackbar]");
const dayTimer = (page: Page) => main(page).getByRole("timer", { name: "Elapsed" });

/** A day as the address writes it, `days` from today in the browser's zone, which is the person's. */
function dayFrom(page: Page, days: number): Promise<string> {
	return page.evaluate((step) => {
		const at = new Date();
		at.setDate(at.getDate() + step);
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
	}, days);
}

/**
 * The latest weekday before today whose day before is a weekday too: a working
 * day with a working day behind it. Tests track there, not today, because a
 * weekend day's time may count as overtime (TS-095).
 */
async function pastWorkingPair(page: Page): Promise<{ source: string; target: string }> {
	for (let back = 1; back < 10; back++) {
		const weekday = await page.evaluate((step) => {
			const at = new Date();
			at.setDate(at.getDate() - step);
			return at.getDay();
		}, back);
		// Tuesday to Friday: the day before is Monday to Thursday.
		if (weekday >= 2 && weekday <= 5) {
			return { target: await dayFrom(page, -back), source: await dayFrom(page, -back - 1) };
		}
	}
	throw new Error("no working pair");
}

/** Tracks `hours` on `day` from the Track time sheet, typed with `fill()`. */
async function trackHours(page: Page, opener: Locator, hours: string, day: string, what: string) {
	await opener.click();
	const sheet = trackSheet(page);
	await expect(sheet.getByRole("combobox", { name: "Project" })).toBeFocused();
	await sheet.getByRole("textbox", { name: "Description" }).fill(what);
	await sheet.getByRole("textbox", { name: "Hours" }).fill(hours);
	await sheet.getByLabel("Date").fill(day);
	await expect(sheet.getByRole("button", { name: "Save entry" })).toBeEnabled();
	await sheet.getByRole("button", { name: "Save entry" }).click();
	await expect(sheet).toBeHidden();
	await expect(snackbar(page)).toContainText("Entry saved.");
}

test.describe("at 1280px", () => {
	test.use({ viewport: MEDIUM });

	test("Track time opens over Projects with a date; the entry lands on that day; the address never changes", async ({
		page,
	}) => {
		const { slug } = await trackingOrganisation(page);
		const { target: day } = await pastWorkingPair(page);
		await navigation(page).getByRole("link", { name: "Projects", exact: true }).click();
		const projects = new RegExp(`${organisationPath(slug)}/projects$`);
		await expect(page).toHaveURL(projects);

		await trackHours(
			page,
			navigation(page).getByRole("button", { name: "Track time", exact: true }),
			"2",
			day,
			"Drawings",
		);
		await expect(page).toHaveURL(projects);
		// A centred dialog no wider than 480px from 840px.
		await navigation(page).getByRole("button", { name: "Track time", exact: true }).click();
		const box = await trackSheet(page).boundingBox();
		expect(box?.width ?? 0).toBeLessThanOrEqual(480);
		expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - MEDIUM.width / 2)).toBeLessThan(2);
		await page.keyboard.press("Escape");

		await openShell(page, `${organisationPath(slug)}?day=${day}`);
		await expect(entryRows(page)).toHaveCount(1);
		await expect(entryRows(page).first()).toContainText("Drawings");
		await expect(entryRows(page).first()).toContainText("2:00");
	});

	test("Start again, delete with Undo, and the row that changed is marked", async ({ page }) => {
		const { slug } = await trackingOrganisation(page);
		const { target: day } = await pastWorkingPair(page);
		await trackHours(page, pageTrackTime(page), "1", day, "Plans");
		await openShell(page, `${organisationPath(slug)}?day=${day}`);
		await expect(entryRows(page)).toHaveCount(1);
		const times = await entryRows(page).first().textContent();

		await main(page).getByRole("button", { name: "Start again: Plans" }).click();
		await expect(snackbar(page)).toContainText("Timer started.");
		await expect(dayTimer(page)).toBeVisible();
		await expect(
			page.getByRole("status").filter({ hasText: "Timer started." }).first(),
		).toBeAttached();
		await main(page).getByRole("button", { name: "Stop timer", exact: true }).click();
		await expect(dayTimer(page)).toHaveCount(0);
		// The timer ran today, so the day it started from keeps its one entry.
		await expect(entryRows(page)).toHaveCount(1);
		await openShell(page, organisationPath(slug));
		await expect(entryRows(page)).toHaveCount(1);
		await openShell(page, `${organisationPath(slug)}?day=${day}`);

		// Deleting asks nothing: the entry goes, and Undo brings the same one back.
		await main(page)
			.getByRole("button", { name: /^Actions for Plans/ })
			.first()
			.click();
		await page.getByRole("menuitem", { name: "Delete entry" }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(snackbar(page)).toContainText("Entry deleted.");
		await expect(entryRows(page)).toHaveCount(0);
		await page.getByRole("button", { name: "Undo" }).click();
		await expect(snackbar(page)).toContainText("Entry restored.");
		await expect(entryRows(page)).toHaveCount(1);
		await expect(entryRows(page).first()).toHaveText(times ?? "");
	});

	test("N, [, ], T and ? work when the focus is on the page, and N adds a row on the Week view", async ({
		page,
	}) => {
		const { slug } = await trackingOrganisation(page);
		await page.getByRole("heading", { level: 1, name: "Timesheet" }).focus();

		await page.keyboard.press("n");
		await expect(trackSheet(page)).toBeVisible();
		// Typing in the sheet is typing, not a key.
		await page.keyboard.type("n");
		await page.keyboard.press("Escape");
		await expect(trackSheet(page)).toBeHidden();

		await page.keyboard.press("]");
		await expect(page).toHaveURL(new RegExp(`day=${await dayFrom(page, 1)}$`));
		await page.keyboard.press("[");
		await expect(page).toHaveURL(new RegExp(`day=${await dayFrom(page, 0)}$`));
		await page.keyboard.press("[");
		await expect(page).toHaveURL(new RegExp(`day=${await dayFrom(page, -1)}$`));
		await page.keyboard.press("t");
		await expect(page).toHaveURL(new RegExp(`${organisationPath(slug)}$`));

		await page.keyboard.press("?");
		const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
		await expect(shortcuts).toContainText("Back to today");
		await page.keyboard.press("Escape");
		await expect(shortcuts).toBeHidden();

		await openShell(page, `${organisationPath(slug)}?view=week`);
		await page.getByRole("heading", { level: 1, name: "Timesheet" }).focus();
		await page.keyboard.press("n");
		const cells = page.getByRole("textbox", { name: /^Site, / });
		await expect(cells).toHaveCount(7);
		await expect(cells.first()).toBeFocused();
	});

	test("the day title opens the month: days with time say so, a day opens, and Back to today returns", async ({
		page,
	}) => {
		const { slug } = await trackingOrganisation(page);
		// Today when it is a weekday; on a weekend, whose time may be overtime
		// (TS-095), the latest weekday before it, shown first.
		const weekend = await page.evaluate(() => [0, 6].includes(new Date().getDay()));
		const day = weekend ? (await pastWorkingPair(page)).target : await dayFrom(page, 0);
		await trackHours(page, pageTrackTime(page), "1:30", day, "Plans");
		if (weekend) await openShell(page, `${organisationPath(slug)}?day=${day}`);

		const days = page.getByRole("group", { name: "Days", exact: true });
		await days.getByRole("button", { name: /: choose a day$/ }).click();
		const picker = page.getByRole("dialog", { name: "Choose a day" });
		await expect(
			picker.getByRole("link", { name: weekend ? /, 1:30 tracked$/ : /^Today, .*, 1:30 tracked$/ }),
		).toBeVisible();
		await picker.getByRole("button", { name: "Previous month" }).click();
		await picker.getByRole("link").first().click();
		await expect(picker).toBeHidden();
		await expect(page).toHaveURL(/\?day=\d{4}-\d{2}-\d{2}$/);
		await days.getByRole("link", { name: "Back to today" }).click();
		await expect(page).toHaveURL(new RegExp(`${organisationPath(slug)}$`));
	});

	test("the project picker finds a project by typing, and puts the recent one first", async ({
		page,
	}) => {
		const { slug } = await trackingOrganisation(page);
		await createProject(page, slug, "Archive survey");
		await openShell(page, organisationPath(slug));
		// A past weekday, not today: a weekend day may count as overtime (TS-095).
		const { target: day } = await pastWorkingPair(page);

		await pageTrackTime(page).click();
		const sheet = trackSheet(page);
		const project = sheet.getByRole("combobox", { name: "Project" });
		await project.fill("surv");
		const list = page.getByRole("listbox");
		await expect(list.getByRole("option")).toHaveCount(1);
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		await expect(project).toHaveValue("Archive survey");
		await sheet.getByRole("textbox", { name: "Hours" }).fill("1");
		await sheet.getByLabel("Date").fill(day);
		await sheet.getByRole("button", { name: "Save entry" }).click();
		await expect(sheet).toBeHidden();

		await pageTrackTime(page).click();
		await expect(project).toHaveValue("Archive survey");
		await sheet.getByRole("button", { name: "Show suggestions" }).click();
		await expect(page.getByRole("listbox")).toContainText(/^Recent/);
		await page.keyboard.press("Escape");
	});

	test("an empty working day offers its Track time and the copy of the working day before", async ({
		page,
	}) => {
		const { slug } = await trackingOrganisation(page);
		const { source, target } = await pastWorkingPair(page);
		await trackHours(page, pageTrackTime(page), "2", source, "Plans");
		await openShell(page, `${organisationPath(slug)}?day=${target}`);

		await expect(main(page)).toContainText(
			/Nothing yet on .*\. Track time, or copy .*'s entries\./,
		);
		await expect(main(page).getByRole("button", { name: /^Track time on / })).toBeVisible();
		await main(page)
			.getByRole("button", { name: /^Copy .*'s entries$/ })
			.click();
		await expect(snackbar(page)).toContainText("Copied 1 entry from");
		await expect(entryRows(page)).toHaveCount(1);
		await expect(entryRows(page).first()).toContainText("Plans");
		await expect(entryRows(page).first()).toContainText("09:00–11:00");
		await expect(main(page).getByRole("button", { name: /^Copy / })).toHaveCount(0);
	});
});

test.describe("at 390px", () => {
	test.use({ viewport: COMPACT });

	test("the Week view scrolls inside its grid, not the page (W02), and the day chips sit on one line each (W16)", async ({
		page,
	}) => {
		const { slug } = await trackingOrganisation(page);
		const chips = page.getByRole("group", { name: "Days of the week" }).getByRole("link");
		const heights = await chips.evaluateAll((links) =>
			links.map((link) => Math.round(link.getBoundingClientRect().height)),
		);
		expect(new Set(heights).size).toBe(1);

		for (const query of ["view=week", "view=calendar", ""]) {
			await openShell(page, `${organisationPath(slug)}?${query}`);
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth),
				query || "day",
			).toBeLessThanOrEqual(COMPACT.width);
		}
	});
});

for (const viewport of [COMPACT, MEDIUM]) {
	for (const scheme of ["light", "dark"] as const) {
		test.describe(`at ${viewport.width}px in the ${scheme} scheme`, () => {
			test.use({ viewport, chosenScheme: scheme });

			test("axe finds nothing with Start again, a running timer in amber, the month picker, the shortcuts and Track time over Projects", async ({
				page,
			}) => {
				const { slug } = await trackingOrganisation(page);
				const { target: day } = await pastWorkingPair(page);
				await trackHours(page, pageTrackTime(page), "1", day, "Plans");
				await page.getByRole("button", { name: "Dismiss" }).click();
				await expect(snackbar(page)).toHaveCount(0);
				await openShell(page, `${organisationPath(slug)}?day=${day}`);
				expect(await problems(page, [EMPTY_INPUT]), "an entry with Start again").toEqual([]);

				await main(page).getByRole("button", { name: "Start again: Plans" }).click();
				await expect(dayTimer(page)).toBeVisible();
				await page.getByRole("button", { name: "Dismiss" }).click();
				expect(await problems(page, [EMPTY_INPUT, DIGIT_CHANGING]), "running").toEqual([]);

				await page
					.getByRole("group", { name: "Days", exact: true })
					.getByRole("button", { name: /: choose a day$/ })
					.click();
				await expect(
					page.getByRole("dialog", { name: "Choose a day" }).getByRole("table"),
				).toBeVisible();
				expect(
					await problems(page, [
						UNDER_AN_OVERLAY,
						OVER_SEVERAL_ELEMENTS,
						EMPTY_INPUT,
						DIGIT_CHANGING,
					]),
					"the month",
				).toEqual([]);
				await page.keyboard.press("Escape");
				await expect(page.getByRole("dialog", { name: "Choose a day" })).toHaveCount(0);

				await page.getByRole("heading", { level: 1, name: "Timesheet" }).focus();
				await page.keyboard.press("?");
				await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
				expect(
					await problems(page, [
						UNDER_AN_OVERLAY,
						OVER_SEVERAL_ELEMENTS,
						EMPTY_INPUT,
						DIGIT_CHANGING,
					]),
					"the shortcuts",
				).toEqual([]);
				await page.keyboard.press("Escape");

				await openShell(page, `${organisationPath(slug)}/projects`);
				await navigation(page)
					.getByRole("button", { name: /^Stop timer/ })
					.click();
				await navigation(page).getByRole("button", { name: "Track time", exact: true }).click();
				await expect(trackSheet(page).getByRole("combobox", { name: "Project" })).toBeFocused();
				expect(
					await problems(page, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS, EMPTY_INPUT]),
					"Track time over Projects",
				).toEqual([]);
			});
		});
	}
}
