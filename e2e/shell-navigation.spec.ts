import type { Locator, Page } from "@playwright/test";

import { accountPath, type Destination, destinations, HEADINGS } from "../app/shell/destinations";
import { SIGNED_IN_AS_MEMBER } from "./auth-state";
import { destinationLinks, expect, openShell, test } from "./fixtures";
import { homeOrganisation, homePath } from "./organisation";

// The shell's navigation, landmarks and focus (TS-006, criteria 1 and 3), and
// its headings by role (TS-053). Every path and label comes from the one list
// of destinations. The person signed in owns the organisation, so is shown
// every destination; the member of it is shown three.

const COMPACT = { width: 390, height: 844 };
const MEDIUM = { width: 1280, height: 800 };

const [first, ...others] = destinations as [Destination, ...Destination[]];
const last = destinations.at(-1) as Destination;

function navigation(page: Page): Locator {
	return page.getByRole("navigation", { name: "Main" });
}

function title(destination: Destination): string {
	return `${destination.label} · Timesifier`;
}

type Box = { x: number; y: number; width: number; height: number };

async function box(element: Locator): Promise<Box> {
	const found = await element.boundingBox();
	if (!found) throw new Error("the element is not drawn");
	return found;
}

/** Where the navigation and each of its links are drawn. */
async function drawn(page: Page): Promise<{ container: Box; links: Box[] }> {
	const links = await destinationLinks(page).all();
	return { container: await box(navigation(page)), links: await Promise.all(links.map(box)) };
}

/**
 * A navigation bar: along the bottom edge, as wide as the window, its
 * destinations side by side in one row, and no heading.
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
	for (const heading of HEADINGS) {
		await expect(navigation(page).getByText(heading, { exact: true })).toBeHidden();
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
		const label = await box(navigation(page).getByText(heading, { exact: true }));
		const under = destinations.filter((each) => each.heading === heading);
		for (const each of under) {
			const link = await box(navigation(page).getByRole("link", { name: each.label, exact: true }));
			expect(link.y, `${each.label} is under ${heading}`).toBeGreaterThan(label.y);
		}
	}
}

/** The same links, by role and name, in the order of the list, each to its own address. */
async function expectDestinations(page: Page, current: Destination) {
	const links = destinationLinks(page);
	// A link with a bar label holds both words; its label alone is what is read out.
	await expect(links).toHaveText(
		destinations.map((destination) => `${destination.barLabel ?? ""}${destination.label}`),
	);
	for (const destination of destinations) {
		const link = navigation(page).getByRole("link", { name: destination.label, exact: true });
		await expect(link).toHaveAttribute("href", homePath(destination.id));
		if (destination === current) await expect(link).toHaveAttribute("aria-current", "page");
		else await expect(link).not.toHaveAttribute("aria-current");
	}
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

async function focused(page: Page): Promise<string> {
	return page.evaluate(() => {
		const element = document.activeElement;
		return element ? `${element.localName}: ${element.textContent?.trim()}` : "nothing";
	});
}

test.describe("in a window 390px wide", () => {
	test.use({ viewport: COMPACT });

	test("the navigation is a bar along the bottom with every destination", async ({ page }) => {
		await openShell(page, homePath(first.id));

		await expectBar(page);
		await expectDestinations(page, first);
		await expectContentClearOfNavigation(page);
	});

	test("every destination an owner is shown fits in the bar, whole", async ({ page }) => {
		await openShell(page, homePath(last.id));

		for (const link of await destinationLinks(page).all()) {
			await expect(link).toBeInViewport({ ratio: 1 });
		}
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

	test("the timer's control stands before the first heading: Start timer while nothing runs", async ({
		page,
	}) => {
		await openShell(page, homePath(first.id));

		const before = await navigation(page).evaluate((nav) => nav.firstElementChild?.textContent);
		expect(before).toBe("Start timer");
	});

	test("My account is in the band, beside the organisation's name", async ({ page }) => {
		await openShell(page, homePath(first.id));
		const account = page.getByRole("banner").getByRole("link", { name: "My account" });

		await account.click();
		await expect(page).toHaveURL(accountPath(homeOrganisation().slug));
		await expect(page.getByRole("heading", { level: 1, name: "My account" })).toBeFocused();
		await expect(account).toHaveAttribute("aria-current", "page");
		await expect(navigation(page).locator('[aria-current="page"]')).toHaveCount(0);
	});
});

test.describe("signed in as a member of the organisation", () => {
	test.use({ storageState: SIGNED_IN_AS_MEMBER, viewport: MEDIUM });

	test("the navigation shows Timesheet, Time off, Projects and Reports, each under its heading", async ({
		page,
	}) => {
		await openShell(page, homePath(first.id));

		await expect(destinationLinks(page)).toHaveText([
			"Timesheet",
			"Time off",
			"Projects",
			"Reports",
		]);
		for (const heading of HEADINGS) {
			await expect(navigation(page).getByText(heading, { exact: true })).toBeVisible();
		}
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
				await navigation(page).getByRole("link", { name: destination.label, exact: true }).click();

				await expect(page).toHaveURL(homePath(destination.id));
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
				// Shift+Tab goes back from the heading into the navigation, which comes
				// before it: the link is one of a handful of stops, however much the
				// page below the heading holds.
				for (let presses = 0; presses < 12; presses++) {
					if (await link.evaluate((element) => element === document.activeElement)) break;
					await page.keyboard.press("Shift+Tab");
				}
				await expect(link).toBeFocused();
				// The keyboard's focus indicator is drawn around the link's label.
				await expect(link.locator("span").first()).toHaveCSS("outline-style", "solid");

				await page.keyboard.press("Enter");
				await expect(page).toHaveURL(homePath(destination.id));
				await expect(
					page.getByRole("heading", { level: 1, name: destination.label, exact: true }),
				).toBeFocused();
			}
		});
	});
}
