import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Locator, Page, Route } from "@playwright/test";
import { NEW_ORGANISATION_PATH } from "../app/shell/destinations";
import { CONTINUE, codeSentBy, newPerson, openAuthPage, ownAddress } from "./auth";
import { SIGNED_IN, SIGNED_OUT } from "./auth-state";
import { EMPTY_INPUT, problems } from "./axe";
import { expect, openGallery, openShell, test } from "./fixtures";
import { homePath, newOrganisationName, openOutsideOrganisation } from "./organisation";

// TS-102: the WaitClock, at a wait that is not a page (docs/design-system.md,
// "While the page waits"). The network is slowed with a route that holds the
// request, so the wait is longer than the clock's 400ms. A control that waits
// shows nothing new for 400ms, then the clock and its words; it is as wide and
// as tall throughout; a second press sends nothing; with reduced motion the
// hand stands still and the words stay.
//
// With SHOT_DIR set, it photographs the gallery's row and a sending button
// there (cmux-assets/browser/timesifier/TS-102/).

const SHOTS = process.env.SHOT_DIR;
/** How long a slowed request is held: well past the 400ms the clock waits. */
const HELD_MS = 2_000;
/** The clock's delay (`--md-sys-motion-duration-medium4`). */
const APPEARS_AFTER_MS = 400;
/** One frame's slack either side of it. */
const FRAME_MS = 17;

declare global {
	interface Window {
		__clock?: { mounted: number; seen: number; sawEarly: boolean };
	}
}

/**
 * Holds every request `matches` accepts for `HELD_MS`, then lets it go on, and
 * counts them: a control that waits must send one.
 */
async function slow(page: Page, matches: (url: URL, method: string) => boolean) {
	const sent: string[] = [];
	await page.route("**/*", async (route: Route) => {
		const request = route.request();
		if (!matches(new URL(request.url()), request.method())) return route.fallback();
		sent.push(request.url());
		await sleep(HELD_MS);
		await route.fallback();
	});
	return sent;
}

/**
 * Watches `control` from before it is pressed: the moment its clock is put on
 * the page, the first frame its clock can be seen, and whether it could be seen
 * before 400ms had passed.
 */
async function watchClock(control: Locator) {
	await control.evaluate((element, early) => {
		const watch = { mounted: 0, seen: 0, sawEarly: false };
		window.__clock = watch;
		const look = () => {
			const art = element.querySelector<HTMLElement>("[data-wait-clock]");
			if (art) {
				const now = performance.now();
				watch.mounted ||= now;
				const opacity = Number(getComputedStyle(art).opacity);
				if (opacity > 0 && now - watch.mounted < early) watch.sawEarly = true;
				if (opacity > 0 && !watch.seen) watch.seen = now;
			}
			if (!watch.seen) requestAnimationFrame(look);
		};
		requestAnimationFrame(look);
	}, APPEARS_AFTER_MS - FRAME_MS);
}

async function clockTiming(page: Page) {
	await expect.poll(() => page.evaluate(() => window.__clock?.seen ?? 0)).toBeGreaterThan(0);
	const watch = await page.evaluate(() => window.__clock);
	if (!watch) throw new Error("The clock was not watched.");
	return { after: watch.seen - watch.mounted, sawEarly: watch.sawEarly };
}

async function sizeOf(control: Locator) {
	const box = await control.boundingBox();
	if (!box) throw new Error("The control is not on the page.");
	return { width: box.width, height: box.height };
}

test.describe("signing in", () => {
	test.use({ storageState: SIGNED_OUT });
	test.beforeEach(async ({ context, baseURL }) => {
		await ownAddress(context, baseURL);
	});

	test("Continue waits with the clock while the code is sent and while it is checked", async ({
		page,
	}) => {
		test.slow();
		const sending = await slow(
			page,
			(url, method) => method === "POST" && url.pathname.endsWith("/send-verification-otp"),
		);
		await openAuthPage(page);
		const person = newPerson();
		await page.getByLabel("Email").fill(person.email);
		const proceed = page.getByRole("button", CONTINUE);
		const atRest = await sizeOf(proceed);
		await watchClock(proceed);

		const code = await codeSentBy(async () => {
			await proceed.click();
			// Pending at once, the clock not yet seen.
			await expect(proceed).toHaveAttribute("data-waiting", "true");
			await expect(proceed).toHaveAttribute("aria-disabled", "true");
			const timing = await clockTiming(page);
			expect(timing.sawEarly, "the clock was seen before 400ms").toBe(false);
			expect(timing.after).toBeGreaterThanOrEqual(APPEARS_AFTER_MS - FRAME_MS);
			expect(timing.after).toBeLessThan(APPEARS_AFTER_MS + 300);
			await expect(proceed.locator('[data-doing="Sending…"]')).toBeVisible();
			// The button is the one place the wait is seen; the status says it to a screen reader alone.
			await expect(page.getByRole("status").filter({ hasText: "Sending the code…" })).toHaveClass(
				/\bsr-only\b/,
			);
			expect(await sizeOf(proceed)).toEqual(atRest);
			// A second press, and Enter in the field, send nothing more.
			await proceed.click({ force: true });
			await page.getByLabel("Email").press("Enter");
			if (SHOTS) {
				await proceed.screenshot({ path: join(SHOTS, "sending-continue.png") });
				await page.screenshot({ path: join(SHOTS, "sending-sign-in.png") });
			}
		});
		expect(sending).toHaveLength(1);

		// The code is checked, and Continue waits again, saying so.
		await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
		const checking = await slow(
			page,
			(url, method) => method === "POST" && url.pathname.endsWith("/sign-in/email-otp"),
		);
		await page.getByLabel("Code").fill(code);
		const verify = page.getByRole("button", CONTINUE);
		const verifyAtRest = await sizeOf(verify);
		await verify.click();
		await expect(verify).toHaveAttribute("data-waiting", "true");
		await expect(verify.locator('[data-doing="Checking…"]')).toBeVisible();
		await expect(verify.locator("[data-wait-clock]")).toBeVisible();
		expect(await sizeOf(verify)).toEqual(verifyAtRest);
		await verify.click({ force: true });
		await page.waitForURL((url) => url.pathname !== "/sign-in");
		expect(checking).toHaveLength(1);
	});
});

test("Create organisation waits with the clock, at its size, and is sent once", async ({
	page,
}) => {
	const sent = await slow(
		page,
		(url, method) => method === "POST" && url.pathname.startsWith(NEW_ORGANISATION_PATH),
	);
	await openOutsideOrganisation(page, NEW_ORGANISATION_PATH);
	await page.getByLabel("Organisation name").fill(newOrganisationName());
	const create = page.getByRole("button", { name: "Create organisation" });
	const atRest = await sizeOf(create);
	await watchClock(create);
	await create.click();
	await expect(create).toHaveAttribute("data-waiting", "true");
	const timing = await clockTiming(page);
	expect(timing.sawEarly, "the clock was seen before 400ms").toBe(false);
	expect(timing.after).toBeGreaterThanOrEqual(APPEARS_AFTER_MS - FRAME_MS);
	await expect(create.locator('[data-doing="Creating…"]')).toBeVisible();
	expect(await sizeOf(create)).toEqual(atRest);
	await create.click({ force: true });
	await page.getByLabel("Organisation name").press("Enter");
	await page.waitForURL((url) => !url.pathname.startsWith(NEW_ORGANISATION_PATH));
	expect(sent).toHaveLength(1);
});

test("an export waits with the clock in its link until the file arrives, and is fetched once", async ({
	page,
}) => {
	const exports = homePath("integrations");
	const sent = await slow(
		page,
		(url, method) => method === "GET" && url.pathname === `${exports}/export`,
	);
	await openShell(page, exports);
	const link = page.getByRole("link", { name: "Export all time as a CSV" });
	const atRest = await sizeOf(link);
	await expect(link.locator("[data-wait-clock]")).toHaveCount(0);
	await watchClock(link);

	const downloading = page.waitForEvent("download");
	await link.click();
	await expect(link).toHaveAttribute("data-waiting", "true");
	const timing = await clockTiming(page);
	expect(timing.sawEarly, "the clock was seen before 400ms").toBe(false);
	expect(timing.after).toBeGreaterThanOrEqual(APPEARS_AFTER_MS - FRAME_MS);
	await expect(link.locator('[data-doing="Exporting…"]')).toBeVisible();
	expect(await sizeOf(link)).toEqual(atRest);
	if (SHOTS) await link.screenshot({ path: join(SHOTS, "exporting-link.png") });
	await link.click({ force: true });
	await link.press("Enter");

	const download = await downloading;
	expect(download.suggestedFilename()).toMatch(/-all-time\.csv$/);
	await expect(link).not.toHaveAttribute("data-waiting");
	await expect(link.locator("[data-wait-clock]")).toHaveCount(0);
	expect(await sizeOf(link)).toEqual(atRest);
	expect(sent).toHaveLength(1);
});

test("without script an export is an ordinary link that downloads the file", async ({
	browser,
	baseURL,
}) => {
	const context = await browser.newContext({
		javaScriptEnabled: false,
		storageState: SIGNED_IN,
		baseURL,
	});
	const page = await context.newPage();
	await page.goto(homePath("integrations"));
	const link = page.getByRole("link", { name: "Export all time as a CSV" });
	await expect(link).toHaveAttribute("download", "");
	const downloading = page.waitForEvent("download");
	await link.click();
	expect((await downloading).suggestedFilename()).toMatch(/-all-time\.csv$/);
	await context.close();
});

test.describe("the clock's hand", () => {
	test.describe("with motion", () => {
		test.use({ reducedMotion: "no-preference" });

		test("sweeps one turn every 1.2s on the standard easing, by transform alone", async ({
			page,
		}) => {
			await openGallery(page, "/design?open=wait");
			const hand = page.locator(".wait-clock-hand").first();
			const turn = await hand.evaluate((element) =>
				element.getAnimations().map((animation) => {
					const timing = animation.effect?.getComputedTiming();
					const keyframes = (animation.effect as KeyframeEffect).getKeyframes();
					return {
						duration: timing?.duration,
						iterations: timing?.iterations,
						easing: getComputedStyle(element).animationTimingFunction,
						properties: [
							...new Set(
								keyframes.flatMap((frame) =>
									Object.keys(frame).filter(
										(key) => !["offset", "computedOffset", "easing", "composite"].includes(key),
									),
								),
							),
						],
					};
				}),
			);
			expect(turn).toEqual([
				{
					duration: 1200,
					iterations: Number.POSITIVE_INFINITY,
					easing: "cubic-bezier(0.2, 0, 0, 1)",
					properties: ["transform"],
				},
			]);
		});
	});

	test.describe("with reduced motion", () => {
		test.use({ reducedMotion: "reduce" });

		test("stands at twelve, and the clock and its words still appear", async ({ page }) => {
			await openGallery(page, "/design?open=wait");
			const gallery = page.getByRole("region", { name: "Light scheme" });
			const hands = gallery.locator(".wait-clock-hand");
			expect(await hands.count()).toBeGreaterThan(0);
			for (const hand of await hands.all()) {
				expect(await hand.evaluate((element) => element.getAnimations().length)).toBe(0);
				expect(await hand.evaluate((element) => getComputedStyle(element).transform)).toBe("none");
			}
			const send = gallery.getByRole("button", { name: "Send", exact: true });
			await expect(send.locator('[data-doing="Sending…"]')).toBeVisible();
			await expect(send.locator("[data-wait-clock]")).toBeVisible();
			await expect(gallery.getByRole("status").getByText("Reading the file…")).toBeVisible();
		});
	});
});

test.describe("accessibility", () => {
	// The hand turns for ever, and a scan waits for every animation to finish; with
	// reduced motion it stands still, and the colours scanned are the same.
	test.use({ reducedMotion: "reduce" });

	for (const width of [390, 1280]) {
		for (const scheme of ["light", "dark"] as const) {
			test(`the waiting row has no violations at ${width}px in the ${scheme} scheme`, async ({
				page,
			}) => {
				await page.setViewportSize({ width, height: 900 });
				await openGallery(page, `/design?open=wait&scheme=${scheme}`);
				const row = page
					.getByRole("region", { name: scheme === "light" ? "Light scheme" : "Dark scheme" })
					.locator("section", { has: page.getByRole("heading", { name: "WaitClock" }) });
				await expect(row.getByText("Reading the file…")).toBeVisible();
				expect(await problems(page, [EMPTY_INPUT])).toEqual([]);
				if (SHOTS && width === 1280) {
					await row.screenshot({ path: join(SHOTS, `gallery-${scheme}.png`) });
				}
				if (SHOTS && width === 390) {
					await row.screenshot({ path: join(SHOTS, `gallery-${scheme}-390.png`) });
				}
			});
		}
	}
});
