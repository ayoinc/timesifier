import type { Locator, Page } from "@playwright/test";

import {
	addAuthenticator,
	codeSentBy,
	newPerson,
	openAuthPage,
	ownAddress,
	signOut,
	signUp,
	TIME_WITH_TURNS,
} from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { EMPTY_INPUT, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { movement, watchForMovement } from "./motion";

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

/** Text whose lines lie over different elements further down the stack, such as a dialog's. */
const OVER_SEVERAL_ELEMENTS = "elmPartiallyObscuring";

/**
 * The WCAG contrast ratio of an element's text against the nearest background
 * behind it that is not transparent. For text axe could not measure.
 */
function contrast(text: Locator): Promise<number> {
	return text.evaluate((element) => {
		// A canvas turns any colour CSS can write into red, green, blue and alpha.
		const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
		if (!canvas) throw new Error("no canvas");
		const channels = (colour: string) => {
			canvas.clearRect(0, 0, 1, 1);
			canvas.fillStyle = colour;
			canvas.fillRect(0, 0, 1, 1);
			return [...canvas.getImageData(0, 0, 1, 1).data];
		};
		const luminance = (colour: string) => {
			const [red = 0, green = 0, blue = 0] = channels(colour).map((channel) => {
				const share = channel / 255;
				return share <= 0.04045 ? share / 12.92 : ((share + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
		};

		let behind: Element | null = element;
		while (behind && channels(getComputedStyle(behind).backgroundColor)[3] !== 255) {
			behind = behind.parentElement;
		}
		if (!behind) throw new Error("no opaque background behind the text");

		const [lighter = 0, darker = 0] = [
			luminance(getComputedStyle(element).color),
			luminance(getComputedStyle(behind).backgroundColor),
		].sort((a, b) => b - a);
		return (lighter + 0.05) / (darker + 0.05);
	});
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
				await addAuthenticator(page);
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
				await page.getByRole("button", { name: "Create account" }).click();
				await expectNoProblems(page, "Your account is ready");

				await page.getByRole("button", { name: "Create a passkey" }).click();
				await expectNoProblems(page, "Your passkey is ready");
			});

			test("every view of the sign-in page has no accessibility violations", async ({ page }) => {
				const person = newPerson();
				await signUp(page, person);
				await page.getByRole("button", { name: "Not now" }).click();
				await signOut(page);

				await openAuthPage(page, "/sign-in");
				await expectNoProblems(page, "Sign in");

				// With its message showing: there is no passkey in this browser.
				await page.getByRole("button", { name: "Sign in with a passkey" }).click();
				await expect(page.getByRole("alert")).toContainText("No passkey was used.");
				await expectNoProblems(page, "Sign in");

				await page.getByRole("button", { name: "Use an email code instead" }).click();
				await expectNoProblems(page, "Sign in with an email code", [EMPTY_INPUT]);
				await page.getByLabel("Email").fill(person.email);
				await codeSentBy(() => page.getByRole("button", { name: "Continue" }).click());
				await expectNoProblems(page, "Check your email", [EMPTY_INPUT]);
			});

			test("the account part of Settings has no accessibility violations", async ({ page }) => {
				await addAuthenticator(page);
				await signUp(page, newPerson());
				await page.getByRole("button", { name: "Not now" }).click();
				await expect(page).toHaveURL("/app");

				// With no passkey, then with one and the message that says so.
				await openShell(page, "/app/settings");
				await expectNoProblems(page, "Settings");
				await page.getByRole("button", { name: "Add a passkey" }).click();
				await expect(page.getByRole("status").filter({ hasText: "Passkey added" })).toBeVisible();
				await expectNoProblems(page, "Settings");

				// The open dialog. Its lines of text lie over different parts of the page,
				// which is one thing axe cannot measure through; that text is measured here.
				await page.getByRole("button", { name: /^Remove the passkey added/ }).click();
				const dialog = page.getByRole("alertdialog", { name: "Remove this passkey?" });
				await expect(dialog).toBeVisible();
				expect(await problems(page, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS])).toEqual([]);
				expect(
					await contrast(dialog.getByText("It will stop signing you in")),
					"contrast of the dialog's text",
				).toBeGreaterThanOrEqual(4.5);
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
 * Every change of view the sign-up page makes, forward and back, as far as its
 * last step. It stays on the page: what the watcher has seen is the page's own.
 * Returns the height of the page at each step it stopped on.
 */
async function walkEveryStep(page: Page): Promise<number[]> {
	const heights: number[] = [];
	const person = newPerson();
	await addAuthenticator(page);
	await openAuthPage(page, "/sign-up");
	await page.getByLabel("Name").fill(person.name);
	await page.getByLabel("Email").fill(person.email);
	await codeSentBy(() => page.getByRole("button", { name: "Continue" }).click());
	await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
	heights.push(await pageHeight(page));

	// Back a step and forward again.
	await page.getByRole("button", { name: "Use a different email" }).click();
	await expect(page.getByRole("heading", { level: 1, name: "Create your account" })).toBeVisible();
	heights.push(await pageHeight(page));
	const code = await codeSentBy(() => page.getByRole("button", { name: "Continue" }).click());
	await page.getByLabel("Code").fill(code);
	await page.getByRole("button", { name: "Create account" }).click();

	// The two moments that are marked: the account, then the passkey.
	await expect(
		page.getByRole("heading", { level: 1, name: "Your account is ready" }),
	).toBeVisible();
	heights.push(await pageHeight(page));
	await page.getByRole("button", { name: "Create a passkey" }).click();
	await expect(
		page.getByRole("heading", { level: 1, name: "Your passkey is ready" }),
	).toBeVisible();
	heights.push(await pageHeight(page));
	return heights;
}

// Shorter than the sign-up page's tallest step and taller than its shortest, so
// the page outgrows the window at one step and fits it again at another.
const SHORT = { width: 1280, height: 560 };

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

	test.describe("in a window shorter than the page's tallest step", () => {
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
		await page.getByRole("button", { name: "Use an email code instead" }).click();
		await expect(page.getByLabel("Email")).toBeFocused();
		await page.getByRole("button", { name: "Use a passkey instead" }).click();
		await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();

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
		expect(await page.evaluate(() => window.__stepTransitions)).toEqual([]);

		await page.getByRole("button", { name: "Use an email code instead" }).click();
		await expect(page.getByLabel("Email")).toBeFocused();
		await expect.poll(() => page.evaluate(() => window.__stepTransitions)).toEqual(["opacity"]);
	});
});

test.describe("with motion allowed", () => {
	test.use({ reducedMotion: "no-preference" });

	// The same steps and the same watcher. This is what shows the test above can fail.
	test("the watcher sees the steps of the sign-up page move", async ({ page }) => {
		await watchForMovement(page);
		await countViewTransitions(page);
		await walkEveryStep(page);

		// One for each change of step: the count above can be other than nothing.
		expect(await viewTransitionsStarted(page)).toBe(5);
		const seen = await movement(page);
		for (const moved of [
			/^animation of translate on <html>/, // a step arrives from the side it lies on
			/^transition of scale on <span>/, // the mark of a moment grows in
			/^transition of top on <label> "Code/, // a field's label floats
		]) {
			expect(seen).toContainEqual(expect.stringMatching(moved));
		}
	});
});
