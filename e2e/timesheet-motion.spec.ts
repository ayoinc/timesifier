import { setTimeout as sleep } from "node:timers/promises";

import type { Page, Route } from "@playwright/test";

import { destinationPath, organisationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";
import { createProject, workEveryDay } from "./timesheet";

// The Timesheet's loading and quick actions (TS-096, docs/design-system.md):
// Track time holds the shape of its fields while it reads the day's rules; a
// timer's start or stop shows at once on the Day view and in the navigation,
// and goes back with the reason when the server refuses it; the Day view's
// sections come in one after another, and stand still with reduced motion.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS });

// A start refused on purpose is answered 400, which the browser logs; its
// address is known once the organisation is made.
const refused: Record<string, number[]> = {};
// biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's needs from its first argument.
test.use({ refusals: async ({}, use) => use(refused) });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

const REFUSED = "Choose an active project of this organisation.";
const main = (page: Page) => page.getByRole("main");
const trackSheet = (page: Page) => page.getByRole("dialog", { name: "Track time" });
const dayTimer = (page: Page) => main(page).getByRole("timer", { name: "Elapsed" });
const navTimer = (page: Page) =>
	page.getByRole("navigation", { name: "Main" }).getByRole("region", { name: "Timer" });

/**
 * A new organisation with one project, whose people work every day: these
 * tests press Track time on today's Day view, which a day off does not offer,
 * so on a weekend they would find nothing to press (TS-095, `workEveryDay`).
 */
async function organisationWithProject(page: Page) {
	await signIn(page, newPerson().email);
	const { slug } = await createOrganisation(page);
	await createProject(page, slug, "Site");
	await workEveryDay(page, slug);
	refused[`${organisationPath(slug)}.data`] = [400];
	return slug;
}

/** Holds each start of a timer for `ms`; with `refuse`, sends it for a project that is not there. */
async function holdStarts(page: Page, slug: string, ms: number, refuse: boolean) {
	await page.route(
		(url) => url.pathname.startsWith(organisationPath(slug)) && url.search.includes("index"),
		async (route: Route) => {
			const request = route.request();
			const body = request.postData() ?? "";
			if (request.method() !== "POST" || !body.includes("track")) return route.continue();
			await sleep(ms);
			if (!refuse) return route.continue();
			const form = new URLSearchParams(body);
			form.set("projectId", "not-a-project");
			await route.continue({ postData: form.toString() });
		},
	);
}

async function startFromTrackTime(page: Page) {
	await main(page).getByRole("button", { name: "Track time", exact: true }).click();
	const sheet = trackSheet(page);
	await expect(sheet.getByRole("combobox", { name: "Project" })).toBeFocused();
	await sheet.getByRole("button", { name: "Start timer" }).click();
	// The sheet closes at once: it does not wait for the server.
	await expect(sheet).toBeHidden();
}

test("Track time holds the shape of its fields while it reads the day's rules", async ({
	page,
}) => {
	const slug = await organisationWithProject(page);
	await openShell(page, organisationPath(slug));
	await page.route(
		(url) => url.pathname.includes("/timesheet/day"),
		async (route) => {
			await sleep(1500);
			await route.continue();
		},
	);
	await main(page).getByRole("button", { name: "Track time", exact: true }).click();
	const sheet = trackSheet(page);
	await expect(sheet.getByRole("status", { name: "Loading your projects" })).toBeVisible();
	await expect(sheet).not.toContainText("Reading your projects");
	await expect(sheet.getByRole("combobox", { name: "Project" })).toBeVisible();
	await expect(sheet.getByRole("status", { name: "Loading your projects" })).toHaveCount(0);
});

test("a timer started from Track time runs at once, and stops at once", async ({ page }) => {
	const slug = await organisationWithProject(page);
	await openShell(page, organisationPath(slug));
	await holdStarts(page, slug, 1500, false);

	await startFromTrackTime(page);
	// Running before the server has answered.
	await expect(dayTimer(page)).toBeVisible({ timeout: 1000 });
	await expect(main(page)).toContainText("Site");
	await expect(page.locator("[data-snackbar]")).toContainText("Timer started.");

	await main(page).getByRole("button", { name: "Stop timer", exact: true }).click();
	await expect(dayTimer(page)).toHaveCount(0, { timeout: 1000 });
	await expect(page.locator("[data-snackbar]")).toContainText("Timer stopped");
});

test("a start the server refuses goes back, and says why, on the Day view and in the navigation", async ({
	page,
}) => {
	const slug = await organisationWithProject(page);
	await openShell(page, destinationPath(slug, "projects"));
	await holdStarts(page, slug, 1500, true);

	// From another page: the navigation's timer runs, then goes back.
	await page
		.getByRole("navigation", { name: "Main" })
		.getByRole("button", { name: "Track time" })
		.click();
	const sheet = trackSheet(page);
	await expect(sheet.getByRole("combobox", { name: "Project" })).toBeFocused();
	await sheet.getByRole("button", { name: "Start timer" }).click();
	await expect(sheet).toBeHidden();
	await expect(navTimer(page)).toContainText("Site", { timeout: 1000 });
	await expect(page.locator("[data-snackbar]")).toContainText(REFUSED);
	await expect(navTimer(page)).toHaveCount(0);

	// On the Day view: the timer runs, then goes back.
	await openShell(page, organisationPath(slug));
	await startFromTrackTime(page);
	await expect(dayTimer(page)).toBeVisible({ timeout: 1000 });
	await expect(page.locator("[data-snackbar]")).toContainText(REFUSED);
	await expect(dayTimer(page)).toHaveCount(0);
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
	test.describe(`the Day view's arrival with ${reducedMotion} motion`, () => {
		test.use({ reducedMotion });

		test("its sections come in one after another, or stand still", async ({ page }) => {
			const slug = await organisationWithProject(page);
			await openShell(page, destinationPath(slug, "projects"));
			await page.route(
				(url) => url.pathname.endsWith(".data"),
				async (route) => {
					await sleep(800);
					await route.continue();
				},
			);
			await page
				.getByRole("navigation", { name: "Main" })
				.getByRole("link", { name: "Timesheet" })
				.click();
			await expect(page.locator("[data-reveal] [data-reveal-sections]")).toBeAttached();
			const names = await page
				.locator("[data-reveal] [data-reveal-sections] > *")
				.evaluateAll((sections) => sections.map((s) => getComputedStyle(s).animationName));
			expect(names.length).toBeGreaterThan(1);
			if (reducedMotion === "reduce") {
				for (const name of names) expect(name).not.toContain("reveal-rise");
			} else {
				for (const name of names) expect(name).toContain("reveal-rise");
				const delays = await page
					.locator("[data-reveal] [data-reveal-sections] > *")
					.evaluateAll((sections) =>
						sections.map((s) => Number.parseFloat(getComputedStyle(s).animationDelay)),
					);
				expect(delays[1]).toBeGreaterThan(delays[0] ?? 0);
			}
		});
	});
}

test("an empty today reads 'Nothing tracked today', not 'on today'", async ({ page }) => {
	const slug = await organisationWithProject(page);
	await openShell(page, organisationPath(slug));
	await expect(main(page)).not.toContainText("on today");
	await expect(main(page)).toContainText(/Nothing (yet|tracked) today\./);
});
