import { destination, destinations } from "../app/shell/destinations";
import { problems } from "./axe";
import { expect, openShell, test } from "./fixtures";

// Every destination of the shell, as a bar and as a rail, in the light scheme and
// the dark scheme: no WCAG 2.2 A or AA violation, and every text's contrast measured.

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, colorScheme });

			for (const destination of destinations) {
				test(`${destination.label} has no accessibility violations`, async ({ page }) => {
					await openShell(page, destination.path);
					await expect(
						page.getByRole("heading", { level: 1, name: destination.label, exact: true }),
					).toBeVisible();
					expect(await page.evaluate(() => getComputedStyle(document.body).colorScheme)).toContain(
						colorScheme,
					);

					expect(await problems(page)).toEqual([]);
				});
			}
		});
	}
}

test.describe("with the keyboard focus showing", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("the skip link, shown, has no accessibility violations", async ({ page }) => {
		await openShell(page, destination("today").path);
		await page.keyboard.press("Tab");
		await expect(page.getByRole("link", { name: "Skip to main content" })).toBeInViewport();

		expect(await problems(page)).toEqual([]);
	});
});
