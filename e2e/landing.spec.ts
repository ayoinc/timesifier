import type { Page, Route } from "@playwright/test";

import { SIGNED_OUT } from "./auth-state";
import { problems } from "./axe";
import { expect, test } from "./fixtures";

// The home page, as somebody who has never used Timesifier meets it. It runs in
// Chromium and in WebKit. Nobody is signed in: the page is the same for everyone.

test.use({ storageState: SIGNED_OUT });

const COMPACT = { width: 390, height: 844 };
const WIDE = { width: 1280, height: 800 };

const primaryAction = (page: Page) =>
	page.getByRole("main").getByRole("link", { name: "Create an account" }).first();
const signIn = (page: Page) => page.getByRole("main").getByRole("link", { name: "Sign in" });
/** The picture of the product: the figure that holds no photograph. */
const productVisual = (page: Page) =>
	page
		.getByRole("main")
		.getByRole("figure")
		.filter({ hasNot: page.getByRole("img") })
		.first();

/** Scrolls down the whole page, so every image that waits to be near the window is fetched. */
async function bringInEveryImage(page: Page) {
	await page.evaluate(async () => {
		for (let top = 0; top < document.documentElement.scrollHeight; top += window.innerHeight / 2) {
			window.scrollTo(0, top);
			const painted = Promise.withResolvers<number>();
			requestAnimationFrame(painted.resolve);
			await painted.promise;
		}
	});
	await expect
		.poll(() =>
			page.evaluate(() =>
				[...document.images].every((image) => image.complete && image.naturalWidth > 0),
			),
		)
		.toBe(true);
	await page.evaluate(() => window.scrollTo(0, 0));
}

for (const viewport of [COMPACT, WIDE]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, colorScheme });

			test("the home page has no accessibility violations", async ({ page }) => {
				await page.goto("/");
				await bringInEveryImage(page);
				expect(await page.evaluate(() => getComputedStyle(document.body).colorScheme)).toContain(
					colorScheme,
				);

				expect(await problems(page)).toEqual([]);
			});

			test("the primary action and the product are on show before any scrolling, and nothing runs off the side", async ({
				page,
			}) => {
				await page.goto("/");

				await expect(page.getByRole("heading", { level: 1 })).toBeInViewport({ ratio: 1 });
				await expect(primaryAction(page)).toBeInViewport({ ratio: 1 });
				await expect(signIn(page)).toBeInViewport({ ratio: 1 });
				await expect(productVisual(page)).toBeInViewport();

				expect(
					await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
				).toBeLessThanOrEqual(0);
			});
		});
	}
}

for (const viewport of [COMPACT, WIDE]) {
	test.describe(`in a window ${viewport.width}px wide`, () => {
		test.use({ viewport });

		test("the keyboard reaches the primary action, which shows where the focus is and opens sign-up", async ({
			page,
			browserName,
		}) => {
			// Safari leaves links out of the Tab order unless a person turns that on, and
			// Playwright's WebKit does the same. Option with Tab is its key for every element.
			const next = browserName === "webkit" ? "Alt+Tab" : "Tab";
			await page.goto("/");

			await page.keyboard.press(next);
			await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
			await expect(page.getByRole("link", { name: "Skip to main content" })).toBeInViewport();

			// However many links the header has at this width, the action comes soon after.
			for (let presses = 0; presses < 8; presses += 1) {
				if (await primaryAction(page).evaluate((link) => link === document.activeElement)) break;
				await page.keyboard.press(next);
			}
			await expect(primaryAction(page)).toBeFocused();
			expect(
				await primaryAction(page).evaluate((link) => getComputedStyle(link).outlineStyle),
			).toBe("solid");

			await page.keyboard.press("Enter");
			await expect(page).toHaveURL("/sign-up");
		});
	});
}

test("the skip link moves the focus into the main region", async ({ page, browserName }) => {
	await page.goto("/");
	await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
	await page.keyboard.press("Enter");

	await expect(page.getByRole("main")).toBeFocused();
});

test("Sign in, beside the primary action, opens the sign-in page", async ({ page }) => {
	await page.goto("/");
	await signIn(page).click();

	await expect(page).toHaveURL("/sign-in");
});

test("every image has its size, a description, and comes from our own host", async ({
	page,
	baseURL,
}) => {
	await page.goto("/");
	await bringInEveryImage(page);

	const images = await page.evaluate(() =>
		[...document.images].map((image) => ({
			width: Number(image.getAttribute("width")),
			height: Number(image.getAttribute("height")),
			alt: image.alt.trim(),
			shown: image.currentSrc,
			candidates: [...(image.parentElement?.querySelectorAll("source") ?? [])]
				.flatMap((source) => source.srcset.split(","))
				.map((candidate) => new URL(candidate.trim().split(" ")[0] ?? "", location.href).origin),
			// How far the shape the markup holds open is from the shape of the file.
			distortion: Math.abs(
				Number(image.getAttribute("width")) / Number(image.getAttribute("height")) -
					image.naturalWidth / image.naturalHeight,
			),
		})),
	);

	expect(images.length).toBeGreaterThan(0);
	for (const image of images) {
		expect(image.width, image.shown).toBeGreaterThan(0);
		expect(image.height, image.shown).toBeGreaterThan(0);
		// A sentence, not a file name or a single word.
		expect(image.alt.split(/\s+/).length, image.shown).toBeGreaterThan(3);
		expect(new URL(image.shown).origin).toBe(baseURL);
		expect(new Set(image.candidates)).toEqual(new Set([baseURL]));
		expect(image.distortion, image.shown).toBeLessThan(0.02);
	}
	// No two photographs are described in the same words.
	expect(new Set(images.map((image) => image.alt)).size).toBe(images.length);
});

/** Where every heading, figure and section starts, and how tall the page is. */
function layout(page: Page) {
	return page.evaluate(() => ({
		height: document.documentElement.scrollHeight,
		tops: [...document.querySelectorAll("h1, h2, figure, section, footer")].map((element) =>
			Math.round(element.getBoundingClientRect().top + window.scrollY),
		),
	}));
}

for (const viewport of [COMPACT, WIDE]) {
	test.describe(`in a window ${viewport.width}px wide`, () => {
		test.use({ viewport });

		test("nothing on the page moves when its images arrive", async ({ page }) => {
			// Every image is held back until the page has been measured without it.
			const held: Route[] = [];
			let holding = true;
			await page.route("**/images/**", async (route) => {
				if (holding) held.push(route);
				else await route.continue();
			});

			await page.goto("/", { waitUntil: "domcontentloaded" });
			// The text is in its own typefaces before it is measured. Polled, not awaited:
			// WebKit keeps `document.fonts.ready` waiting while an image is on its way.
			await expect
				.poll(() =>
					page.evaluate(() => {
						const faces = [...document.fonts].map((face) => face.status);
						return faces.includes("loaded") && !faces.includes("loading");
					}),
				)
				.toBe(true);
			const before = await layout(page);
			expect(
				await page.evaluate(() => [...document.images].some((image) => image.naturalWidth > 0)),
			).toBe(false);

			holding = false;
			await Promise.all(held.map((route) => route.continue()));
			await bringInEveryImage(page);

			expect(await layout(page)).toEqual(before);
		});
	});
}

test.describe("without script", () => {
	test.use({ javaScriptEnabled: false });

	test("the page is all there, and its primary action still opens sign-up", async ({ page }) => {
		await page.goto("/");

		await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
		await expect(productVisual(page)).toBeVisible();
		// Each section makes its point under a heading of its own, and the page ends in a footer.
		expect(await page.getByRole("main").getByRole("heading", { level: 2 }).count()).toBeGreaterThan(
			3,
		);
		await expect(page.getByRole("contentinfo")).toBeVisible();

		await primaryAction(page).click();
		await expect(page).toHaveURL("/sign-up");
	});
});
