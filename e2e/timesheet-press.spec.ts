import type { Page, Request, Route } from "@playwright/test";

import { destinationPath, organisationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";
import { createProject, pastWeekday } from "./timesheet";

// The Timesheet answers the press (TS-114, research/corporate/live-feel.md F1
// to F6, harvest sweep S2-01 to S2-04 and S2-15): a step or a view tab changes
// the date, the selected day and the tab before the server answers; a step to
// a neighbour the page has read lands from memory; Track time opens from what
// the page holds; the day picker draws its month before its totals; Projects
// filters as each key is typed; and a menu is gone at once on Escape. Each
// test is a new person with an organisation of their own, a project, Site,
// and an hour on a past weekday, so it holds on any day and at any hour.
// The page's own health (no uncaught error, no console error) is checked by
// the fixture on every test.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

const main = (page: Page) => page.getByRole("main");
const dayTitle = (page: Page) => main(page).getByRole("button", { name: /: choose a day$/ });
const shownChip = (page: Page) => main(page).locator("a[aria-current=date]");
const trackSheet = (page: Page) => page.getByRole("dialog", { name: "Track time" });

/** A new person's organisation with Site and an hour on a past weekday, open on that day. */
async function organisationWithAnHour(page: Page): Promise<{ slug: string; day: string }> {
	await signIn(page, newPerson().email);
	const { slug } = await createOrganisation(page);
	await createProject(page, slug, "Site");
	const day = await pastWeekday(page);
	await openShell(page, `${organisationPath(slug)}?day=${day}`);
	await main(page).getByRole("button", { name: "Track time", exact: true }).click();
	await trackSheet(page).getByRole("textbox", { name: "Hours" }).fill("1");
	await trackSheet(page).getByRole("button", { name: "Save entry" }).click();
	await expect(trackSheet(page)).toBeHidden();
	await expect(main(page)).toContainText("1:00");
	return { slug, day };
}

/** The day after `day`, as an address writes it. */
function dayAfter(day: string): string {
	const at = new Date(`${day}T00:00:00Z`);
	at.setUTCDate(at.getUTCDate() + 1);
	return at.toISOString().slice(0, 10);
}

/** The data requests (`.data`) the page makes from now on, by address. */
function dataRequests(page: Page): string[] {
	const seen: string[] = [];
	page.on("request", (request: Request) => {
		const url = new URL(request.url());
		if (url.pathname.endsWith(".data")) seen.push(`${url.pathname}${url.search}`);
	});
	return seen;
}

/**
 * Holds every request whose address matches `pattern` until the gate opens:
 * the server answers nothing the page asks for meanwhile. A request the page
 * gives up on while it is held is let go.
 */
async function holdRequests(page: Page, pattern: RegExp): Promise<() => Promise<void>> {
	let open: () => void = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	const handler = async (route: Route) => {
		await opened;
		await route.continue().catch(() => {});
	};
	await page.route(pattern, handler);
	return async () => {
		open();
		await page.unroute(pattern, handler);
	};
}

const TIMESHEET_DATA = /\/app\/[^/?]+\.data(\?|$)/;

for (const reducedMotion of ["no-preference", "reduce"] as const) {
	test.describe(`with ${reducedMotion} motion`, () => {
		test.use({ reducedMotion });

		test("a step and a tab answer the press before the server does, and a warm step lands from memory", async ({
			page,
		}) => {
			const { slug, day } = await organisationWithAnHour(page);
			const next = dayAfter(day);
			await openShell(page, `${organisationPath(slug)}?day=${day}`);
			await expect(shownChip(page)).toHaveAttribute("href", new RegExp(`day=${day}$`));

			// Nothing the page asks for is answered: not the step, nor its neighbours.
			const release = await holdRequests(page, TIMESHEET_DATA);
			const before = await dayTitle(page).getAttribute("aria-label");
			await main(page).getByRole("link", { name: "Next day" }).click();
			await expect(shownChip(page)).toHaveAttribute("href", new RegExp(`day=${next}$`), {
				timeout: 500,
			});
			await expect(dayTitle(page)).not.toHaveAttribute("aria-label", before ?? "");
			// What the day replaces dims until it comes.
			await expect(main(page).locator(".awaiting").first()).toBeVisible();

			// The tab is current from the press.
			await main(page).getByRole("link", { name: "Week", exact: true }).click();
			await expect(main(page).getByRole("link", { name: "Week", exact: true })).toHaveAttribute(
				"aria-current",
				"page",
				{ timeout: 500 },
			);
			await release();
			await expect(page).toHaveURL(/view=week/);
			await expect(main(page).getByRole("group", { name: "Weeks" })).toBeVisible();

			// Back on the day, the page reads the days either side once it is still.
			const requests = dataRequests(page);
			await openShell(page, `${organisationPath(slug)}?day=${day}`);
			await expect
				.poll(() => requests.filter((each) => each.includes(`day=${next}`)).length)
				.toBeGreaterThan(0);
			await page.waitForLoadState("networkidle");
			const releaseAgain = await holdRequests(page, TIMESHEET_DATA);
			await main(page).getByRole("link", { name: "Next day" }).click();
			await expect(shownChip(page)).toHaveAttribute("href", new RegExp(`day=${next}$`), {
				timeout: 500,
			});
			// The next day is drawn whole, from memory: nothing waits for it.
			await expect(main(page).locator(".awaiting")).toHaveCount(0);
			await releaseAgain();
			await expect(page).toHaveURL(new RegExp(`day=${next}`));
		});

		test("Track time opens from what the page holds, and the day picker draws its month before its totals", async ({
			page,
		}) => {
			const { slug, day } = await organisationWithAnHour(page);
			await openShell(page, `${organisationPath(slug)}?day=${day}`);
			await page.waitForLoadState("networkidle");

			const requests = dataRequests(page);
			await main(page).getByRole("button", { name: "Track time", exact: true }).click();
			await expect(trackSheet(page).getByRole("button", { name: "Save entry" })).toBeEnabled();
			await expect(trackSheet(page).getByRole("textbox", { name: "Date" })).toHaveValue(day);
			await page.keyboard.press("Escape");
			await expect(trackSheet(page)).toBeHidden();
			expect(requests.filter((each) => each.includes("/timesheet/day"))).toEqual([]);

			// The month's totals are held; its days are not.
			const release = await holdRequests(page, /\/timesheet\/month\.data/);
			await dayTitle(page).click();
			const picker = page.getByRole("dialog", { name: "Choose a day" });
			const days = picker.getByRole("link");
			await expect(picker).toBeVisible();
			expect(await days.count()).toBeGreaterThanOrEqual(28);
			await expect(picker).not.toContainText("Reading the month");
			const shown = picker.locator("a[aria-current=date]");
			await expect(shown).not.toHaveAttribute("aria-label", /tracked/);
			// Measured once the popover has finished opening: its scale is the
			// opening, not the totals.
			await expect
				.poll(() =>
					picker.evaluate(
						(dialog) => dialog.parentElement?.getAnimations({ subtree: true }).length,
					),
				)
				.toBe(0);
			const box = await picker.boundingBox();
			await release();
			await expect(shown).toHaveAttribute("aria-label", /1:00 tracked/);
			// The totals came with nothing moving.
			expect(await picker.boundingBox()).toEqual(box);
			await page.keyboard.press("Escape");
			await expect(picker).toBeHidden();
		});

		test("Projects filters as each key is typed, with no request, and keeps the words in the address", async ({
			page,
		}) => {
			const { slug } = await organisationWithAnHour(page);
			await createProject(page, slug, "Payroll");
			await openShell(page, destinationPath(slug, "projects"));
			await page.waitForLoadState("networkidle");

			const requests = dataRequests(page);
			const search = main(page).getByRole("searchbox", { name: "Search projects" });
			await search.focus();
			await page.keyboard.type("pay");
			await expect(main(page).getByRole("link", { name: "Payroll" })).toBeVisible();
			await expect(main(page).getByRole("link", { name: "Site" })).toBeHidden();
			await expect(page).toHaveURL(/[?&]q=pay$/);
			await page.keyboard.type("zz");
			await expect(main(page)).toContainText("No active project has “payzz” in its name");
			expect(requests).toEqual([]);

			// Back to every project: the list the page holds is whole again.
			await search.fill("");
			await expect(main(page).getByRole("link", { name: "Site" })).toBeVisible();
			await expect(page).toHaveURL(new RegExp(`${destinationPath(slug, "projects")}$`));
			expect(requests).toEqual([]);

			// The server's search stays: the address alone finds the same.
			await openShell(page, `${destinationPath(slug, "projects")}?q=pay`);
			await expect(main(page).getByRole("link", { name: "Payroll" })).toBeVisible();
			await expect(main(page).getByRole("link", { name: "Site" })).toBeHidden();
		});

		test("a menu is gone within 100 ms of Escape, and its button takes its state at once", async ({
			page,
		}) => {
			await signIn(page, newPerson().email);
			const { slug } = await createOrganisation(page);
			await openShell(page, organisationPath(slug));
			const trigger = page.getByRole("button", { name: /^Account menu for/ });
			await trigger.click();
			await expect(page.getByRole("menu")).toBeVisible();
			await page.evaluate(() => {
				window.addEventListener(
					"keydown",
					() => {
						(window as unknown as { escapedAt: number }).escapedAt = performance.now();
					},
					{ capture: true, once: true },
				);
			});
			await page.keyboard.press("Escape");
			const gone = await page.evaluate(
				() =>
					new Promise<{ after: number; moving: number }>((resolve) => {
						const check = () => {
							if (document.querySelector("[role=menu]")) {
								requestAnimationFrame(check);
								return;
							}
							const { escapedAt } = window as unknown as { escapedAt: number };
							resolve({
								after: performance.now() - escapedAt,
								moving: document.getAnimations().filter((each) => each instanceof CSSTransition)
									.length,
							});
						};
						check();
					}),
			);
			expect(gone.after).toBeLessThanOrEqual(100);
			expect(gone.moving).toBe(0);
			await expect(trigger).toBeFocused();
		});
	});
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });

			test("the day, its picker before its totals, and Projects filtered in the page have no accessibility violations", async ({
				page,
			}) => {
				const { slug, day } = await organisationWithAnHour(page);
				await openShell(page, `${organisationPath(slug)}?day=${day}`);
				expect(await problems(page)).toEqual([]);

				const release = await holdRequests(page, /\/timesheet\/month\.data/);
				await dayTitle(page).click();
				const picker = page.getByRole("dialog", { name: "Choose a day" });
				await expect(picker.locator("a[aria-current=date]")).toBeVisible();
				expect(await problems(page, [UNDER_AN_OVERLAY])).toEqual([]);
				await release();
				await expect(picker.locator("a[aria-current=date]")).toHaveAttribute(
					"aria-label",
					/tracked/,
				);
				expect(await problems(page, [UNDER_AN_OVERLAY])).toEqual([]);
				await page.keyboard.press("Escape");
				await expect(picker).toBeHidden();

				await openShell(page, destinationPath(slug, "projects"));
				await main(page).getByRole("searchbox", { name: "Search projects" }).fill("si");
				await expect(page).toHaveURL(/[?&]q=si$/);
				await expect(main(page).getByRole("link", { name: "Site" })).toBeVisible();
				expect(await problems(page)).toEqual([]);
			});
		});
	}
}
