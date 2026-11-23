import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { organisationPath } from "../app/shell/destinations";
import { MENU_COOKIE } from "../app/shell/menu";
import { newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { DIGIT_CHANGING, problems } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";
import { afternoonZone, createProject, workEveryDay } from "./timesheet";

// The sweep's small feel details in a browser (TS-123, research/harvest-sweep-2.md):
// the steppers and the date picker say where today is (S2-14); a copy that
// cannot be made is there, disabled, reached by Tab and read with its reason
// (S2-13); and the navigation's column tucks away for wide work, by its
// button and by Ctrl+\, comes back the same way, keeps a running timer
// stoppable, survives a reload, and moves no further than reduced motion
// allows (S2-10). At 390 and 1280px in both schemes, with no WCAG 2.2 A or AA
// violation. The screenshots go where the card's review reads them.

const SHOTS =
	process.env.SHOT_DIR ??
	"/Users/ayodele.ajayi/Workspace/Personal/cmux-assets/browser/timesifier/TS-123";

// Hours are tracked today, which has room for them once they have passed (W08).
test.use({ storageState: SIGNED_OUT, timezoneId: afternoonZone() });
test.describe.configure({ timeout: TIME_WITH_TURNS * 2 });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

const COMPACT = { width: 390, height: 844 };
const MEDIUM = { width: 1280, height: 800 };

const main = (page: Page) => page.getByRole("main");
const navigation = (page: Page) => page.getByRole("navigation", { name: "Main" });
const toggle = (page: Page) =>
	page.getByRole("banner").getByRole("button", { name: /^(Hide menu|Menu)$/ });
/** What the navigation reads out after the menu changes. */
const announced = (page: Page) => page.getByRole("banner").locator("[aria-live=polite]");

/**
 * A new person's organisation with a project, Site, every day of the week a
 * working day, so today takes time whatever day the test runs (TS-095), and
 * nothing tracked yet anywhere.
 */
async function emptyOrganisation(page: Page) {
	await signIn(page, newPerson().email);
	const organisation = await createOrganisation(page);
	await createProject(page, organisation.slug, "Site");
	await workEveryDay(page, organisation.slug);
	return organisation;
}

/** Presses Tab until `target` has the focus. */
async function tabTo(page: Page, target: Locator, most = 80) {
	for (let step = 0; step < most; step++) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press("Tab");
	}
	throw new Error("Tab never reached the control.");
}

/**
 * A screenshot of the window with the focused control in its middle, so the
 * fixed bar under 600px never lies across what is being shown.
 */
async function shot(page: Page, name: string) {
	mkdirSync(SHOTS, { recursive: true });
	await page.evaluate(() =>
		(document.activeElement as HTMLElement | null)?.scrollIntoView({ block: "center" }),
	);
	await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/**
 * The page's problems, scanned from its top: Tab scrolls the window to the
 * control it reaches, and text the band or the bar then lies across cannot
 * be measured. The focus stays where it is.
 */
async function problemsFromTheTop(page: Page, unmeasurable: string[] = []) {
	await page.evaluate(() => window.scrollTo(0, 0));
	return problems(page, unmeasurable);
}

for (const viewport of [COMPACT, MEDIUM]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });
			const at = `${viewport.width}-${colorScheme}`;

			test("the labels say where today is, and a copy that cannot be made says why, by the keyboard (S2-14, S2-13)", async ({
				page,
			}) => {
				const { slug } = await emptyOrganisation(page);
				await openShell(page, organisationPath(slug));

				// The Day view's title, today and then yesterday by `[`.
				const title = main(page).getByRole("button", { name: /: choose a day$/ });
				await expect(title).toHaveAccessibleName(/^Today, \w{3} \d{1,2}: choose a day$/);
				await main(page).getByRole("heading", { level: 1 }).focus();
				await page.keyboard.press("[");
				await expect(title).toHaveAccessibleName(/^Yesterday, \w{3} \d{1,2}: choose a day$/);
				await page.keyboard.press("]");
				await expect(title).toHaveAccessibleName(/^Today, /);

				// Today is empty and there is nothing to copy: the copy is there, reached by Tab, and says why.
				const copyDay = main(page).getByRole("button", { name: "Copy last working day's entries" });
				await tabTo(page, copyDay);
				await expect(copyDay).toBeFocused();
				await expect(copyDay).toHaveAttribute("aria-disabled", "true");
				await expect(copyDay).toHaveAccessibleDescription(
					"No working day in the last three weeks has time to copy.",
				);
				await expect(main(page)).toContainText(
					"No working day in the last three weeks has time to copy.",
				);
				// Pressed, it does nothing: nothing is sent and the focus stays.
				await page.keyboard.press("Enter");
				await expect(copyDay).toBeFocused();
				await expect(page.locator("[data-snackbar]")).toBeHidden();
				expect(await problemsFromTheTop(page), "problems on the Day view").toEqual([]);
				await shot(page, `day-copy-${at}`);

				// The Week view: This week, then Last week by the stepper, the dates kept beneath.
				await openShell(page, `${organisationPath(slug)}?view=week`);
				const weeks = main(page).getByRole("group", { name: "Weeks" });
				await expect(weeks).toContainText("This week");
				await expect(weeks).toContainText(/\d{1,2}.+\d{4}/);
				const copyWeek = main(page).getByRole("button", { name: "Copy last week with hours" });
				await tabTo(page, copyWeek);
				await expect(copyWeek).toHaveAttribute("aria-disabled", "true");
				await expect(copyWeek).toHaveAccessibleDescription(
					"No week in the last three has time to copy.",
				);
				// Under 600px the week's grid scrolls across in its own frame, and the
				// columns it cuts at its edge cannot be measured; from 600px it is whole.
				expect(
					await problemsFromTheTop(page, viewport.width < 600 ? ["elmPartiallyObscured"] : []),
					"problems on the Week view",
				).toEqual([]);
				await shot(page, `week-copy-${at}`);

				await weeks.getByRole("link", { name: "Previous week" }).click();
				await expect(weeks).toContainText("Last week");
				await expect(weeks.getByRole("link", { name: "Back to this week" })).toBeVisible();
				await shot(page, `week-last-${at}`);

				// The calendar's month: This month.
				await openShell(page, `${organisationPath(slug)}?view=calendar&scale=month`);
				await expect(main(page).getByRole("group", { name: "Months" })).toContainText("This month");
				expect(await problemsFromTheTop(page), "problems on the month").toEqual([]);
			});

			test("the menu tucks away for wide work, and only from 600px (S2-10)", async ({ page }) => {
				const { slug } = await emptyOrganisation(page);
				await openShell(page, `${organisationPath(slug)}?view=week`);

				if (viewport.width < 600) {
					// Under 600px the bar is the navigation, and there is nothing to tuck away.
					await expect(toggle(page)).toBeHidden();
					await main(page).getByRole("heading", { level: 1 }).focus();
					await page.keyboard.press("ControlOrMeta+Backslash");
					await expect(navigation(page)).toHaveAttribute("data-menu", "shown");
					await expect(navigation(page).getByRole("link", { name: "Timesheet" })).toBeVisible();
					await shot(page, `menu-bar-${at}`);
					return;
				}

				const column = main(page).locator(":scope > div");
				const shownWidth = (await column.boundingBox())?.width ?? 0;
				expect(shownWidth).toBeLessThanOrEqual(800);

				// By the keyboard: Tab to Hide menu, Enter; the focus stays on the same button, now Menu.
				await tabTo(page, toggle(page));
				await expect(toggle(page)).toHaveText("Hide menu");
				await page.keyboard.press("Enter");
				await expect(navigation(page)).toHaveAttribute("data-menu", "hidden");
				await expect(toggle(page)).toHaveText("Menu");
				await expect(toggle(page)).toBeFocused();
				await expect(announced(page)).toHaveText("Menu hidden");
				await expect(navigation(page).getByRole("link", { name: "Timesheet" })).toBeHidden();
				// The strip is 72px; the page's column takes what the menu gave up, and more.
				await expect.poll(async () => (await navigation(page).boundingBox())?.width).toBe(72);
				const hiddenWidth = (await column.boundingBox())?.width ?? 0;
				expect(hiddenWidth).toBeGreaterThan(shownWidth + 96);
				expect(await problemsFromTheTop(page), "problems with the menu hidden").toEqual([]);
				await shot(page, `menu-hidden-${at}`);

				// The choice is the browser's: it survives a reload, and the page arrives hidden.
				const cookies = await page.context().cookies();
				expect(cookies.find((each) => each.name === MENU_COOKIE)?.value).toBe("hidden");
				const arrived = await page.goto(`${organisationPath(slug)}?view=week`);
				expect(await arrived?.text()).toMatch(/<nav[^>]*data-menu="hidden"/);
				await expect(navigation(page)).toHaveAttribute("data-menu", "hidden");

				// A running timer stays in the strip, with its time, and can be stopped there.
				await openShell(page, organisationPath(slug));
				await main(page).getByRole("button", { name: "Track time", exact: true }).click();
				const sheet = page.getByRole("dialog", { name: "Track time" });
				await sheet.getByRole("button", { name: "Start timer" }).click();
				await expect(sheet).toBeHidden();
				await expect(page.locator("[data-exiting]")).toHaveCount(0);
				const strip = navigation(page).getByRole("region", { name: "Timer" });
				await expect(strip.getByRole("timer", { name: "Elapsed" })).toBeVisible();
				const stop = strip.getByRole("button", { name: "Stop timer for Site" });
				await expect(stop).toBeVisible();
				const box = await stop.boundingBox();
				expect(box?.width ?? 0).toBeLessThanOrEqual(72);
				expect(
					await problemsFromTheTop(page, [DIGIT_CHANGING]),
					"problems with a timer in the strip",
				).toEqual([]);
				await shot(page, `menu-hidden-timer-${at}`);
				await stop.click();
				await expect(strip).toBeHidden();

				// Ctrl+\ (⌘\ on a Mac) brings it back, and the focus is left where it was.
				const heading = main(page).getByRole("heading", { level: 1 });
				await heading.focus();
				await page.keyboard.press("ControlOrMeta+Backslash");
				await expect(navigation(page)).toHaveAttribute("data-menu", "shown");
				await expect(announced(page)).toHaveText("Menu shown");
				await expect(heading).toBeFocused();
				await expect(navigation(page).getByRole("link", { name: "Timesheet" })).toBeVisible();

				// Hidden by the key while a link has the focus: the focus goes to the toggle, not the page's body.
				const projects = navigation(page).getByRole("link", { name: "Projects", exact: true });
				await tabTo(page, projects);
				await page.keyboard.press("ControlOrMeta+Backslash");
				await expect(navigation(page)).toHaveAttribute("data-menu", "hidden");
				await expect(toggle(page)).toBeFocused();
				await page.keyboard.press("ControlOrMeta+Backslash");
				await expect(navigation(page)).toHaveAttribute("data-menu", "shown");
			});
		});
	}
}

test.describe("the column's change of width", () => {
	test.use({ viewport: MEDIUM });

	test("takes 200ms, and none with reduced motion (S2-10)", async ({ page }) => {
		const { slug } = await emptyOrganisation(page);
		await openShell(page, organisationPath(slug));
		const duration = () =>
			navigation(page).evaluate((nav) => getComputedStyle(nav).transitionDuration);
		expect(await duration()).toBe("0.2s");
		await page.emulateMedia({ reducedMotion: "reduce" });
		expect(await duration()).toBe("0s");
		await toggle(page).click();
		await expect(navigation(page)).toHaveAttribute("data-menu", "hidden");
		// With reduced motion the strip is at its width at once.
		expect((await navigation(page).boundingBox())?.width).toBe(72);
	});

	test("taller than the window, the column scrolls on its own: an owner reaches Workspace settings by Tab and by the wheel, and the strip keeps Stop", async ({
		page,
	}) => {
		const { slug } = await emptyOrganisation(page);
		await openShell(page, organisationPath(slug));
		// A running timer makes the column taller still.
		await main(page).getByRole("button", { name: "Track time", exact: true }).click();
		const sheet = page.getByRole("dialog", { name: "Track time" });
		await sheet.getByRole("button", { name: "Start timer" }).click();
		await expect(sheet).toBeHidden();
		await expect(page.locator("[data-exiting]")).toHaveCount(0);

		const nav = navigation(page);
		const overflow = await nav.evaluate((element) => element.scrollHeight - element.clientHeight);
		expect(overflow, "an owner's column is taller than an 800px window").toBeGreaterThan(0);
		const settings = nav.getByRole("link", { name: "Workspace settings" });
		const inColumn = async () => {
			const [link, column] = await Promise.all([settings.boundingBox(), nav.boundingBox()]);
			return (
				link !== null &&
				column !== null &&
				link.y >= column.y &&
				link.y + link.height <= column.y + column.height + 0.5
			);
		};
		expect(await inColumn(), "cut off at the column's foot before it scrolls").toBe(false);

		// By the keyboard: the focus scrolls the column, not the page, until the link is whole.
		await tabTo(page, settings);
		await expect(settings).toBeInViewport({ ratio: 1 });
		expect(await inColumn()).toBe(true);
		expect(await page.evaluate(() => window.scrollY)).toBe(0);
		await shot(page, "menu-scrolled-1280-light");

		// By the wheel, over the column: back to its top, and down again to its foot.
		await nav.evaluate((element) => {
			element.scrollTop = 0;
		});
		const box = await nav.boundingBox();
		await page.mouse.move((box?.x ?? 0) + 20, (box?.y ?? 0) + 200);
		await page.mouse.wheel(0, overflow + 100);
		await expect.poll(inColumn).toBe(true);

		// Tucked away, the strip holds the running timer's Stop, in full.
		await toggle(page).click();
		await expect(nav).toHaveAttribute("data-menu", "hidden");
		await expect(nav.getByRole("button", { name: "Stop timer for Site" })).toBeInViewport({
			ratio: 1,
		});
	});
});
