import type { Page } from "@playwright/test";

import {
	ARRIVAL,
	codeSentBy,
	newPerson,
	openAuthPage,
	ownAddress,
	signOut,
	signUp,
	TIME_WITH_TURNS,
} from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { EMPTY_INPUT, problems } from "./axe";
import { expect, test } from "./fixtures";
import { movement, watchForMovement } from "./motion";
import { openSettings } from "./organisation";

// Every view of the sign-up page, the sign-in page and the account part of
// Settings: no WCAG 2.2 A or AA violation and every text's contrast measured, at
// both window sizes and in both schemes (rules 14 and 16). Then rule 9: with
// reduced motion requested nothing on these pages moves or changes size.

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
			test.use({ viewport, colorScheme });

			test("every view of the sign-up page has no accessibility violations", async ({ page }) => {
				const person = newPerson();
				await openAuthPage(page, "/sign-up");
				expect(await page.evaluate(() => getComputedStyle(document.body).colorScheme)).toContain(
					colorScheme,
				);
				await expectNoProblems(page, "Create your account", [EMPTY_INPUT]);

				await page.getByLabel("Name").fill(person.name);
				await page.getByLabel("Email").fill(person.email);
				await expectNoProblems(page, "Create your account");
				const code = await codeSentBy(() => page.getByRole("button", { name: "Continue" }).click());
				await expectNoProblems(page, "Check your email", [EMPTY_INPUT]);

				await page.getByLabel("Code").fill(code);
				await expectNoProblems(page, "Check your email");
			});

			test("every view of the sign-in page has no accessibility violations", async ({ page }) => {
				const person = newPerson();
				await signUp(page, person);
				await signOut(page);

				await openAuthPage(page, "/sign-in");
				await expectNoProblems(page, "Sign in", [EMPTY_INPUT]);
				await page.getByLabel("Email").fill(person.email);
				await expectNoProblems(page, "Sign in");
				await codeSentBy(() => page.getByRole("button", { name: "Continue" }).click());
				await expectNoProblems(page, "Check your email", [EMPTY_INPUT]);
			});

			test("the account part of Settings has no accessibility violations", async ({ page }) => {
				await signUp(page, newPerson());
				await expect(page).toHaveURL(ARRIVAL);

				await openSettings(page);
				await expect(page.getByRole("button", { name: "Sign out everywhere" })).toBeVisible();
				await expectNoProblems(page, "Settings");
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
 * Every change of view the sign-up page makes, forward and back, as far as the
 * code typed into its last step: three changes of step. It stays on the page:
 * what the watcher has seen is the page's own. Returns the height of the page
 * at each step it stopped on.
 */
async function walkEveryStep(page: Page): Promise<number[]> {
	const heights: number[] = [];
	const person = newPerson();
	await openAuthPage(page, "/sign-up");
	await page.getByLabel("Name").fill(person.name);
	await page.getByLabel("Email").fill(person.email);
	// 1: forward, to the code.
	await codeSentBy(() => page.getByRole("button", { name: "Continue" }).click());
	await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
	heights.push(await pageHeight(page));

	// 2: back a step. 3: forward again.
	await page.getByRole("button", { name: "Use a different email" }).click();
	await expect(page.getByRole("heading", { level: 1, name: "Create your account" })).toBeVisible();
	heights.push(await pageHeight(page));
	const code = await codeSentBy(() => page.getByRole("button", { name: "Continue" }).click());
	await page.getByLabel("Code").fill(code);
	await expect(page.getByLabel("Code")).toHaveValue(code);
	return heights;
}

// Shorter than the sign-up page's taller step and taller than its shorter one,
// so the page outgrows the window at one step and fits it again at the other.
// At this width the step that takes the name and address measures 572px and
// the one that takes the code 624px.
const SHORT = { width: 1280, height: 600 };

test.describe("with reduced motion requested", () => {
	test.use({ reducedMotion: "reduce" });

	test("no step of the sign-up page moves or changes size", async ({ page }) => {
		await watchForMovement(page);
		await countViewTransitions(page);
		await walkEveryStep(page);
		expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
			true,
		);
		expect(await movement(page)).toEqual([]);
		expect(await viewTransitionsStarted(page)).toBe(0);
	});

	test.describe("in a window shorter than the page's taller step", () => {
		test.use({ viewport: SHORT });

		test("no step of the sign-up page moves or changes size", async ({ page }) => {
			await watchForMovement(page);
			await countViewTransitions(page);
			const heights = await walkEveryStep(page);

			// The case this test is for: the page was taller than the window, and was not.
			expect(Math.max(...heights)).toBeGreaterThan(SHORT.height);
			expect(Math.min(...heights)).toBe(SHORT.height);
			expect(await movement(page)).toEqual([]);
			expect(await viewTransitionsStarted(page)).toBe(0);
		});
	});

	// A change of step is not a view transition here (app/routes/auth/AuthPage.tsx,
	// `changeStep`). The watcher alone would not hold that: React sizes a
	// transition's overlay from script only when the two steps measure the same,
	// which depends on how an address wraps in the sentence around it.
	test("the steps of the sign-in page change without moving", async ({ page }) => {
		await watchForMovement(page);
		await countViewTransitions(page);
		await openAuthPage(page, "/sign-in");
		await page.getByLabel("Email").fill(newPerson().email);
		await codeSentBy(() => page.getByRole("button", { name: "Continue" }).click());
		await expect(page.getByLabel("Code")).toBeFocused();
		await page.getByRole("button", { name: "Use a different email" }).click();
		await expect(page.getByLabel("Email")).toBeFocused();

		expect(await movement(page)).toEqual([]);
		expect(await viewTransitionsStarted(page)).toBe(0);
	});

	// What takes the transition's place (rule 9: a fade or nothing).
	test("a step that arrives fades in, and the step the page loaded with does not", async ({
		page,
	}) => {
		// Every CSS transition that starts on a step, by the property it changes.
		await page.addInitScript(() => {
			const started: string[] = [];
			window.__stepTransitions = started;
			document.addEventListener("transitionrun", (event) => {
				if (event.target instanceof Element && event.target.localName === "main") {
					started.push(event.propertyName);
				}
			});
		});
		await openAuthPage(page, "/sign-in");
		await page.getByLabel("Email").fill(newPerson().email);
		expect(await page.evaluate(() => window.__stepTransitions)).toEqual([]);

		await codeSentBy(() => page.getByRole("button", { name: "Continue" }).click());
		await expect(page.getByLabel("Code")).toBeFocused();
		await expect.poll(() => page.evaluate(() => window.__stepTransitions)).toEqual(["opacity"]);
	});
});

test.describe("with motion allowed", () => {
	test.use({ reducedMotion: "no-preference" });

	// The same steps and the same watcher. This is what shows the tests above can fail.
	test("the watcher sees the steps of the sign-up page move", async ({ page }) => {
		await watchForMovement(page);
		await countViewTransitions(page);
		await walkEveryStep(page);

		// One for each change of step: forward, back, forward again.
		expect(await viewTransitionsStarted(page)).toBe(3);
		const seen = await movement(page);
		for (const moved of [
			/^animation of translate on <html>/, // a step arrives from the side it lies on
			/^transition of top on <label> "Code/, // a field's label floats
		]) {
			expect(seen).toContainEqual(expect.stringMatching(moved));
		}
	});

	// The sign-in page's two steps, there and back: one for each change of step.
	test("the steps of the sign-in page are view transitions", async ({ page }) => {
		await countViewTransitions(page);
		await openAuthPage(page, "/sign-in");
		await page.getByLabel("Email").fill(newPerson().email);
		await codeSentBy(() => page.getByRole("button", { name: "Continue" }).click());
		await expect(page.getByLabel("Code")).toBeFocused();
		await page.getByRole("button", { name: "Use a different email" }).click();
		await expect(page.getByLabel("Email")).toBeFocused();

		expect(await viewTransitionsStarted(page)).toBe(2);
	});
});
