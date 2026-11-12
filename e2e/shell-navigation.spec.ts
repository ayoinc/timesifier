import type { Locator, Page } from "@playwright/test";

import {
	accountPath,
	compactNavigation,
	type Destination,
	destinations,
	HEADINGS,
} from "../app/shell/destinations";
import { openProfileMenu, profileButton } from "./auth";
import { SIGNED_IN_AS_MEMBER } from "./auth-state";
import { destinationLinks, expect, openShell, test } from "./fixtures";
import { homeOrganisation, homePath } from "./organisation";

// The shell's navigation, landmarks and focus (TS-006, criteria 1 and 3), and
// its headings by role (TS-053), and its compact form under 600px (TS-064;
// audit W03 and W11). Every path and label comes from the one list of
// destinations. The person signed in owns the organisation, so is shown every
// destination; the member of it is shown four.

const COMPACT = { width: 390, height: 844 };
const MEDIUM = { width: 1280, height: 800 };

const [first, ...others] = destinations as [Destination, ...Destination[]];
const last = destinations.at(-1) as Destination;

function navigation(page: Page): Locator {
	return page.getByRole("navigation", { name: "Main" });
}

/** "More", last in the bar under 600px, which opens the destinations the bar has no room for. */
function more(page: Page): Locator {
	return navigation(page).getByRole("button", { name: /^More\b/ });
}

/** The destinations' list, with its headings, apart from what More opens. */
function destinationList(page: Page): Locator {
	return navigation(page).locator("ul").first();
}

/** What More opens. */
function morePopover(page: Page): Locator {
	return page.locator("#navigation-more");
}

/** Whether the window is under 600px, where the navigation is the bar. */
function isCompact(page: Page): boolean {
	return (page.viewportSize()?.width ?? MEDIUM.width) < 600;
}

/** What the bar under 600px holds for the owner, and what More holds, by docs/navigation.md. */
const OWNERS_COMPACT = compactNavigation(destinations.map(({ id }) => id));
const IN_MORE = OWNERS_COMPACT.more.flatMap((group) => group.destinations);

/** The link to `destination`, opening More first when the bar under 600px has no room for it. */
async function linkTo(page: Page, destination: Destination): Promise<Locator> {
	const link = navigation(page).getByRole("link", { name: destination.label, exact: true });
	if (isCompact(page) && IN_MORE.includes(destination) && !(await morePopover(page).isVisible())) {
		await more(page).click();
		await expect(morePopover(page)).toBeVisible();
	}
	return link;
}

function title(destination: Destination): string {
	return `${destination.label} · Timesifier`;
}

/**
 * The destination's own address. A page may then write what it opened on into
 * the query (Approvals writes its week and status, TS-094), so the query is
 * allowed; the path is exact.
 */
function atDestination(destination: Destination): RegExp {
	const path = homePath(destination.id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`${path}(\\?[^#]*)?$`);
}

type Box = { x: number; y: number; width: number; height: number };

async function box(element: Locator): Promise<Box> {
	const found = await element.boundingBox();
	if (!found) throw new Error("the element is not drawn");
	return found;
}

/** Where the navigation and each of its links are drawn; under 600px, More is the last. */
async function drawn(page: Page): Promise<{ container: Box; links: Box[] }> {
	const links = await destinationLinks(page).all();
	if (isCompact(page) && (await more(page).count()) > 0) links.push(more(page));
	return { container: await box(navigation(page)), links: await Promise.all(links.map(box)) };
}

/**
 * A navigation bar: along the bottom edge, as wide as the window, its
 * destinations and More side by side in one row, each with an equal share of
 * the width, at least 48px tall and 44px wide to press, their labels apart and
 * in type no smaller than 12px (audit W03), and no heading.
 */
async function expectBar(page: Page) {
	const window = page.viewportSize() ?? COMPACT;
	const { container, links } = await drawn(page);

	expect(container.x).toBe(0);
	expect(container.width).toBe(window.width);
	expect(container.y + container.height).toBe(window.height);
	// No rail: nothing of the navigation runs up the side of the window.
	expect(container.height).toBe(64);

	expect(new Set(links.map((link) => link.y)).size, "the destinations are in one row").toBe(1);
	const lefts = links.map((link) => link.x);
	expect(lefts).toEqual([...lefts].sort((a, b) => a - b));
	expect(new Set(lefts).size).toBe(links.length);
	expect(links.length, "four or five items, as audit W03 asks").toBeLessThanOrEqual(5);
	const widths = links.map((link) => link.width);
	expect(Math.max(...widths) - Math.min(...widths), "an equal share each").toBeLessThanOrEqual(1);
	for (const link of links) {
		expect(link.width).toBeGreaterThanOrEqual(44);
		expect(link.height).toBeGreaterThanOrEqual(48);
	}
	// The labels, not only the targets, stand apart: at least 8px between the
	// end of one and the start of the next.
	const items = await destinationLinks(page).all();
	if (await more(page).count()) items.push(more(page));
	const labels = await Promise.all(items.map((item) => box(item.locator("span").first())));
	for (let i = 1; i < labels.length; i++) {
		const [before, after] = [labels[i - 1] as Box, labels[i] as Box];
		expect(after.x - (before.x + before.width), "the labels stand apart").toBeGreaterThanOrEqual(8);
	}
	for (const item of items) {
		const size = await item.evaluate((element) =>
			Number.parseFloat(getComputedStyle(element).fontSize),
		);
		expect(size).toBeGreaterThanOrEqual(12);
	}
	for (const heading of HEADINGS) {
		await expect(destinationList(page).getByText(heading, { exact: true })).toBeHidden();
	}
}

/** A column of links beside the page, under the band, its destinations stacked. */
async function expectRail(page: Page) {
	const window = page.viewportSize() ?? MEDIUM;
	const { container, links } = await drawn(page);
	const band = await box(page.getByRole("banner"));

	// At the start of the page's column, under the band.
	expect(container.x).toBeGreaterThan(0);
	expect(container.x).toBeLessThan(window.width / 2);
	expect(container.y).toBeGreaterThanOrEqual(band.y + band.height);
	// No bar: nothing of the navigation runs along the bottom of the window.
	expect(container.y + container.height).toBeLessThan(window.height);
	expect(container.width).toBe(96);

	expect(new Set(links.map((link) => link.x)).size, "the destinations are in one column").toBe(1);
	const tops = links.map((link) => link.y);
	expect(tops).toEqual([...tops].sort((a, b) => a - b));
	expect(new Set(tops).size).toBe(links.length);
	// Each heading stands above its first link, and each link below its heading.
	for (const heading of HEADINGS) {
		const label = await box(destinationList(page).getByText(heading, { exact: true }));
		const under = destinations.filter((each) => each.heading === heading);
		for (const each of under) {
			const link = await box(navigation(page).getByRole("link", { name: each.label, exact: true }));
			expect(link.y, `${each.label} is under ${heading}`).toBeGreaterThan(label.y);
		}
	}
}

/** Each of `shown` is a link to its own address, marked current when it is `current`. */
async function expectLinks(scope: Locator, shown: readonly Destination[], current: Destination) {
	for (const destination of shown) {
		const link = scope.getByRole("link", { name: destination.label, exact: true });
		await expect(link).toHaveAttribute("href", homePath(destination.id));
		if (destination === current) await expect(link).toHaveAttribute("aria-current", "page");
		else await expect(link).not.toHaveAttribute("aria-current");
	}
}

/**
 * The same links, by role and name, in the order of the list, each to its own
 * address. Under 600px the bar holds some and More the rest, under their
 * headings; More reads as current when the page on screen is one of its own.
 */
async function expectDestinations(page: Page, current: Destination) {
	const links = destinationLinks(page);
	if (!isCompact(page)) {
		// What is drawn: a bar label (Settings) is hidden from 600px.
		await expect(links).toHaveText(
			destinations.map((destination) => destination.label),
			{ useInnerText: true },
		);
		await expectLinks(navigation(page), destinations, current);
		return;
	}
	const bar = destinations.filter(({ id }) => OWNERS_COMPACT.bar.includes(id));
	await expect(links).toHaveText(bar.map((destination) => destination.label));
	await expectLinks(navigation(page), bar, current);

	const inMore = IN_MORE.includes(current);
	await expect(more(page)).toHaveAccessibleName(inMore ? `More, now on ${current.label}` : "More");
	await expect(morePopover(page)).toBeHidden();
	await more(page).click();
	await expect(morePopover(page)).toBeVisible();
	await expect(morePopover(page).getByRole("link")).toHaveText(IN_MORE.map(({ label }) => label));
	for (const { heading } of OWNERS_COMPACT.more) {
		if (heading) await expect(morePopover(page).getByText(heading, { exact: true })).toBeVisible();
	}
	await expectLinks(morePopover(page), IN_MORE, current);
	await page.keyboard.press("Escape");
	await expect(morePopover(page)).toBeHidden();
}

/**
 * The content is beside or above the navigation, never under it: scrolled to
 * its end, the last of a page taller than the window still clears the bar.
 */
async function expectContentClearOfNavigation(page: Page) {
	await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
	const content = await box(page.getByRole("main"));
	const { container } = await drawn(page);
	const apart =
		content.x >= container.x + container.width || content.y + content.height <= container.y;
	expect(apart, "the main region does not lie under the navigation").toBe(true);
}

/**
 * The heights of the rows fixed across the whole width of the window, from
 * the top: what covers the page whatever it scrolls to (audit W11).
 */
async function fixedRows(page: Page): Promise<number[]> {
	return page.evaluate(() =>
		[...document.querySelectorAll<HTMLElement>("body *")]
			.filter((element) => {
				if (getComputedStyle(element).position !== "fixed") return false;
				const { width, height } = element.getBoundingClientRect();
				return height > 0 && width >= window.innerWidth * 0.9;
			})
			.map((element) => element.getBoundingClientRect())
			.sort((a, b) => a.top - b.top)
			.map(({ height }) => Math.round(height)),
	);
}

async function focused(page: Page): Promise<string> {
	return page.evaluate(() => {
		const element = document.activeElement;
		return element ? `${element.localName}: ${element.textContent?.trim()}` : "nothing";
	});
}

test.describe("in a window 390px wide", () => {
	test.use({ viewport: COMPACT });

	test("the navigation is a bar along the bottom, with More holding the rest", async ({ page }) => {
		await openShell(page, homePath(first.id));

		await expectBar(page);
		await expectDestinations(page, first);
		await expectContentClearOfNavigation(page);
	});

	test("every item of the bar fits in it, whole, and so does every link More opens", async ({
		page,
	}) => {
		await openShell(page, homePath(last.id));

		for (const link of await destinationLinks(page).all()) {
			await expect(link).toBeInViewport({ ratio: 1 });
		}
		await expect(more(page)).toBeInViewport({ ratio: 1 });
		await more(page).click();
		for (const link of await morePopover(page).getByRole("link").all()) {
			await expect(link).toBeInViewport({ ratio: 1 });
			expect((await box(link)).height).toBeGreaterThanOrEqual(48);
		}
	});

	test("a destination in More is opened from it, which closes, and More reads as current", async ({
		page,
	}) => {
		await openShell(page, homePath(first.id));
		const target = IN_MORE.at(-1) as Destination;

		await (await linkTo(page, target)).click();
		await expect(page).toHaveURL(homePath(target.id));
		await expect(morePopover(page)).toBeHidden();
		await expect(more(page)).toHaveAccessibleName(`More, now on ${target.label}`);
		// The rule that marks the current destination is drawn under More.
		await expect(more(page).locator("span[aria-hidden]")).toBeVisible();
	});

	test("Track time floats above the bar, the one fixed row besides it, and is not on the Timesheet", async ({
		page,
	}) => {
		const projects = destinations.find(({ id }) => id === "projects") as Destination;
		await openShell(page, homePath(projects.id));
		const track = navigation(page).getByRole("button", { name: "Track time", exact: true });
		const bar = await box(navigation(page));

		// A button at the bottom right, above the bar, not a row across the page (audit W11).
		const button = await box(track);
		expect(button.height).toBeGreaterThanOrEqual(48);
		expect(button.width).toBeGreaterThanOrEqual(48);
		expect(button.width).toBeLessThan(COMPACT.width / 2);
		expect(button.x + button.width).toBeLessThanOrEqual(COMPACT.width - 16);
		expect(button.y + button.height).toBeLessThanOrEqual(bar.y - 8);
		// Polled: the pending bar is a fixed row too, for as long as a load runs.
		await expect.poll(() => fixedRows(page)).toEqual([64]);
		await expectContentClearOfNavigation(page);

		// On the Timesheet, the page's own Track time is the one control.
		await navigation(page).getByRole("link", { name: first.label, exact: true }).click();
		await expect(page).toHaveURL(homePath(first.id));
		await expect(track).toBeHidden();
		// No second control under another name: at most the page's own button.
		expect(
			await page.getByRole("button", { name: "Track time", exact: true }).count(),
		).toBeLessThanOrEqual(1);
		await expect(page.getByRole("button", { name: "Track time", exact: true })).toHaveCount(0);
		await expect(page.getByText("Start timer", { exact: true })).toHaveCount(0);
		await expect.poll(() => fixedRows(page)).toEqual([64]);
	});
});

test.describe("in a window 1280px wide", () => {
	test.use({ viewport: MEDIUM });

	test("the navigation is a rail down the side with the same destinations under their headings", async ({
		page,
	}) => {
		await openShell(page, homePath(first.id));

		await expectRail(page);
		await expectDestinations(page, first);
		await expectContentClearOfNavigation(page);
	});

	test("the timer's control stands before the first heading: Track time while nothing runs", async ({
		page,
	}) => {
		// On Timesheet the page's own Track time is the one way to track; elsewhere it heads the rail.
		const projects = destinations.find(({ id }) => id === "projects") as Destination;
		await openShell(page, homePath(projects.id));

		const before = await navigation(page).evaluate((nav) => nav.firstElementChild?.textContent);
		expect(before).toBe("Track time");
	});

	test("the profile menu is in the band, beside the organisation's name, and leads to My account", async ({
		page,
	}) => {
		await openShell(page, homePath(first.id));
		const band = page.getByRole("banner");
		await expect(band.getByRole("link", { name: "My account" })).toHaveCount(0);
		const name = await box(band.getByText(homeOrganisation().name, { exact: true }));
		const avatar = await box(profileButton(page));
		expect(avatar.x).toBeGreaterThan(name.x + name.width);

		await (await openProfileMenu(page)).getByRole("menuitem", { name: "Account settings" }).click();
		await expect(page).toHaveURL(accountPath(homeOrganisation().slug));
		await expect(page.getByRole("heading", { level: 1, name: "My account" })).toBeFocused();
		await expect(navigation(page).locator('[aria-current="page"]')).toHaveCount(0);
	});
});

test.describe("signed in as a member of the organisation", () => {
	test.use({ storageState: SIGNED_IN_AS_MEMBER, viewport: MEDIUM });

	test("the navigation shows Timesheet, Time off, Expenses, Projects and Reports, each under its heading", async ({
		page,
	}) => {
		await openShell(page, homePath(first.id));

		await expect(destinationLinks(page)).toHaveText([
			"Timesheet",
			"Time off",
			"Expenses",
			"Projects",
			"Reports",
		]);
		for (const heading of HEADINGS) {
			const shown = heading !== "Bill";
			const label = destinationList(page).getByText(heading, { exact: true });
			if (shown) await expect(label).toBeVisible();
			else await expect(label).toHaveCount(0);
		}
	});

	test("under 600px every link is in the bar, and there is no More", async ({ page }) => {
		await page.setViewportSize(COMPACT);
		await openShell(page, homePath(first.id));

		await expect(destinationLinks(page)).toHaveText([
			"Timesheet",
			"Time off",
			"Expenses",
			"Projects",
			"Reports",
		]);
		await expect(more(page)).toHaveCount(0);
		await expectBar(page);
	});
});

test("the bar becomes the rail at 600px, and back, without the page loading again", async ({
	page,
}) => {
	await page.setViewportSize({ width: 599, height: 800 });
	await openShell(page, homePath(last.id));
	await page.evaluate(() => {
		document.documentElement.dataset.loadedOnce = "yes";
	});
	await expectBar(page);

	await page.setViewportSize({ width: 600, height: 800 });
	await expectRail(page);
	await expectDestinations(page, last);

	await page.setViewportSize({ width: 599, height: 800 });
	await expectBar(page);
	await expectDestinations(page, last);

	// The mark made before the first resize is still there: it is the same document.
	await expect(page.locator("html")).toHaveAttribute("data-loaded-once", "yes");
});

test.describe("without script", () => {
	// No script runs, so nothing can have measured the window: the layout is CSS alone.
	test.use({ javaScriptEnabled: false, viewport: COMPACT });

	test("the server sends one navigation that is right at both widths, and its links work", async ({
		page,
	}) => {
		await page.goto(homePath(first.id));
		await expectBar(page);
		// More is the browser's own popover, which opens without script.
		await expectDestinations(page, first);

		await page.setViewportSize(MEDIUM);
		await expectRail(page);

		await navigation(page).getByRole("link", { name: last.label, exact: true }).click();
		await expect(page).toHaveURL(homePath(last.id));
		await expect(page.getByRole("heading", { level: 1, name: last.label })).toBeVisible();
	});
});

test("a signed-in person who opens the home page arrives in their organisation, never on the home page", async ({
	page,
}) => {
	await page.goto("/");

	await expect(page).toHaveURL(homePath(first.id));
	await expect(page.getByRole("heading", { level: 1, name: first.label })).toBeVisible();
	await expectDestinations(page, first);
});

for (const viewport of [COMPACT, MEDIUM]) {
	test.describe(`in a window ${viewport.width}px wide`, () => {
		test.use({ viewport });

		test("the first Tab reaches a skip link, and Enter moves the focus into the main region", async ({
			page,
		}) => {
			await openShell(page, homePath(first.id));
			// A full page load leaves the focus where the browser puts it.
			expect(await focused(page)).toMatch(/^body: /);

			await page.keyboard.press("Tab");
			const skip = page.getByRole("link", { name: "Skip to main content" });
			await expect(skip).toBeFocused();
			await expect(skip).toBeInViewport({ ratio: 1 });

			await page.keyboard.press("Enter");
			await expect(page.getByRole("main")).toBeFocused();
			await expect(page).toHaveURL(homePath(first.id));
		});

		test("the page has one navigation landmark with a name and one main landmark", async ({
			page,
		}) => {
			await openShell(page, homePath(first.id));

			await expect(page.getByRole("navigation")).toHaveCount(1);
			await expect(navigation(page)).toBeVisible();
			await expect(page.getByRole("main")).toHaveCount(1);
			await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toHaveCount(1);
			// The public pages' band is at the top, the one banner.
			await expect(page.getByRole("banner")).toHaveCount(1);
		});

		test("after a move to each destination the focus is on its heading and the title has changed", async ({
			page,
		}) => {
			await openShell(page, homePath(first.id));
			await expect(page).toHaveTitle(title(first));

			// Every other destination, then back to the first.
			for (const destination of [...others, first]) {
				const before = await page.title();
				await (await linkTo(page, destination)).click();

				await expect(page).toHaveURL(atDestination(destination));
				await expect(
					page.getByRole("heading", { level: 1, name: destination.label, exact: true }),
				).toBeFocused();
				expect(await focused(page)).toBe(`h1: ${destination.label}`);
				await expect(page).toHaveTitle(title(destination));
				expect(await page.title()).not.toBe(before);
				await expectDestinations(page, destination);
			}
		});

		test("every destination is reached with Tab and Enter alone", async ({ page }) => {
			await openShell(page, homePath(first.id));
			// Where a move to a destination leaves the focus: on its heading. The walk
			// starts there, as each step after the first does.
			await page.getByRole("heading", { level: 1, name: first.label, exact: true }).focus();

			for (const destination of [...others, first]) {
				const link = navigation(page).getByRole("link", { name: destination.label, exact: true });
				// Under 600px a destination More holds is reached by More: Tab to it,
				// Enter opens it, and Tab goes on into what it opened.
				const throughMore = isCompact(page) && IN_MORE.includes(destination);
				const stop = throughMore ? more(page) : link;
				// Shift+Tab goes back from the heading into the navigation, which comes
				// before it: the link is one of a handful of stops, however much the
				// page below the heading holds.
				for (let presses = 0; presses < 24; presses++) {
					if (await stop.evaluate((element) => element === document.activeElement)) break;
					await page.keyboard.press("Shift+Tab");
				}
				await expect(stop).toBeFocused();
				if (throughMore) {
					await page.keyboard.press("Enter");
					await expect(morePopover(page)).toBeVisible();
					for (let presses = 0; presses < 16; presses++) {
						if (await link.evaluate((element) => element === document.activeElement)) break;
						await page.keyboard.press("Tab");
					}
				}
				await expect(link).toBeFocused();
				// The keyboard's focus indicator is drawn around the link's label in
				// the navigation, and inside the row in More.
				await expect(throughMore ? link : link.locator("span").first()).toHaveCSS(
					"outline-style",
					"solid",
				);

				await page.keyboard.press("Enter");
				await expect(page).toHaveURL(atDestination(destination));
				await expect(
					page.getByRole("heading", { level: 1, name: destination.label, exact: true }),
				).toBeFocused();
			}
		});
	});
}
