import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { PLATFORM_BRAND_PATH, PLATFORM_PATH, VERIFY_PATH } from "../app/platform/paths";
import { codeSentBy, foundInMessageSentBy, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { EMPTY_INPUT, problems } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { aPlatformOwner } from "./platform-owners";

// The console's Brand page in a browser (TS-120). A platform owner opens it
// from the console's tabs with the keyboard; the preview follows the form as it
// is typed, and a colour neither ink nor white reads on cannot be saved; an
// SVG is drawn as a PNG before it is sent. Then a save, done with the
// keyboard, and the test email, which the owner receives. At both window sizes
// in both schemes, with no WCAG 2.2 A or AA violation. The screenshots go
// where the card's review reads them.

const SHOTS =
	process.env.SHOT_DIR ??
	"/Users/ayodele.ajayi/Workspace/Personal/cmux-assets/browser/timesifier/TS-120";

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS * 2 });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

/** Presses Tab until `target` has the focus. */
async function tabTo(page: Page, target: Locator, most = 80) {
	for (let step = 0; step < most; step++) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press("Tab");
	}
	throw new Error("Tab never reached the control.");
}

/** Signs a platform owner in, proves the session, and moves to Brand by its tab, with the keyboard. */
async function openBrand(page: Page) {
	await signIn(page, aPlatformOwner());
	await openShell(page, VERIFY_PATH, "header");
	const code = await codeSentBy(() =>
		page.getByRole("button", { name: "Send a code", exact: true }).click(),
	);
	await page.getByLabel("Code").fill(code);
	await page.getByRole("button", { name: "Open the console" }).click();
	await expect(page).toHaveURL(PLATFORM_PATH);
	const tab = page.getByRole("link", { name: "Brand", exact: true });
	await tabTo(page, tab);
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(PLATFORM_BRAND_PATH);
	await expect(page.getByRole("heading", { level: 1, name: "Brand" })).toBeVisible();
}

/** Replaces what a field holds by the keyboard: Tab to it, select all, type. */
async function retype(page: Page, field: Locator, text: string) {
	await tabTo(page, field);
	await page.keyboard.press("ControlOrMeta+A");
	if (text === "") await page.keyboard.press("Backspace");
	else await page.keyboard.type(text);
}

const band = (page: Page) => page.getByRole("img", { name: /^The band, in / }).locator("rect");

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });
			const at = `${viewport.width}-${colorScheme}`;

			test("the Brand page by the keyboard: the preview follows the form, and a colour nothing reads on is not saved", async ({
				page,
			}) => {
				mkdirSync(SHOTS, { recursive: true });
				await openBrand(page);
				expect(await problems(page, [EMPTY_INPUT]), "problems on Brand").toEqual([]);
				await page.evaluate(() => window.scrollTo(0, 0));
				await page.screenshot({ path: join(SHOTS, `brand-${at}.png`), fullPage: true });

				const preview = page.getByRole("figure", { name: "Preview of a message" });
				const senderName = page.getByLabel("Sender name");
				await retype(page, senderName, "Timesifier Support");
				await expect(preview).toContainText("Timesifier Support");
				await retype(page, page.getByLabel("Email footer"), "Sent by the team.");
				await expect(preview).toContainText("Sent by the team.");

				const colour = page.getByLabel("Brand colour");
				await retype(page, colour, "#808080");
				await expect(page.getByText("Neither reaches 4.5 to 1")).toBeVisible();
				await expect(page.getByRole("button", { name: "Save brand" })).toBeDisabled();
				await expect(band(page)).toHaveAttribute("fill", "#808080");
				await retype(page, colour, "#1d4ed8");
				await expect(page.getByText(/White on it: [\d.]+ to 1\. Readable\./)).toBeVisible();
				await expect(band(page)).toHaveAttribute("fill", "#1d4ed8");
				await expect(page.getByRole("button", { name: "Save brand" })).toBeEnabled();

				// An SVG is drawn as a PNG in the browser, shown, and put in the field the server reads.
				const logo = preview.locator("img").first();
				const savedLogo = await logo.getAttribute("src");
				await page.getByLabel("Logo", { exact: true }).setInputFiles({
					name: "logo.svg",
					mimeType: "image/svg+xml",
					buffer: Buffer.from(
						'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="teal"/></svg>',
					),
				});
				await expect
					.poll(() =>
						page
							.locator('input[name="logoPng"]')
							.evaluate((input: HTMLInputElement) => input.files?.[0]?.type),
					)
					.toBe("image/png");
				await expect(logo).not.toHaveAttribute("src", savedLogo ?? "");
				await expect(logo).toHaveAttribute("src", /^data:image\/png;base64,/);

				expect(await problems(page, [EMPTY_INPUT]), "problems on Brand, typed").toEqual([]);
				await page.evaluate(() => {
					(document.activeElement as HTMLElement | null)?.blur();
					window.scrollTo(0, 0);
				});
				await page.screenshot({ path: join(SHOTS, `brand-typed-${at}.png`), fullPage: true });
				// Nothing typed here is kept: the page is left without saving.
			});
		});
	}
}

test("a save by the keyboard is said and logged, and the test email reaches the owner in the saved brand", async ({
	page,
}) => {
	mkdirSync(SHOTS, { recursive: true });
	await openBrand(page);
	const tagline = page.getByLabel("Tagline");
	const before = await tagline.inputValue();
	const changed = before === "Hours you can trust." ? "Track your hours." : "Hours you can trust.";

	try {
		await retype(page, tagline, changed);
		await tabTo(page, page.getByRole("button", { name: "Save brand" }));
		await page.keyboard.press("Enter");
		await expect(
			page.getByRole("status").filter({ hasText: "Saved. Changed the tagline." }),
		).toBeVisible();
		expect(await problems(page, [EMPTY_INPUT]), "problems after a save").toEqual([]);
		await page.screenshot({ path: join(SHOTS, "brand-saved-1280-light.png"), fullPage: true });

		const send = page.getByRole("button", { name: "Send me a test email" });
		await tabTo(page, send);
		const found = await foundInMessageSentBy(
			() => page.keyboard.press("Enter"),
			new RegExp(changed.replace(".", "\\.")),
			"the saved tagline",
		);
		expect(found).toBe(changed);
		await expect(
			page.getByRole("status").filter({ hasText: "Sent a test email to" }),
		).toBeVisible();
		await expect(page.getByText(/\d of 5 left this hour\./)).toBeVisible();

		await page.getByRole("link", { name: "Log", exact: true }).click();
		await expect(page.getByText("Sent a test email of the brand").first()).toBeVisible();
		await expect(page.getByText("Changed the brand").first()).toBeVisible();
	} finally {
		// The brand is put back as it was, for the tests that run after this one.
		await openShell(page, PLATFORM_BRAND_PATH, "header");
		await retype(page, page.getByLabel("Tagline"), before);
		await page.getByRole("button", { name: "Save brand" }).click();
		await expect(
			page.getByRole("status").filter({ hasText: /^Saved\.|^Nothing was saved/ }),
		).toBeVisible();
	}
});
