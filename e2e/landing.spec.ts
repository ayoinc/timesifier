import type { Locator, Page, Route } from "@playwright/test";

import { SIGNED_OUT } from "./auth-state";
import { problems } from "./axe";
import { expect, test } from "./fixtures";
import { movement, watchForMovement } from "./motion";

// The home page, as somebody who has never used Timesifier meets it. It runs in
// Chromium and in WebKit. Nobody is signed in: the page is the same for everyone.

test.use({ storageState: SIGNED_OUT });

const COMPACT = { width: 390, height: 844 };
const WIDE = { width: 1280, height: 800 };

const primaryAction = (page: Page) =>
	page.getByRole("main").getByRole("link", { name: "Start tracking" }).first();
/** The way back in for someone who has been before: one quiet link in the band at the top. */
const signIn = (page: Page) => page.getByRole("banner").getByRole("link", { name: "Sign in" });
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
				// A photograph this window does not show is not fetched.
				[...document.images]
					.filter((image) => image.getClientRects().length > 0)
					.every((image) => image.complete && image.naturalWidth > 0),
			),
		)
		.toBe(true);
	await page.evaluate(() => window.scrollTo(0, 0));
}

for (const viewport of [COMPACT, WIDE]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, colorScheme });

			// A scan measures the page with everything on it arrived: with reduced
			// motion asked for, nothing waits on the scrolling to be shown.
			test.describe("with everything arrived", () => {
				test.use({ reducedMotion: "reduce" });

				test("the home page has no accessibility violations", async ({ page }) => {
					await page.goto("/");
					await bringInEveryImage(page);
					expect(await page.evaluate(() => getComputedStyle(document.body).colorScheme)).toContain(
						colorScheme,
					);

					expect(await problems(page)).toEqual([]);
				});
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

		test("the keyboard reaches the primary action, which shows where the focus is and opens the sign-in page", async ({
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
			await expect(page).toHaveURL("/sign-in");
		});
	});
}

test("the skip link moves the focus into the main region", async ({ page, browserName }) => {
	await page.goto("/");
	await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
	await page.keyboard.press("Enter");

	await expect(page.getByRole("main")).toBeFocused();
});

test("Sign in, in the band at the top, opens the sign-in page", async ({ page }) => {
	await page.goto("/");
	await signIn(page).click();

	await expect(page).toHaveURL("/sign-in");
});

test("there is one way in: the primary action at the top and at the end, and Sign in, lead to the same page", async ({
	page,
}) => {
	await page.goto("/");

	const actions = page.getByRole("main").getByRole("link", { name: "Start tracking" });
	await expect(actions).toHaveCount(2);
	const addresses = new Set([
		...(await actions.evaluateAll((links) => links.map((link) => link.getAttribute("href")))),
		await signIn(page).getAttribute("href"),
	]);
	expect([...addresses]).toEqual(["/sign-in"]);
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

	test("the page is all there, and its primary action still opens the sign-in page", async ({
		page,
	}) => {
		await page.goto("/");

		await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
		await expect(productVisual(page)).toBeVisible();
		// Each section makes its point under a heading of its own, and the page ends in a footer.
		expect(await page.getByRole("main").getByRole("heading", { level: 2 }).count()).toBeGreaterThan(
			3,
		);
		await expect(page.getByRole("contentinfo")).toBeVisible();

		await primaryAction(page).click();
		await expect(page).toHaveURL("/sign-in");
	});

	test("the day is a still example that adds up, with nothing to press", async ({ page }) => {
		await page.goto("/");

		expect(await shownTotal(page)).toBe((await loggedSeconds(page)) + (await shownElapsed(page)));
		await expect(productVisual(page).getByRole("button")).toHaveCount(0);
	});

	test("the anatomy of an hour is whole wherever the page stands", async ({ page }) => {
		await page.goto("/");

		await expect(anatomy(page)).toBeAttached();
		expect(await faintestPart(page)).toBe(1);
		await anatomy(page).scrollIntoViewIfNeeded();
		expect(await faintestPart(page)).toBe(1);
	});
});

// The clock. The server sends a still example; script then runs it on the
// visitor's own clock. These hold the page's time still and move it by hand.

/** A stopwatch or a duration, in seconds: "0:55:02" and "1:05" alike. */
function seconds(text: string): number {
	const parts = text.trim().split(":").map(Number);
	const [hours = 0, minutes = 0, rest = 0] = parts;
	return hours * 3600 + minutes * 60 + rest;
}

/** A time as it is drawn. A changing time holds a second copy for a screen reader, which is not drawn. */
const drawn = async (time: Locator) =>
	(await time.locator('[aria-hidden="true"]').textContent()) ?? "";

const shownElapsed = async (page: Page) =>
	seconds(await drawn(productVisual(page).getByRole("timer")));
const shownTotal = async (page: Page) =>
	seconds(await drawn(productVisual(page).locator("p", { hasText: "Today so far" })));
/** The finished entries on the sheet, added up: each row ends in its length, in hours and minutes. */
async function loggedSeconds(page: Page): Promise<number> {
	const rows = await productVisual(page).getByRole("listitem").allInnerTexts();
	expect(rows.length).toBeGreaterThan(0);
	return rows
		.map((row) => row.split("\n").find((line) => /^\d+:\d\d$/.test(line.trim())) ?? "")
		.reduce((total, length) => total + seconds(`${length}:00`), 0);
}

const stop = (page: Page) => productVisual(page).getByRole("button", { name: "Stop the timer" });
const start = (page: Page) => productVisual(page).getByRole("button", { name: "Start the timer" });

/** The drawing of the anatomy of an hour that this window shows. */
const anatomy = (page: Page) => page.getByRole("img", { name: "The anatomy of an hour" });
/** How visible the least visible numbered part of the drawing is: 1 when all of it is there. */
const faintestPart = (page: Page) =>
	anatomy(page).evaluate((drawing) =>
		Math.min(
			...[...drawing.querySelectorAll("[data-step]")].map((part) =>
				Number(getComputedStyle(part).opacity),
			),
		),
	);

test.describe("the clock", () => {
	// A Wednesday afternoon in the visitor's own time zone.
	const OPENED = new Date("2026-11-11T15:02:47+01:00");
	test.use({ timezoneId: "Europe/Amsterdam", locale: "en-GB" });

	/**
	 * Opens the page at `OPENED` and holds its time still ten and a half seconds
	 * later, once the clock is running: between two of its ticks, so that a tick is
	 * never due at the very moment the time is held.
	 */
	async function open(page: Page) {
		await page.clock.install({ time: OPENED });
		await page.goto("/");
		await expect(stop(page)).toBeVisible();
		await page.clock.pauseAt(new Date(OPENED.getTime() + 10_500));
	}

	test("the sheet is the visitor's own today, and its timer started a believable while ago", async ({
		page,
	}) => {
		await open(page);

		await expect(productVisual(page)).toContainText("Wednesday 11 November");
		// It has run for most of an hour, since a time on the visitor's clock before now.
		const elapsed = await shownElapsed(page);
		expect(elapsed).toBeGreaterThan(10 * 60);
		expect(elapsed).toBeLessThan(2 * 3600);
		const status = await productVisual(page)
			.getByText(/^Running since/)
			.textContent();
		const since = (status ?? "").slice(-5);
		expect(seconds(`${since}:00`) + elapsed).toBe(15 * 3600 + 2 * 60 + 57);
	});

	test("the timer gains a second each second, and the day's total stays the entries shown added to it", async ({
		page,
	}) => {
		await open(page);
		const first = await shownElapsed(page);
		const logged = await loggedSeconds(page);
		expect(await shownTotal(page)).toBe(logged + first);

		for (const [wait, gained] of [
			[1000, 1],
			[1000, 2],
			[58_000, 60],
			[3_600_000, 3660],
		] as const) {
			await page.clock.runFor(wait);
			await expect.poll(() => shownElapsed(page)).toBe(first + gained);
			expect(await shownTotal(page)).toBe(logged + first + gained);
			expect(await loggedSeconds(page)).toBe(logged);
		}
	});

	test("the control stops the timer where it is, and starts it again from there", async ({
		page,
	}) => {
		await open(page);
		await stop(page).click();
		await expect(start(page)).toBeVisible();
		const held = await shownElapsed(page);
		const total = await shownTotal(page);

		await page.clock.runFor(90_000);
		expect(await shownElapsed(page)).toBe(held);
		expect(await shownTotal(page)).toBe(total);

		await start(page).click();
		await expect(stop(page)).toBeVisible();
		await page.clock.runFor(3000);
		await expect.poll(() => shownElapsed(page)).toBe(held + 3);
		expect(await shownTotal(page)).toBe(total + 3);
	});

	test("the control is worked from the keyboard, and nothing reads the time out as it changes", async ({
		page,
	}) => {
		await open(page);

		await stop(page).focus();
		await page.keyboard.press("Enter");
		await expect(start(page)).toBeFocused();
		await page.keyboard.press("Space");
		await expect(stop(page)).toBeFocused();

		const timer = productVisual(page).getByRole("timer");
		await expect(timer).toHaveAccessibleName(/./);
		expect(
			await page.evaluate(
				() => document.querySelectorAll("main [aria-live]:not([aria-live=off])").length,
			),
		).toBe(0);
	});

	test("the anatomy of an hour reads the same clock as the timer", async ({ page }) => {
		await open(page);
		await page.clock.runFor(4000);
		const elapsed = await drawn(productVisual(page).getByRole("timer"));

		// The window on the drawing's timer shows the running entry to the second.
		const readings = await anatomy(page).locator("text").allTextContents();
		expect(readings.map((reading) => reading.trim())).toContain(elapsed);
	});
});

for (const viewport of [COMPACT, WIDE]) {
	test.describe(`in a window ${viewport.width}px wide`, () => {
		test.use({ viewport });

		test("script takes the page over without moving anything on it", async ({ page, browser }) => {
			const still = await browser.newContext({ viewport, javaScriptEnabled: false });
			const without = await still.newPage();
			await without.goto("/", { waitUntil: "load" });
			const before = await layout(without);
			await still.close();

			await page.goto("/", { waitUntil: "load" });
			await expect(stop(page)).toBeVisible();

			expect(await layout(page)).toEqual(before);
		});

		test("the anatomy of an hour has a name, and says in words what it draws", async ({ page }) => {
			await page.goto("/");
			await anatomy(page).scrollIntoViewIfNeeded();

			// One drawing is on show at this width, and it does not run off the side.
			await expect(anatomy(page)).toHaveCount(1);
			await expect(anatomy(page)).toBeInViewport();
			const box = await anatomy(page).boundingBox();
			expect(box?.x).toBeGreaterThanOrEqual(0);
			expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);

			// Its description is the list of its numbered parts, each with a sentence.
			const description = await anatomy(page).getAttribute("aria-describedby");
			const parts = page.locator(`[id="${description}"]`).getByRole("listitem");
			await expect(parts).toHaveCount(6);
			for (const part of await parts.allInnerTexts()) {
				expect(part.split(/\s+/).length).toBeGreaterThan(8);
			}
		});

		test("the anatomy of an hour is put together as it is scrolled into the window", async ({
			page,
		}) => {
			await page.goto("/");
			await expect(stop(page)).toBeVisible();
			test.skip(
				!(await page.evaluate(() => CSS.supports("animation-timeline: view()"))),
				"This browser does not tie an animation to the scrolling: the figure is whole from the start.",
			);

			// Below the window, none of its numbered parts has arrived.
			expect(await faintestPart(page)).toBe(0);

			await anatomy(page).evaluate((drawing) =>
				drawing.scrollIntoView({ block: "center", behavior: "instant" }),
			);
			await expect.poll(() => faintestPart(page)).toBe(1);
		});
	});
}

test.describe("with reduced motion asked for", () => {
	test.use({ reducedMotion: "reduce" });

	test("the clock still tells the time, and nothing slides, grows or drifts", async ({ page }) => {
		await watchForMovement(page);
		await page.goto("/");
		await expect(stop(page)).toBeVisible();
		// The figure is whole before it has been scrolled to.
		expect(await faintestPart(page)).toBe(1);

		const first = await shownElapsed(page);
		await bringInEveryImage(page);
		await expect.poll(() => shownElapsed(page)).toBeGreaterThan(first);

		await stop(page).click();
		await expect(start(page)).toBeVisible();
		expect(await movement(page)).toEqual([]);
	});
});
