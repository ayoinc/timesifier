import { setTimeout as delay } from "node:timers/promises";
import type { BrowserContext, Page } from "@playwright/test";

import { accountPath, destination } from "../app/shell/destinations";
import { expect, openShell, test } from "./fixtures";
import { movement, watchForMovement } from "./motion";
import { homeOrganisation, homePath } from "./organisation";

// How a page loads, reloads and waits (TS-096; docs/design-system.md, "Shell",
// "How a page loads" and "While the page waits"): nothing shifts, the first
// frame is already in the right scheme and typeface, a wait of more than 150ms
// shows the destination's shape, and a press during a wait still lands.

const projects = destination("projects");
const reports = destination("reports");
const timesheet = destination("timesheet");
const main = (page: Page) => page.getByRole("main");
const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });

declare global {
	interface Window {
		__shift?: number;
		__frames?: { scheme: string | undefined; background: string; font: string; sheets: number }[];
	}
}

/** Adds up every layout shift the page makes, from before its first script runs. */
async function watchShifts(page: Page) {
	await page.addInitScript(() => {
		window.__shift = 0;
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries() as (PerformanceEntry & {
				value: number;
				hadRecentInput: boolean;
			})[])
				if (!entry.hadRecentInput) window.__shift = (window.__shift ?? 0) + entry.value;
		}).observe({ type: "layout-shift", buffered: true });
	});
}

const shifted = (page: Page) => page.evaluate(() => window.__shift ?? 0);

/** Holds back every answer from our server for `ms`, as a far-away database does. */
async function slowServer(context: BrowserContext, baseURL: string | undefined, ms: number) {
	await context.route(
		(url) => url.origin === baseURL && url.pathname.endsWith(".data"),
		async (route) => {
			await delay(ms);
			await route.fallback().catch(() => {});
		},
	);
}

test.describe("loading the shell", () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test("a load, a reload and three moves shift nothing", async ({ page }) => {
		await watchShifts(page);
		await openShell(page, homePath("timesheet"));
		await page.reload();
		await openShell(page, homePath("timesheet"));
		for (const { id, label } of [projects, reports, timesheet]) {
			await nav(page).getByRole("link", { name: label, exact: true }).click();
			await expect(page).toHaveURL(homePath(id));
			await expect(main(page).getByRole("heading", { level: 1 })).toBeFocused();
		}
		expect(await shifted(page)).toBeLessThan(0.05);
	});

	test("a reload draws its first frame in the chosen scheme, styled, and in the stand-in or the real face", async ({
		page,
	}) => {
		// Dark is chosen on My account, in this browser's cookie alone.
		await openShell(page, accountPath(homeOrganisation().slug));
		await page
			.getByRole("radiogroup", { name: "Colour scheme" })
			.getByText("Dark", { exact: true })
			.click();
		await expect(
			page.getByRole("radiogroup", { name: "Colour scheme" }).getByRole("radio", { name: "Dark" }),
		).toBeChecked();
		await page.addInitScript(() => {
			window.__frames = [];
			const read = () => {
				if (document.body)
					window.__frames?.push({
						scheme: document.documentElement.dataset.colorScheme,
						background: getComputedStyle(document.body).backgroundColor,
						font: getComputedStyle(document.body).fontFamily,
						sheets: document.styleSheets.length,
					});
				if ((window.__frames?.length ?? 0) < 30) requestAnimationFrame(read);
			};
			requestAnimationFrame(read);
		});
		await openShell(page, homePath("timesheet"));
		await page.reload();
		await page.waitForLoadState("load");
		const frames = await page.evaluate(() => window.__frames ?? []);
		expect(frames.length).toBeGreaterThan(0);
		const [first] = frames;
		// Dark from the very first frame: the server rendered the person's choice.
		expect(new Set(frames.map((frame) => frame.scheme))).toEqual(new Set(["dark"]));
		// Styled from the very first frame, and the same background throughout.
		expect(first?.sheets).toBeGreaterThan(0);
		expect(new Set(frames.map((frame) => frame.background)).size).toBe(1);
		const [red = 255] = (first?.background.match(/\d+/g) ?? []).map(Number);
		expect(red).toBeLessThan(128);
		// The face, then its metric-matched stand-in, before any font of the system.
		expect(first?.font).toMatch(/^"Sofia Sans Variable", "Sofia Sans Fallback"/);
	});

	test("the built files are kept for a year; the page itself is never kept", async ({ page }) => {
		const styles = page.waitForResponse((response) => /\/assets\/.+\.css$/.test(response.url()));
		const document = await page.goto(homePath("timesheet"));
		expect((await styles).headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
		expect(document?.headers()["cache-control"]).toBe("private, no-store");
	});
});

test.describe("while a move waits for the server", () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test("the destination's shape takes the page's place after 150ms, and the page takes the shape's", async ({
		page,
		context,
		baseURL,
	}) => {
		await openShell(page, homePath("timesheet"));
		await slowServer(context, baseURL, 900);
		await watchShifts(page);

		await nav(page).getByRole("link", { name: projects.label, exact: true }).click();
		const shape = page.locator('[data-skeleton="projects"]');
		await expect(shape).toBeVisible();
		await expect(main(page).getByRole("status")).toHaveText(`Loading ${projects.label}`);
		// The navigation says where the person is going as the shape appears.
		await expect(
			nav(page).getByRole("link", { name: projects.label, exact: true }),
		).toHaveAttribute("aria-current", "page");

		await expect(page).toHaveURL(homePath("projects"));
		await expect(shape).toHaveCount(0);
		await expect(main(page).getByRole("heading", { level: 1 })).toBeFocused();
		expect(await shifted(page)).toBeLessThan(0.05);
	});

	test("a press during the wait lands: the second destination arrives (design rule 8)", async ({
		page,
		context,
		baseURL,
	}) => {
		await openShell(page, homePath("timesheet"));
		await slowServer(context, baseURL, 900);

		await nav(page).getByRole("link", { name: projects.label, exact: true }).click();
		await expect(page.locator('[data-skeleton="projects"]')).toBeVisible();
		const pressed = Date.now();
		await nav(page).getByRole("link", { name: reports.label, exact: true }).click();
		// The shape changes at once; the page that was left does not come back in between.
		await expect(page.locator('[data-skeleton="reports"]')).toBeVisible();
		expect(Date.now() - pressed).toBeLessThan(500);
		await expect(page).toHaveURL(homePath("reports"));
		await expect(main(page).getByRole("heading", { level: 1 })).toBeFocused();
	});

	test("with reduced motion requested, the shape and the page that replaces it do not move", async ({
		page,
		context,
		baseURL,
	}) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		await watchForMovement(page);
		await openShell(page, homePath("timesheet"));
		await slowServer(context, baseURL, 600);

		await nav(page).getByRole("link", { name: projects.label, exact: true }).click();
		await expect(page.locator('[data-skeleton="projects"]')).toBeVisible();
		// The shape stands still.
		expect(
			await page
				.locator(".skeleton-pulse")
				.first()
				.evaluate((shape) => getComputedStyle(shape).animationName),
		).toBe("none");
		await expect(page).toHaveURL(homePath("projects"));
		await expect(main(page).getByRole("heading", { level: 1 })).toBeFocused();
		expect(await movement(page)).toEqual([]);
	});
});
