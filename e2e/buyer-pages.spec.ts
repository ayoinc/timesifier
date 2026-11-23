import type { Page } from "@playwright/test";

import { SIGNED_OUT } from "./auth-state";
import { problems } from "./axe";
import { expect, test } from "./fixtures";
import { movement, watchForMovement } from "./motion";

// The pages a buyer reads before signing in (TS-106): features, pricing,
// integrations, the API reference and contact. Nobody is signed in.

test.use({ storageState: SIGNED_OUT });

const PAGES = ["/features", "/pricing", "/integrations", "/developers/api", "/contact"] as const;

const COMPACT = { width: 390, height: 844 };
const WIDE = { width: 1280, height: 800 };

/** Scrolls down the whole page, a half window at a time, a frame each. */
async function scrollThrough(page: Page) {
	await page.evaluate(async () => {
		for (let top = 0; top < document.documentElement.scrollHeight; top += window.innerHeight / 2) {
			window.scrollTo(0, top);
			const painted = Promise.withResolvers<number>();
			requestAnimationFrame(painted.resolve);
			await painted.promise;
		}
	});
}

for (const path of PAGES) {
	test.describe(path, () => {
		for (const viewport of [COMPACT, WIDE]) {
			for (const colorScheme of ["light", "dark"] as const) {
				test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
					// Measured settled: with reduced motion asked for, nothing is part-way through arriving.
					test.use({ viewport, chosenScheme: colorScheme, reducedMotion: "reduce" });

					test("has no accessibility violations, and nothing runs off the side", async ({
						page,
					}) => {
						await page.goto(path);
						await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
						expect(
							await page.evaluate(() => getComputedStyle(document.body).colorScheme),
						).toContain(colorScheme);

						expect(await problems(page)).toEqual([]);
						expect(
							await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
						).toBeLessThanOrEqual(0);
					});
				});
			}
		}

		test("is reached from the foot of the home page", async ({ page }) => {
			await page.goto("/");
			const link = page.getByRole("contentinfo").locator(`a[href="${path}"]`);
			await link.click();
			await expect(page).toHaveURL(path);
			await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
			await expect(
				page.getByRole("contentinfo").locator(`a[href="${path}"][aria-current="page"]`),
			).toHaveCount(1);
		});
	});
}

test.describe("the foot of every public page", () => {
	test("groups its links under Notices, Product and Company", async ({ page }) => {
		await page.goto("/features");
		const foot = page.getByRole("contentinfo");
		for (const [group, links] of [
			["Notices", ["Privacy notice", "Terms"]],
			["Product", ["Features", "Pricing", "Integrations", "API docs"]],
			["Company", ["Contact"]],
		] as const) {
			const nav = foot.getByRole("navigation", { name: group });
			for (const link of links) {
				await expect(nav.getByRole("link", { name: link, exact: true })).toBeVisible();
			}
		}
	});
});

test.describe("the band at the top", () => {
	test.describe("from 600px", () => {
		test.use({ viewport: WIDE });

		test("leads to Features and Pricing, beside the one way in", async ({ page }) => {
			await page.goto("/pricing");
			const band = page.getByRole("banner");
			await expect(band.getByRole("link", { name: "Pricing" })).toHaveAttribute(
				"aria-current",
				"page",
			);
			await band.getByRole("link", { name: "Features" }).click();
			await expect(page).toHaveURL("/features");
			await expect(band.getByRole("link", { name: "Sign in" })).toBeVisible();
		});
	});

	test.describe("on a phone", () => {
		test.use({ viewport: COMPACT });

		test("holds only the name and Sign in", async ({ page }) => {
			await page.goto("/features");
			const band = page.getByRole("banner");
			await expect(band.getByRole("link", { name: "Features" })).toBeHidden();
			await expect(band.getByRole("link", { name: "Sign in" })).toBeVisible();
		});
	});
});

test("every drawing on the features page that shows a time says it is an example", async ({
	page,
}) => {
	await page.goto("/features");
	const unlabelled = await page.getByRole("main").evaluate((main) => {
		const times: string[] = [];
		const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const text = node.textContent ?? "";
			if (!/\b\d{1,2}:\d{2}\b/.test(text)) continue;
			const drawing = node.parentElement?.closest("figure, table");
			if (!(drawing?.textContent ?? "").includes("Example")) times.push(text.trim());
		}
		return times;
	});
	expect(unlabelled).toEqual([]);
});

test.describe("with reduced motion asked for", () => {
	test.use({ reducedMotion: "reduce" });

	for (const path of PAGES) {
		test(`nothing on ${path} slides, grows or drifts`, async ({ page }) => {
			await watchForMovement(page);
			await page.goto(path);
			await scrollThrough(page);
			expect(await movement(page)).toEqual([]);
		});
	}
});

test.describe("without script", () => {
	test.use({ javaScriptEnabled: false });

	test("pricing is all there, and its one way in opens the sign-in page", async ({ page }) => {
		await page.goto("/pricing");
		for (const plan of ["Free", "Team", "Business"]) {
			await expect(page.getByRole("heading", { name: plan, exact: true })).toBeVisible();
		}
		await page.getByRole("main").getByRole("link", { name: "Start tracking" }).click();
		await expect(page).toHaveURL("/sign-in");
	});

	test("the API reference's contents lead to its sections", async ({ page }) => {
		await page.goto("/developers/api");
		await page
			.getByRole("navigation", { name: "Contents" })
			.getByRole("link", { name: "Webhooks" })
			.click();
		await expect(page).toHaveURL("/developers/api#webhooks");
		await expect(page.getByRole("heading", { name: "Webhooks", level: 2 })).toBeInViewport();
	});
});
