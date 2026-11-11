import type { Locator, Page } from "@playwright/test";

import { organisationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { EMPTY_INPUT, problems } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";
import { createProject } from "./timesheet";

// Timesheet in a browser: the timer on the Day view and in the navigation
// (TS-012a, TS-051), the Day and Week views and their links (TS-013), an entry
// by hand (TS-012b), the week's grid (TS-052), and submitting a week (TS-046).
// Each test is a new person with an organisation of their own: a person may
// create five, and the shared people's organisations are left as they are.

const COMPACT = { width: 390, height: 844 };
const MEDIUM = { width: 1280, height: 800 };

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

/**
 * Signs a new person in, who creates an organisation and, on Projects, one
 * project, Site. The Day view is open.
 */
async function trackingOrganisation(page: Page) {
	await signIn(page, newPerson().email);
	const organisation = await createOrganisation(page);
	await createProject(page, organisation.slug, "Site");
	await openShell(page, organisationPath(organisation.slug));
	return organisation;
}

const navigation = (page: Page) => page.getByRole("navigation", { name: "Main" });
const navTimer = (page: Page) => navigation(page).getByRole("timer", { name: "Elapsed" });
const dayTimer = (page: Page) => page.getByRole("main").getByRole("timer", { name: "Elapsed" });
const views = (page: Page) => page.getByRole("group", { name: "Timesheet views" });
/** The time a timer shows, as it is read out: once, not character by character. */
const elapsed = (timer: Locator) => timer.locator(".sr-only");

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

	await page.getByRole("button", { name: "Start timer" }).click();
	await expect(navTimer(page)).toBeVisible();
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

		await tabTo(page, page.getByRole("button", { name: "Start timer", exact: true }));
		await page.keyboard.press("Enter");
		await expect(navTimer(page)).toBeVisible();
		await page.clock.runFor(3_000);
		await expect(elapsed(dayTimer(page))).toHaveText(await elapsed(navTimer(page)).innerText());
		await page.clock.runFor(61_000);
		await expect(elapsed(dayTimer(page))).toHaveText(await elapsed(navTimer(page)).innerText());
		// A timer is never announced: no live region holds it.
		for (const timer of [navTimer(page), dayTimer(page)]) {
			await expect(
				timer.locator("xpath=ancestor-or-self::*[@aria-live][not(@aria-live='off')]"),
			).toHaveCount(0);
		}

		await tabTo(page, page.getByRole("button", { name: "Stop timer", exact: true }));
		await page.keyboard.press("Enter");
		await expect(navigation(page).getByRole("link", { name: "Start timer" })).toBeVisible();
		await expect(page.getByRole("main").getByText("Running")).toHaveCount(0);
	});

	test("is stopped from the navigation on another page, and the person stays there", async ({
		page,
	}) => {
		const { slug } = await trackingOrganisation(page);
		await page.getByRole("button", { name: "Start timer", exact: true }).click();
		await expect(navTimer(page)).toBeVisible();

		await navigation(page).getByRole("link", { name: "Reports" }).click();
		await expect(page).toHaveURL(new RegExp(`${organisationPath(slug)}/reports$`));
		await navigation(page).getByRole("button", { name: "Stop timer for Site" }).click();

		await expect(navigation(page).getByRole("link", { name: "Start timer" })).toBeVisible();
		await expect(page).toHaveURL(new RegExp(`${organisationPath(slug)}/reports$`));
	});

	test("Start timer in the navigation opens the Day view's timer form", async ({ page }) => {
		const { slug } = await trackingOrganisation(page);
		await navigation(page).getByRole("link", { name: "Reports" }).click();
		await navigation(page).getByRole("link", { name: "Start timer" }).click();

		await expect(page).toHaveURL(new RegExp(`${organisationPath(slug)}#timer$`));
		await expect(page.getByRole("button", { name: "Start timer", exact: true })).toBeVisible();
	});

	test("shows the same elapsed time in two browsers, and a stop in one shows in the other within 30 seconds", async ({
		browser,
		baseURL,
		page,
	}) => {
		const { slug } = await trackingOrganisation(page);
		await page.getByRole("button", { name: "Start timer", exact: true }).click();
		await expect(navTimer(page)).toBeVisible();
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
		const shown = await elapsed(navTimer(one.other)).innerText();
		await expect(elapsed(navTimer(two.other))).toHaveText(shown);
		await expect(elapsed(dayTimer(two.other))).toHaveText(shown);

		await one.other.getByRole("button", { name: "Stop timer", exact: true }).click();
		await expect(navigation(one.other).getByRole("link", { name: "Start timer" })).toBeVisible();
		await expect(navTimer(two.other)).toBeVisible();
		await two.other.clock.resume();
		await two.other.clock.runFor(30_000);
		await expect(navigation(two.other).getByRole("link", { name: "Start timer" })).toBeVisible();
		await one.context.close();
		await two.context.close();
	});

	test.describe("with reduced motion requested", () => {
		test.use({ reducedMotion: "reduce" });

		test("changes its digits without any animation", async ({ page }) => {
			await trackingOrganisation(page);
			await page.getByRole("button", { name: "Start timer", exact: true }).click();
			await expect(navTimer(page)).toBeVisible();
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
		await page.getByRole("button", { name: "Start timer", exact: true }).click();
		await expect(navTimer(page)).toBeVisible();

		await expect
			.poll(() =>
				dayTimer(page).evaluate((element) => element.getAnimations({ subtree: true }).length),
			)
			.toBeGreaterThan(0);
	});
});

test.describe("the Day view", () => {
	test("adds an entry from the keyboard alone, and shows it with its times", async ({ page }) => {
		await trackingOrganisation(page);
		await tabTo(page, page.getByRole("button", { name: "Add entry" }));
		await page.keyboard.press("Enter");
		const sheet = page.getByRole("dialog", { name: "Add an entry" });
		await expect(sheet).toBeVisible();

		await sheet.getByLabel("Start").focus();
		await page.keyboard.type("0900");
		await page.keyboard.press("Tab");
		await page.keyboard.type("1030");
		await page.keyboard.press("Tab");
		await page.keyboard.type("Survey");
		await page.keyboard.press("Enter");

		await expect(sheet).toBeHidden();
		await expect(page.getByRole("status").filter({ hasText: "Entry added." })).toBeVisible();
		await expect(page.getByRole("main")).toContainText("09:00–10:30");
		await expect(page.getByRole("main")).toContainText("Survey");
	});

	test("steps by day with links, later forward and earlier back, and Today returns", async ({
		page,
	}) => {
		const { slug } = await trackingOrganisation(page);
		const days = page.getByRole("group", { name: "Days" });

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
		await days.getByRole("link", { name: "Today" }).click();
		await expect(page).toHaveURL(new RegExp(`${organisationPath(slug)}$`));
		await expect(days.getByRole("link", { name: "Today" })).toHaveAttribute("aria-current", "page");
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
		await expect(
			page.getByRole("list", { name: "Periods" }).getByRole("listitem").first(),
		).toContainText("Submitted");
		await expect(
			page.getByRole("list", { name: "Periods" }).getByRole("listitem").first(),
		).toContainText("3:30");
	});

	test("steps by week with links reached by keyboard", async ({ page }) => {
		await trackingOrganisation(page);
		await page
			.getByRole("group", { name: "Timesheet views" })
			.getByRole("link", { name: "Week" })
			.click();
		const weeks = page.getByRole("group", { name: "Weeks" });

		await tabTo(page, weeks.getByRole("link", { name: "Previous week" }));
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/view=week&start=\d{4}-\d{2}-\d{2}$/);
		await weeks.getByRole("link", { name: "Next week" }).click();
		await weeks.getByRole("link", { name: "Next week" }).click();
		await weeks.getByRole("link", { name: "Today" }).click();
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
	if (!scrolls) return problems(page, [EMPTY_INPUT]);
	const found: string[] = [];
	for (const end of ["start", "end"] as const) {
		await grid.evaluate((element, to) => {
			element.scrollLeft = to === "start" ? 0 : element.scrollWidth;
		}, end);
		found.push(...(await problems(page, [EMPTY_INPUT, PARTLY_SCROLLED_AWAY])));
	}
	return found;
}

for (const viewport of [COMPACT, MEDIUM]) {
	for (const scheme of ["light", "dark"] as const) {
		test.describe(`at ${viewport.width}px in the ${scheme} scheme`, () => {
			test.use({ viewport, chosenScheme: scheme });

			test("axe finds nothing on the Day view empty and running, the Week view empty and filled, and History", async ({
				page,
			}) => {
				const { slug } = await trackingOrganisation(page);
				expect(await problems(page, [EMPTY_INPUT])).toEqual([]);

				await page.getByRole("button", { name: "Start timer", exact: true }).click();
				await expect(navTimer(page)).toBeVisible();
				expect(await problems(page, [EMPTY_INPUT])).toEqual([]);

				// The running entry gives the week a row; an hour typed into another of its days fills it.
				await openShell(page, `${organisationPath(slug)}?view=week`);
				expect(await gridProblems(page)).toEqual([]);
				const cell = page.getByRole("textbox", { name: /^Site, / }).first();
				await cell.fill("1");
				await cell.press("Tab");
				await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeAttached();
				expect(await gridProblems(page)).toEqual([]);

				await openShell(page, `${organisationPath(slug)}?view=history`);
				expect(await problems(page)).toEqual([]);
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
		const days = page.getByRole("group", { name: "Days" });

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
				.getByRole("group", { name: "Days" })
				.getByRole("link", { name: "Next day" })
				.click();
			await expect(page).toHaveURL(/\?day=/);

			for (const moves of await arrivals()) {
				for (const [x, y] of moves) expect([x, y]).toEqual([0, 0]);
			}
		});
	});
});
