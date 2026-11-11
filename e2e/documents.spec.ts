import { SIGNED_OUT } from "./auth-state";
import { problems } from "./axe";
import { expect, test } from "./fixtures";

// The privacy notice and the terms, as anybody meets them: nobody is signed in.
// They run in Chromium and in WebKit, like the home page they hang from.

test.use({ storageState: SIGNED_OUT });

const DOCUMENTS = [
	{ path: "/privacy", link: "Privacy notice" },
	{ path: "/terms", link: "Terms" },
] as const;

for (const { path, link } of DOCUMENTS) {
	test.describe(path, () => {
		for (const viewport of [
			{ width: 390, height: 844 },
			{ width: 1280, height: 800 },
		]) {
			for (const colorScheme of ["light", "dark"] as const) {
				test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
					// A scan measures the page settled: with reduced motion asked for, the
					// band at the top is not part-way through settling.
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

		test("is reached from the foot of the home page, and says which version it is", async ({
			page,
		}) => {
			await page.goto("/");
			await page.getByRole("contentinfo").getByRole("link", { name: link, exact: true }).click();

			await expect(page).toHaveURL(path);
			await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
			// The date of the version is the first thing under the title.
			await expect(page.getByRole("main").locator("time[datetime]").first()).toBeInViewport();
		});

		test("each of its parts has a heading and an address of its own", async ({ page }) => {
			await page.goto(path);

			const parts = page.getByRole("main").getByRole("region");
			expect(await parts.count()).toBeGreaterThan(3);
			for (const part of await parts.all()) {
				await expect(part.getByRole("heading", { level: 2 })).toHaveCount(1);
				expect(await part.getAttribute("id")).toBeTruthy();
			}
		});

		test.describe("without script", () => {
			test.use({ javaScriptEnabled: false });

			test("is all there, with a way to write and a way back to the home page", async ({
				page,
			}) => {
				await page.goto(path);

				await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
				await expect(page.getByRole("main").locator('a[href^="mailto:"]').first()).toBeVisible();

				await page.getByRole("banner").getByRole("link").first().click();
				await expect(page).toHaveURL("/");
			});
		});
	});
}
