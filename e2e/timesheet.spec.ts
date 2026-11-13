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

// Timesheet in a browser: the timer on the Day view and in the navigation
// (TS-012a, TS-051), the Day and Week views and their links (TS-013), an entry
// changed by hand (TS-012b), the week's grid (TS-052), submitting a week
// (TS-046), and "Track time", the week's days, the Day view's foot and getting
// started (TS-056).
// Each test is a new person with an organisation of their own: a person may
// create five, and the shared people's organisations are left as they are.

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
 * Signs a new person in, who creates an organisation and, on Projects, one
 * project, Site, and works every day of the week: the timer runs today,
 * whatever day the test runs (TS-095). The Day view is open.
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
const navTimer = (page: Page) => navigation(page).getByRole("timer", { name: "Elapsed" });
const dayTimer = (page: Page) => page.getByRole("main").getByRole("timer", { name: "Elapsed" });
const views = (page: Page) => page.getByRole("group", { name: "Timesheet views" });
/** The time a timer shows, as it is read out: once, not character by character. */
const elapsed = (timer: Locator) => timer.locator(".sr-only");
const trackSheet = (page: Page) => page.getByRole("dialog", { name: "Track time" });
const weekDays = (page: Page) => page.getByRole("group", { name: "Days of the week" });
const gettingStarted = (page: Page) => page.getByRole("region", { name: "Getting started" });

/** Starts the timer through "Track time", with no hours. */
async function startTimer(page: Page) {
	await page.getByRole("button", { name: "Track time", exact: true }).click();
	await trackSheet(page).getByRole("button", { name: "Start timer" }).click();
	await expect(trackSheet(page)).toBeHidden();
	// The Day view's own timer: under 600px the navigation's is not drawn here.
	await expect(dayTimer(page)).toBeVisible();
	// The sheet's scrim fades out after the sheet has gone; until it has, it lies over the page.
	await expect(page.locator("[data-exiting]")).toHaveCount(0);
}

/** Presses Tab until `target` has the focus: the way a person without a pointer gets there. */
async function tabTo(page: Page, target: Locator, most = 60) {
	for (let step = 0; step < most; step++) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press("Tab");
	}
	throw new Error("Tab never reached the control.");
}

test("a new person signs in, creates an organisation and a project, starts the timer and finds it in the week, in under two minutes", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await trackingOrganisation(page);

	await startTimer(page);
	await views(page).getByRole("link", { name: "Week" }).click();

	await expect(
		page.getByRole("link", { name: /^Site, .*: 0:00, running\. Change it in the Day view$/ }),
	).toBeVisible();
});

test.describe("the timer", () => {
	test("is started and stopped with the keyboard alone, and the navigation and the Day view read the same elapsed time", async ({
		page,
	}) => {
		await page.clock.install();
		await trackingOrganisation(page);

		await tabTo(page, page.getByRole("button", { name: "Track time", exact: true }));
		await page.keyboard.press("Enter");
		const sheet = trackSheet(page);
		await expect(sheet.getByRole("button", { name: "Start timer" })).toBeVisible();
		await tabTo(page, sheet.getByRole("textbox", { name: "Hours" }));
		await page.keyboard.press("Enter");
		await expect(sheet).toBeHidden();
		await expect(navTimer(page)).toBeVisible();
		await page.clock.runFor(3_000);
		await expect(elapsed(dayTimer(page))).toHaveText(
			(await elapsed(navTimer(page)).textContent()) ?? "",
		);
		await page.clock.runFor(61_000);
		await expect(elapsed(dayTimer(page))).toHaveText(
			(await elapsed(navTimer(page)).textContent()) ?? "",
		);
		// A timer is never announced: no live region holds it.
		for (const timer of [navTimer(page), dayTimer(page)]) {
			await expect(
				timer.locator("xpath=ancestor-or-self::*[@aria-live][not(@aria-live='off')]"),
			).toHaveCount(0);
		}

		await tabTo(page, page.getByRole("button", { name: "Stop timer", exact: true }));
		await page.keyboard.press("Enter");
		// On the Timesheet the page's own Track time is the one way to track: the navigation shows only a running timer.
		await expect(navTimer(page)).toHaveCount(0);
		await expect(
			navigation(page).getByRole("button", { name: "Track time", exact: true }),
		).toHaveCount(0);
		await expect(page.getByRole("main").getByText("Running")).toHaveCount(0);
	});

	test("is stopped from the navigation on another page, and the person stays there", async ({
		page,
	}) => {
		const { slug } = await trackingOrganisation(page);
		await startTimer(page);

		await navigation(page).getByRole("link", { name: "Reports" }).click();
		await expect(page).toHaveURL(new RegExp(`${organisationPath(slug)}/reports$`));
		await navigation(page).getByRole("button", { name: "Stop timer for Site" }).click();

		await expect(
			navigation(page).getByRole("button", { name: "Track time", exact: true }),
		).toBeVisible();
		await expect(page).toHaveURL(new RegExp(`${organisationPath(slug)}/reports$`));
	});

	test("Track time in the navigation opens the sheet over the page it is on, which stays where it is (taste HT-C, W01)", async ({
		page,
	}) => {
		const { slug } = await trackingOrganisation(page);
		await navigation(page).getByRole("link", { name: "Reports" }).click();
		const reports = new RegExp(`${organisationPath(slug)}/reports$`);
		await expect(page).toHaveURL(reports);
		const opener = navigation(page).getByRole("button", { name: "Track time", exact: true });
		await opener.click();

		await expect(trackSheet(page).getByRole("button", { name: "Start timer" })).toBeVisible();
		await expect(trackSheet(page).getByRole("combobox", { name: "Project" })).toBeFocused();
		await expect(page).toHaveURL(reports);
		await page.keyboard.press("Escape");
		await expect(trackSheet(page)).toBeHidden();
		await expect(opener).toBeFocused();

		await opener.click();
		await trackSheet(page).getByRole("button", { name: "Start timer" }).click();
		await expect(trackSheet(page)).toBeHidden();
		await expect(navTimer(page)).toBeVisible();
		await expect(page).toHaveURL(reports);
		await expect(page.getByRole("status").filter({ hasText: "Timer started." })).toBeAttached();
	});

	test("at 390px a running timer is one strip above the bar, and on the Timesheet only the Day view's", async ({
		page,
	}) => {
		await page.setViewportSize(COMPACT);
		const { slug } = await trackingOrganisation(page);
		await startTimer(page);
		const strip = navigation(page).getByRole("region", { name: "Timer" });
		const stopIn = (where: Locator) => where.getByRole("button", { name: /^Stop timer/ });

		// The Day view has its own timer: the navigation's is not drawn here.
		await expect(dayTimer(page)).toBeVisible();
		await expect(strip).toBeHidden();
		await expect(stopIn(page.getByRole("main"))).toHaveCount(1);
		await expect(stopIn(navigation(page))).toBeHidden();

		// The snackbar that said the timer started is the one other row fixed across the page; it goes.
		await page.getByRole("button", { name: "Dismiss" }).click();
		await expect(page.locator("[data-snackbar]")).toHaveCount(0);
		await navigation(page).getByRole("link", { name: "Projects", exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`${organisationPath(slug)}/projects$`));
		await expect(strip).toBeVisible();
		const bar = await navigation(page).boundingBox();
		const drawn = await strip.boundingBox();
		if (!bar || !drawn) throw new Error("not drawn");
		// One row of 56px straight above the 64px bar, and nothing else fixed across the page.
		expect(drawn.height).toBe(56);
		expect(drawn.y + drawn.height).toBe(bar.y);
		// Polled: the pending bar is a fixed row too, for as long as a load runs.
		await expect
			.poll(() =>
				page.evaluate(() =>
					[...document.querySelectorAll<HTMLElement>("body *")]
						.filter((element) => getComputedStyle(element).position === "fixed")
						.map((element) => element.getBoundingClientRect())
						.filter(({ width, height }) => height > 0 && width >= window.innerWidth * 0.9)
						.reduce((sum, { height }) => sum + height, 0),
				),
			)
			.toBe(120);
		await expect(
			navigation(page).getByRole("button", { name: "Track time", exact: true }),
		).toHaveCount(0);
		const stop = await stopIn(navigation(page)).boundingBox();
		expect(stop?.height ?? 0).toBeGreaterThanOrEqual(40);

		await stopIn(navigation(page)).click();
		await expect(strip).toBeHidden();
		await expect(
			navigation(page).getByRole("button", { name: "Track time", exact: true }),
		).toBeVisible();
	});

	test("shows the same elapsed time in two browsers, and a stop in one shows in the other within 30 seconds", async ({
		browser,
		baseURL,
		page,
	}) => {
		const { slug } = await trackingOrganisation(page);
		await startTimer(page);
		const session = await page.context().storageState();

		// Two more browsers signed in as the same person, whose clocks read the same.
		const at = new Date(Date.now() + 10 * 60_000);
		const open = async () => {
			const context = await browser.newContext({ baseURL, storageState: session });
			await ownAddress(context, baseURL);
			const other = await context.newPage();
			await other.clock.install();
			await openShell(other, organisationPath(slug));
			await other.clock.pauseAt(at);
			return { context, other };
		};
		const one = await open();
		const two = await open();
		await expect(elapsed(navTimer(one.other))).toHaveText(/^\d+:\d\d:\d\d$/);
		const shown = (await elapsed(navTimer(one.other)).textContent()) ?? "";
		await expect(elapsed(navTimer(two.other))).toHaveText(shown);
		await expect(elapsed(dayTimer(two.other))).toHaveText(shown);

		await one.other.getByRole("button", { name: "Stop timer", exact: true }).click();
		// On the Timesheet the navigation shows a running timer alone.
		await expect(navTimer(one.other)).toHaveCount(0);
		await expect(navTimer(two.other)).toBeVisible();
		await two.other.clock.resume();
		await two.other.clock.runFor(30_000);
		await expect(navTimer(two.other)).toHaveCount(0);
		await expect(dayTimer(two.other)).toHaveCount(0);
		await one.context.close();
		await two.context.close();
	});

	test.describe("with reduced motion requested", () => {
		test.use({ reducedMotion: "reduce" });

		test("changes its digits without any animation", async ({ page }) => {
			await trackingOrganisation(page);
			await startTimer(page);
			await page.waitForTimeout(1_200);

			for (const timer of [navTimer(page), dayTimer(page)]) {
				expect(
					await timer.evaluate((element) => element.getAnimations({ subtree: true }).length),
				).toBe(0);
			}
		});
	});

	test("moves the digit that changes while it runs", async ({ page }) => {
		await trackingOrganisation(page);
		await startTimer(page);

		// A digit moves for a fifth of a second once a second: looked for often enough to see it.
		await expect
			.poll(
				() => dayTimer(page).evaluate((element) => element.getAnimations({ subtree: true }).length),
				{ intervals: [50] },
			)
			.toBeGreaterThan(0);
	});
});

test.describe("the Day view", () => {
	test("Track time is its one primary action: hours typed with the keyboard alone save an entry, which its sheet then changes", async ({
		page,
	}) => {
		await trackingOrganisation(page);
		await expect(page.getByRole("button", { name: "Add entry" })).toHaveCount(0);
		await tabTo(page, page.getByRole("button", { name: "Track time", exact: true }));
		await page.keyboard.press("Enter");
		const sheet = trackSheet(page);
		await expect(sheet).toBeVisible();

		await tabTo(page, sheet.getByRole("textbox", { name: "Description" }));
		await page.keyboard.type("Survey");
		await page.keyboard.press("Tab");
		await expect(sheet.getByRole("textbox", { name: "Hours" })).toBeFocused();
		await page.keyboard.type("1,5");
		await expect(sheet.getByRole("button", { name: "Save entry" })).toBeVisible();
		await page.keyboard.press("Enter");

		await expect(sheet).toBeHidden();
		await expect(
			page.getByRole("main").getByRole("status").filter({ hasText: "Entry saved." }),
		).toBeVisible();
		const main = page.getByRole("main");
		await expect(main.getByRole("list", { name: "Entries" })).toContainText("Survey");
		await expect(main.getByRole("list", { name: "Entries" })).toContainText("1:30");
		// The day's link above the day, and the week's total, count it.
		await expect(weekDays(page).locator('[aria-current="date"]')).toContainText("1:30");
		await expect(main.getByText(/^Week total/).locator("..")).toContainText("1:30");

		// The entry's start and end are changed in its own sheet.
		await tabTo(page, main.getByRole("button", { name: /^Actions for Survey/ }));
		await page.keyboard.press("Enter");
		await page.getByRole("menuitem", { name: "Edit entry" }).press("Enter");
		const editing = page.getByRole("dialog", { name: "Edit entry" });
		// A time field's keystrokes depend on how the browser's language draws it
		// (24-hour, or with AM and PM), so its value is set as its typing ends:
		// no pointer either way. Tab and Enter move and send.
		await editing.getByLabel("Start").fill("08:00");
		await editing.getByLabel("Start").press("Tab");
		await expect(editing.getByLabel("End")).toBeFocused();
		await editing.getByLabel("End").fill("09:15");
		await editing.getByLabel("End").press("Enter");
		await expect(editing).toBeHidden();
		await expect(main).toContainText("08:00–09:15");
		await expect(main.getByRole("list", { name: "Entries" })).toContainText("1:15");
	});

	test("lists the week's seven days as links, the day shown marked, each reached by keyboard", async ({
		page,
	}) => {
		const { slug } = await trackingOrganisation(page);
		const links = weekDays(page).getByRole("link");
		await expect(links).toHaveCount(7);
		await expect(weekDays(page).locator('[aria-current="date"]')).toHaveCount(1);
		await expect(page.getByRole("main")).toContainText(/Week total\s*0:00/);

		const first = links.first();
		await tabTo(page, first);
		const href = (await first.getAttribute("href")) ?? "";
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(href);
		expect(href).toMatch(new RegExp(`^${organisationPath(slug)}\\?day=\\d{4}-\\d{2}-\\d{2}$`));
		await expect(weekDays(page).getByRole("link").first()).toHaveAttribute("aria-current", "date");
	});

	test("its header submits the week, as the Week view's does, and the day is then locked", async ({
		page,
	}) => {
		await trackingOrganisation(page);
		await page.getByRole("button", { name: "Track time", exact: true }).click();
		await trackSheet(page).getByRole("textbox", { name: "Hours" }).fill("2");
		await trackSheet(page).getByRole("button", { name: "Save entry" }).click();
		await expect(trackSheet(page)).toBeHidden();
		await expect(page.getByRole("main")).toContainText("Status: Not submitted");

		await tabTo(page, page.getByRole("button", { name: "Submit week" }));
		await page.keyboard.press("Enter");
		const dialog = page.getByRole("dialog", { name: "Submit this week?" });
		await dialog.getByRole("button", { name: "Submit week" }).press("Enter");
		await expect(page.getByRole("main")).toContainText("Status: Submitted");
		await expect(page.getByRole("button", { name: "Withdraw submission" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Track time", exact: true })).toHaveCount(0);

		await views(page).getByRole("link", { name: "Week" }).click();
		await expect(page.getByText("Status: Submitted")).toBeAttached();
	});

	test("getting started counts what is done, ticks each step, and is gone once all three are", async ({
		page,
	}) => {
		const { slug } = await trackingOrganisation(page);
		const list = gettingStarted(page);
		await expect(list).toContainText("1 of 3");
		// Tracking an entry is done on this page: its step opens the Track time sheet.
		await expect(list.getByRole("link")).toHaveText(["Open the week"]);

		await tabTo(page, list.getByRole("button", { name: "Track an entry" }));
		await page.keyboard.press("Enter");
		await expect(trackSheet(page)).toBeVisible();
		await trackSheet(page).getByRole("textbox", { name: "Hours" }).fill("1");
		await page.keyboard.press("Enter");
		await expect(trackSheet(page)).toBeHidden();
		await expect(list).toContainText("2 of 3");

		await tabTo(page, list.getByRole("link", { name: "Open the week" }));
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(new RegExp(`${organisationPath(slug)}\\?view=week$`));
		await views(page).getByRole("link", { name: "Day" }).click();
		await expect(page.getByRole("button", { name: "Track time", exact: true })).toBeVisible();
		await expect(list).toHaveCount(0);
	});

	test("Put away hides getting started, and it stays away", async ({ page }) => {
		const { slug } = await trackingOrganisation(page);
		await tabTo(
			page,
			gettingStarted(page).getByRole("button", { name: "Put away getting started" }),
		);
		await page.keyboard.press("Enter");
		await expect(gettingStarted(page)).toHaveCount(0);
		await expect(page.getByRole("status")).toHaveText("Getting started is put away.");
		// The button went with the list: the focus is on the page's heading, not lost.
		await expect(page.getByRole("heading", { level: 1, name: "Timesheet" })).toBeFocused();

		await openShell(page, organisationPath(slug));
		await expect(page.getByRole("button", { name: "Track time", exact: true })).toBeVisible();
		await expect(gettingStarted(page)).toHaveCount(0);
	});

	test("steps by day with links, later forward and earlier back, and Back to today returns", async ({
		page,
	}) => {
		const { slug } = await trackingOrganisation(page);
		const days = page.getByRole("group", { name: "Days", exact: true });

		await tabTo(page, days.getByRole("link", { name: "Next day" }));
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/\?day=\d{4}-\d{2}-\d{2}$/);
		const next = new URL(page.url()).searchParams.get("day");
		await days.getByRole("link", { name: "Previous day" }).click();
		await expect(page).not.toHaveURL(new RegExp(`day=${next}$`));
		const today = new URL(page.url()).searchParams.get("day");
		await days.getByRole("link", { name: "Previous day" }).click();
		await expect(page).toHaveURL(/\?day=\d{4}-\d{2}-\d{2}$/);
		await expect(page).not.toHaveURL(new RegExp(`day=${today ?? "none"}$`));
		const previous = new URL(page.url()).searchParams.get("day");
		expect(previous && next && previous < next).toBe(true);
		await days.getByRole("link", { name: "Back to today" }).click();
		await expect(page).toHaveURL(new RegExp(`${organisationPath(slug)}$`));
		// On today there is no way back to it.
		await expect(days.getByRole("link", { name: "Back to today" })).toHaveCount(0);
	});
});

test.describe("the Week view", () => {
	test("is marked as Timesheet in the navigation, takes hours typed cell to cell by keyboard, and submits the week", async ({
		page,
	}) => {
		await trackingOrganisation(page);
		await page
			.getByRole("group", { name: "Timesheet views" })
			.getByRole("link", { name: "Week" })
			.click();
		await expect(navigation(page).getByRole("link", { name: "Timesheet" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		// The week before this one, whose days have all passed: on a Monday this
		// week's Tuesday has no room yet for hours, which never run past now (W08).
		await page
			.getByRole("group", { name: "Weeks" })
			.getByRole("link", { name: "Previous week" })
			.click();
		await expect(page).toHaveURL(/[?&]start=\d{4}-\d{2}-\d{2}$/);

		await tabTo(page, page.getByRole("button", { name: "Add row" }));
		await page.keyboard.press("Enter");
		const cells = page.getByRole("textbox", { name: /^Site, / });
		await expect(cells).toHaveCount(7);

		await tabTo(page, cells.first());
		await page.keyboard.type("2");
		await page.keyboard.press("Tab");
		await expect(cells.nth(1)).toBeFocused();
		await page.keyboard.type("1:30");
		await page.keyboard.press("Tab");
		await expect(page.getByRole("rowgroup").last()).toContainText("Week total 3:30");
		await expect(page.getByRole("row", { name: /^Site/ })).toContainText("3:30");

		await page.getByRole("button", { name: "Submit week" }).click();
		const dialog = page.getByRole("dialog", { name: "Submit this week?" });
		await dialog.getByRole("button", { name: "Submit week" }).click();
		await expect(page.getByText("Status: Submitted")).toBeAttached();
		await expect(page.getByRole("textbox", { name: /^Site, / })).toHaveCount(0);

		await page
			.getByRole("group", { name: "Timesheet views" })
			.getByRole("link", { name: "History" })
			.click();
		// This week first, then the week submitted.
		const submitted = page.getByRole("list", { name: "Periods" }).getByRole("listitem").nth(1);
		await expect(submitted).toContainText("Submitted");
		await expect(submitted).toContainText("3:30");
	});

	test("steps by week with links reached by keyboard", async ({ page }) => {
		await trackingOrganisation(page);
		await page
			.getByRole("group", { name: "Timesheet views" })
			.getByRole("link", { name: "Week" })
			.click();
		const weeks = page.getByRole("group", { name: "Weeks" });
		const next = weeks.getByRole("link", { name: "Next week" });
		// The address changes before the view transition draws the week that
		// arrives, so each step waits for Next week to lead somewhere new: a press
		// before then is on the week that is leaving.
		let leadsTo = (await next.getAttribute("href")) ?? "";

		await tabTo(page, weeks.getByRole("link", { name: "Previous week" }));
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/view=week&start=\d{4}-\d{2}-\d{2}$/);
		await expect(next).not.toHaveAttribute("href", leadsTo);
		for (const step of ["this week", "next week"]) {
			leadsTo = (await next.getAttribute("href")) ?? "";
			await next.click();
			await expect(next, step).not.toHaveAttribute("href", leadsTo);
			await expect(page, step).toHaveURL((url) => `${url.pathname}${url.search}` === leadsTo);
		}
		await weeks.getByRole("link", { name: "Back to this week" }).click();
		await expect(page).toHaveURL(/view=week$/);
	});
});

/** What axe says of text that a scrolled container clips. */
const PARTLY_SCROLLED_AWAY = "elmPartiallyObscured";

/**
 * What is wrong with the Week view. Where the grid is wider than the window it
 * scrolls, and axe cannot measure what the scroll hides; it is scanned once
 * from each end, so every cell is measured where it can be seen.
 */
async function gridProblems(page: Page): Promise<string[]> {
	const grid = page.locator("table").locator("..");
	const scrolls = await grid.evaluate((element) => element.scrollWidth > element.clientWidth);
	if (!scrolls) return problems(page, [EMPTY_INPUT, DIGIT_CHANGING]);
	const found: string[] = [];
	for (const end of ["start", "end"] as const) {
		await grid.evaluate((element, to) => {
			element.scrollLeft = to === "start" ? 0 : element.scrollWidth;
		}, end);
		found.push(...(await problems(page, [EMPTY_INPUT, PARTLY_SCROLLED_AWAY, DIGIT_CHANGING])));
	}
	return found;
}

for (const viewport of [COMPACT, MEDIUM]) {
	for (const scheme of ["light", "dark"] as const) {
		test.describe(`at ${viewport.width}px in the ${scheme} scheme`, () => {
			test.use({ viewport, chosenScheme: scheme });

			test("axe finds nothing on the Day view empty, with Track time open and running, the Week view empty and filled, and History", async ({
				page,
			}) => {
				const { slug } = await trackingOrganisation(page);
				// Getting started, the week's days, Track time and the foot.
				await expect(gettingStarted(page)).toBeVisible();
				expect(await problems(page, [EMPTY_INPUT])).toEqual([]);

				// The Track time sheet, reached and left by keyboard.
				await tabTo(page, page.getByRole("button", { name: "Track time", exact: true }));
				await page.keyboard.press("Enter");
				await expect(trackSheet(page)).toBeVisible();
				expect(
					await problems(page, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS, EMPTY_INPUT]),
					"problems with Track time open",
				).toEqual([]);
				await page.keyboard.press("Escape");
				await expect(trackSheet(page)).toBeHidden();

				await startTimer(page);
				expect(await problems(page, [EMPTY_INPUT, DIGIT_CHANGING])).toEqual([]);

				// The running entry gives the week a row.
				await openShell(page, `${organisationPath(slug)}?view=week`);
				expect(await gridProblems(page)).toEqual([]);
				// An hour typed into the week before fills it: every day of it has passed,
				// where on a Monday every other day of this week is still to come (W08).
				await page
					.getByRole("group", { name: "Weeks" })
					.getByRole("link", { name: "Previous week" })
					.click();
				await expect(page).toHaveURL(/[?&]start=\d{4}-\d{2}-\d{2}$/);
				await page.getByRole("button", { name: "Add row" }).click();
				const cell = page.getByRole("textbox", { name: /^Site, / }).first();
				await cell.fill("1");
				await cell.press("Tab");
				await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeAttached();
				expect(await gridProblems(page)).toEqual([]);

				// The timer still runs, in the navigation: a digit may be changing as it is scanned.
				await openShell(page, `${organisationPath(slug)}?view=history`);
				expect(await problems(page, [DIGIT_CHANGING])).toEqual([]);
			});
		});
	}
}

declare global {
	interface Window {
		__arrivals?: [number, number][][];
	}
}

/** Where the arriving page starts on each axis, for each view transition the page runs from now on. */
async function watchArrivals(page: Page) {
	await page.addInitScript(() => {
		const start = document.startViewTransition?.bind(document);
		if (!start) return;
		const arrivals: [number, number][][] = [];
		window.__arrivals = arrivals;
		document.startViewTransition = ((...parameters: Parameters<typeof start>) => {
			const transition = start(...parameters);
			transition.ready
				.then(() => Promise.resolve())
				.then(() => {
					const moves: [number, number][] = [];
					for (const animation of document.getAnimations()) {
						const effect = animation.effect as KeyframeEffect | null;
						const pseudo = effect?.pseudoElement ?? "";
						if (!pseudo.startsWith("::view-transition-new")) continue;
						if (
							!(animation instanceof CSSAnimation) ||
							!animation.animationName.startsWith("shell-arrive")
						) {
							continue;
						}
						const now = animation.currentTime;
						animation.currentTime = 0;
						const [x = "0", y = "0"] = getComputedStyle(
							document.documentElement,
							pseudo,
						).translate.split(" ");
						animation.currentTime = now;
						moves.push([Number.parseFloat(x) || 0, Number.parseFloat(y) || 0]);
					}
					arrivals.push(moves);
				})
				.catch(() => arrivals.push([]));
			return transition;
		}) as typeof document.startViewTransition;
	});
	return () => page.evaluate(() => window.__arrivals ?? []);
}

test.describe("stepping through days", () => {
	test.use({ viewport: MEDIUM, reducedMotion: "no-preference" });

	test("moves the day forward going later and back going earlier", async ({ page }) => {
		const arrivals = await watchArrivals(page);
		await trackingOrganisation(page);
		const days = page.getByRole("group", { name: "Days", exact: true });

		await days.getByRole("link", { name: "Next day" }).click();
		await expect.poll(async () => (await arrivals()).length).toBe(1);
		await days.getByRole("link", { name: "Previous day" }).click();
		await expect.poll(async () => (await arrivals()).length).toBe(2);

		const [later, earlier] = await arrivals();
		// The rail's axis is the vertical one: a later day arrives from below, an earlier one from above.
		expect(later?.[0]?.[1]).toBeGreaterThan(0);
		expect(earlier?.[0]?.[1]).toBeLessThan(0);
	});

	test.describe("with reduced motion requested", () => {
		test.use({ reducedMotion: "reduce" });

		test("nothing moves", async ({ page }) => {
			const arrivals = await watchArrivals(page);
			await trackingOrganisation(page);
			await page
				.getByRole("group", { name: "Days", exact: true })
				.getByRole("link", { name: "Next day" })
				.click();
			await expect(page).toHaveURL(/\?day=/);

			for (const moves of await arrivals()) {
				for (const [x, y] of moves) expect([x, y]).toEqual([0, 0]);
			}
		});
	});
});
