import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "@playwright/test";

import { expect, openShell, test } from "./fixtures";
import { homePath } from "./organisation";

/** `PENDING_BAR_DELAY_MS` in app/shell/PendingBar.tsx. */
const DELAY_MS = 150;

// Audit W09: while a move to another page waits for the server, the page says
// so. A 3px bar runs across the top of the window, above the band, once the
// wait has lasted 150ms; it is a progressbar named "Loading" while it is shown,
// and the main region is `aria-busy` while the page waits. With reduced motion
// the bar stands still.

declare global {
	interface Window {
		__pending?: { pressed?: number; appeared?: number };
	}
}

/** Holds every answer to a move between pages for `ms`, as a slow connection would. */
async function slowMoves(page: Page, ms: number) {
	await page.route(
		(url) => url.pathname.endsWith(".data"),
		async (route) => {
			await sleep(ms);
			await route.continue();
		},
	);
}

/** Records, in the page's own clock, when the link was pressed and when the bar first appeared. */
async function timeTheBar(page: Page) {
	await page.evaluate(() => {
		const times: { pressed?: number; appeared?: number } = {};
		window.__pending = times;
		document.addEventListener("pointerdown", () => {
			times.pressed ??= performance.now();
		});
		new MutationObserver(() => {
			if (document.querySelector('[role="progressbar"]')) times.appeared ??= performance.now();
		}).observe(document.body, { childList: true, subtree: true });
	});
}

const bar = (page: Page) => page.getByRole("progressbar", { name: "Loading" });
const reportsLink = (page: Page) =>
	page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Reports" });

test("a slow move shows the bar above the band after 150ms, marks the page busy, and clears both on arrival", async ({
	page,
}) => {
	await openShell(page, homePath("timesheet"));
	await expect(bar(page)).toHaveCount(0);
	await expect(page.locator("main")).not.toHaveAttribute("aria-busy");
	await slowMoves(page, 1500);
	await timeTheBar(page);

	await reportsLink(page).click();
	await expect(page.locator("main")).toHaveAttribute("aria-busy", "true");
	await expect(bar(page)).toBeVisible();

	// Across the top edge of the window, 3px tall, over the band.
	const box = await bar(page).boundingBox();
	expect(box?.y).toBe(0);
	expect(box?.height).toBe(3);
	expect(box?.width).toBe(await page.evaluate(() => document.documentElement.clientWidth));
	// It moves while motion is allowed.
	expect(
		await page.locator(".pending-bar").evaluate((element) => element.getAnimations().length),
	).toBe(1);

	await expect(page).toHaveURL(homePath("reports"));
	await expect(bar(page)).toHaveCount(0);
	await expect(page.locator("main")).not.toHaveAttribute("aria-busy");

	const { pressed = 0, appeared = 0 } = (await page.evaluate(() => window.__pending)) ?? {};
	expect(pressed).toBeGreaterThan(0);
	expect(appeared - pressed).toBeGreaterThanOrEqual(DELAY_MS);
});

test.describe("with reduced motion requested", () => {
	test.use({ reducedMotion: "reduce" });

	test("the bar stands still across the whole width", async ({ page }) => {
		await openShell(page, homePath("timesheet"));
		await slowMoves(page, 1500);

		await reportsLink(page).click();
		await expect(bar(page)).toBeVisible();
		const still = page.locator(".pending-bar");
		expect(await still.evaluate((element) => element.getAnimations().length)).toBe(0);
		expect((await still.boundingBox())?.width).toBe(
			await page.evaluate(() => document.documentElement.clientWidth),
		);

		await expect(page).toHaveURL(homePath("reports"));
		await expect(bar(page)).toHaveCount(0);
	});
});
