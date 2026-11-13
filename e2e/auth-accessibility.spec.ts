import type { Page } from "@playwright/test";

import {
	ARRIVAL,
	CONTINUE,
	codeSentBy,
	newPerson,
	openAuthPage,
	ownAddress,
	signIn,
	TIME_WITH_TURNS,
} from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { EMPTY_INPUT, problems } from "./axe";
import { expect, test } from "./fixtures";
import { movement, watchForMovement } from "./motion";
import { openAccount } from "./organisation";

// Both views of the sign-in page and My account: no WCAG 2.2
// A or AA violation and every text's contrast measured, at both window sizes
// and in both schemes (rules 14 and 16). Then rule 9: with reduced motion
// requested nothing on the page moves or changes size.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

/** Scans the view on screen, once it is the one with this heading. */
async function expectNoProblems(page: Page, heading: string, unmeasurable: string[] = []) {
	await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
	expect(await problems(page, unmeasurable), `problems in "${heading}"`).toEqual([]);
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			// A scan measures the page settled: with reduced motion asked for, the
			// band at the top is not part-way through settling.
			test.use({ viewport, chosenScheme: colorScheme, reducedMotion: "reduce" });

			test("both views of the sign-in page have no accessibility violations, and nothing runs off the side", async ({
				page,
			}) => {
				const person = newPerson();
				await openAuthPage(page);
				expect(await page.evaluate(() => getComputedStyle(document.body).colorScheme)).toContain(
					colorScheme,
				);
				await expectNoProblems(page, "Enter your email", [EMPTY_INPUT]);

				await page.getByLabel("Email").fill(person.email);
				await expectNoProblems(page, "Enter your email");
				const code = await codeSentBy(() => page.getByRole("button", CONTINUE).click());
				await expectNoProblems(page, "Check your email", [EMPTY_INPUT]);

				await page.getByLabel("Code").fill(code);
				await expectNoProblems(page, "Check your email");
				expect(
					await page.evaluate(
						() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
					),
				).toBe(0);
			});

			test("My account has no accessibility violations", async ({ page }) => {
				await signIn(page, newPerson().email);
				await expect(page).toHaveURL(ARRIVAL);

				await openAccount(page);
				await expect(page.getByRole("button", { name: "Sign out everywhere" })).toBeVisible();
				await expectNoProblems(page, "My account");
			});
		});
	}
}

declare global {
	interface Window {
		__viewTransitionsStarted?: number;
		__stepTransitions?: string[];
	}
}

/**
 * Counts the view transitions the page starts, from before its first script
 * runs. Call before the page is opened.
 */
async function countViewTransitions(page: Page) {
	await page.addInitScript(() => {
		const start = document.startViewTransition.bind(document);
		window.__viewTransitionsStarted = 0;
		document.startViewTransition = ((...parameters: Parameters<typeof start>) => {
			window.__viewTransitionsStarted = (window.__viewTransitionsStarted ?? 0) + 1;
			return start(...parameters);
		}) as typeof document.startViewTransition;
	});
}

/** How many view transitions the page has started since it loaded. */
function viewTransitionsStarted(page: Page): Promise<number | undefined> {
	return page.evaluate(() => window.__viewTransitionsStarted);
}

/** The height of the page: the window's, or more when the page has outgrown the window. */
function pageHeight(page: Page): Promise<number> {
	return page.evaluate(() => document.documentElement.scrollHeight);
}

/**
 * Every change of view the sign-in page makes, forward and back, as far as the
 * code typed into its second view: three changes of view. It stays on the page:
 * what the watcher has seen is the page's own. Returns the height of the page
 * at each view it stopped on.
 */
async function walkEveryView(page: Page): Promise<number[]> {
	const heights: number[] = [];
	const person = newPerson();
	await openAuthPage(page);
	await page.getByLabel("Email").fill(person.email);
	// 1: forward, to the code.
	await codeSentBy(() => page.getByRole("button", CONTINUE).click());
	await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
	heights.push(await pageHeight(page));

	// 2: back a view. 3: forward again.
	await page.getByRole("button", { name: "Use a different email" }).click();
	await expect(page.getByRole("heading", { level: 1, name: "Enter your email" })).toBeVisible();
	heights.push(await pageHeight(page));
	const code = await codeSentBy(() => page.getByRole("button", CONTINUE).click());
	await page.getByLabel("Code").fill(code);
	await expect(page.getByLabel("Code")).toHaveValue(code);
	return heights;
}

// A window the page outgrows at one view and fits again at the other, so a
// scrollbar would come and go with the change of view. At this width the
// photograph is not shown and the view that takes the address, with the
// newsletter's box (TS-099), stands 745px tall with the band and the foot; the
// one that takes the code, 810px.
const BETWEEN = { width: 700, height: 780 };

test.describe("with reduced motion requested", () => {
	test.use({ reducedMotion: "reduce" });

	test("no view of the sign-in page moves or changes size", async ({ page }) => {
		await watchForMovement(page);
		await countViewTransitions(page);
		await walkEveryView(page);
		expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
			true,
		);
		expect(await movement(page)).toEqual([]);
		expect(await viewTransitionsStarted(page)).toBe(0);
	});

	test.describe("in a window shorter than the page's taller view", () => {
		test.use({ viewport: BETWEEN });

		test("no view of the sign-in page moves or changes size", async ({ page }) => {
			await watchForMovement(page);
			await countViewTransitions(page);
			const heights = await walkEveryView(page);

			// The case this test is for: the page was taller than the window, and was not.
			expect(Math.max(...heights)).toBeGreaterThan(BETWEEN.height);
			expect(Math.min(...heights)).toBe(BETWEEN.height);
			expect(await movement(page)).toEqual([]);
			expect(await viewTransitionsStarted(page)).toBe(0);
		});
	});

	// What takes the transition's place (rule 9: a fade or nothing).
	test("a view that arrives fades in, and the view the page loaded with does not", async ({
		page,
	}) => {
		// Every CSS transition that starts on a view, by the property it changes.
		// A view is the element that holds the page's heading and its form.
		await page.addInitScript(() => {
			const started: string[] = [];
			window.__stepTransitions = started;
			document.addEventListener("transitionrun", (event) => {
				if (event.target instanceof Element && event.target.matches("main > :has(> h1)")) {
					started.push(event.propertyName);
				}
			});
		});
		await openAuthPage(page);
		await page.getByLabel("Email").fill(newPerson().email);
		expect(await page.evaluate(() => window.__stepTransitions)).toEqual([]);

		await codeSentBy(() => page.getByRole("button", CONTINUE).click());
		await expect(page.getByLabel("Code")).toBeFocused();
		await expect.poll(() => page.evaluate(() => window.__stepTransitions)).toEqual(["opacity"]);
	});

	test("a view the page comes back to after a reload is simply there: nothing fades or moves", async ({
		page,
	}) => {
		await openAuthPage(page);
		await page.getByLabel("Email").fill(newPerson().email);
		await codeSentBy(() => page.getByRole("button", CONTINUE).click());
		await expect(page.getByLabel("Code")).toBeFocused();

		await watchForMovement(page);
		await countViewTransitions(page);
		await page.reload();
		await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
		expect(await movement(page)).toEqual([]);
		expect(await viewTransitionsStarted(page)).toBe(0);
	});
});

test.describe("with motion allowed", () => {
	test.use({ reducedMotion: "no-preference" });

	// The same views and the same watcher. This is what shows the tests above can fail.
	test("the watcher sees the views of the sign-in page move, and the band takes no part", async ({
		page,
	}) => {
		await watchForMovement(page);
		await countViewTransitions(page);
		// The band at the top, measured on every frame: it is the same through every change.
		await page.addInitScript(() => {
			const seen = new Set<string>();
			(window as Window & { __band?: Set<string> }).__band = seen;
			const look = () => {
				const band = document.querySelector("header")?.getBoundingClientRect();
				if (band) seen.add([band.x, band.y, band.width, band.height].join(","));
				requestAnimationFrame(look);
			};
			requestAnimationFrame(look);
		});
		await walkEveryView(page);

		// One for each change of view: forward, back, forward again.
		expect(await viewTransitionsStarted(page)).toBe(3);
		const seen = await movement(page);
		for (const moved of [
			/^animation of translate on <html>/, // a view arrives from the side it lies on
			/^transition of top on <label> "Code/, // a field's label floats
		]) {
			expect(seen).toContainEqual(expect.stringMatching(moved));
		}
		// Nothing of the band's own moves or scales.
		expect(seen.filter((line) => / on <(header|a|span|svg)\b.*Timesifier/.test(line))).toEqual([]);
		expect(
			await page.evaluate(() => [...((window as Window & { __band?: Set<string> }).__band ?? [])]),
		).toHaveLength(1);
	});
});
