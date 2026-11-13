import { crc32, deflateSync } from "node:zlib";

import type { Locator, Page } from "@playwright/test";

import { destinationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { contrast, EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";

// Brand in a browser (TS-100): an owner uploads a PNG logo and sets a colour in
// Workspace settings from the keyboard alone, sees the colour's preview, too
// light and then dark enough, and saves both; the band of every page then
// shows the organisation's logo beside its name, until it is removed. Then the
// page and its two sheets at both window sizes and in both schemes, with no
// WCAG 2.2 A or AA violation. Each test is a new person with an organisation
// of their own, and nothing is seeded.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS * 2 });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

/** One PNG chunk: its length, its type, its data and their CRC. */
function chunk(type: string, data: Buffer): Buffer {
	const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const sum = Buffer.alloc(4);
	sum.writeUInt32BE(crc32(typed));
	return Buffer.concat([length, typed, sum]);
}

/** A PNG `width` by `height` of one colour, which a browser draws: a logo to upload. */
function solidPng(width: number, height: number, [red, green, blue]: [number, number, number]) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8); // 8 bits per channel, RGB, no interlace.
	const row = Buffer.alloc(1 + width * 3);
	for (let x = 0; x < width; x++) row.set([red, green, blue], 1 + x * 3);
	const rows = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(rows)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const LOGO = { name: "logo.png", mimeType: "image/png", buffer: solidPng(96, 32, [15, 118, 110]) };
/** Dark enough for white words on it: 5.5 to 1. */
const TEAL = "#0f766e";
/** Too light for white words on it. */
const AMBER = "#ffd54f";

/** The organisation's logo in the band at the top of the page, beside its name. */
const bandLogo = (page: Page) => page.getByRole("banner").locator('img[src*="/logo?v="]');

/** Presses `button` from the keyboard. */
async function press(page: Page, button: Locator) {
	await button.focus();
	await page.keyboard.press("Enter");
}

/** Uploads `LOGO` in Brand, by pointer: for the scans, which the keyboard test covers. */
async function uploadLogo(page: Page) {
	await page.getByRole("button", { name: "Upload a logo" }).click();
	const sheet = page.getByRole("dialog", { name: "Upload a logo" });
	await sheet.getByLabel("Logo", { exact: true }).setInputFiles(LOGO);
	await sheet.getByRole("button", { name: "Save logo" }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("status")).toContainText("The logo is saved.");
}

test("a logo and a colour are set from the keyboard, the band shows the logo, and it is removed", async ({
	page,
}) => {
	await signIn(page, newPerson().email);
	const { name, slug } = await createOrganisation(page);
	await openShell(page, destinationPath(slug, "settings"));
	const brand = page.getByRole("region", { name: "Brand" });
	await expect(brand).toContainText("No logo");
	await expect(brand).toContainText("No colour");
	await expect(bandLogo(page)).toHaveCount(0);

	// The logo: a PNG, chosen in the sheet's file field, saved by Enter.
	await press(page, brand.getByRole("button", { name: "Upload a logo" }));
	const logoSheet = page.getByRole("dialog", { name: "Upload a logo" });
	await expect(logoSheet).toBeVisible();
	const field = logoSheet.getByLabel("Logo", { exact: true });
	await expect(field).toHaveAccessibleDescription(/A PNG, SVG, JPEG or WebP of up to 256 KB/);
	await field.setInputFiles(LOGO);
	await press(page, logoSheet.getByRole("button", { name: "Save logo" }));
	await expect(logoSheet).toBeHidden();
	await expect(page.getByRole("status")).toHaveText(
		`The logo is saved. It leads your documents and stands beside ${name}.`,
	);
	const shown = brand.getByRole("img", { name: `The logo of ${name}` });
	await expect(shown).toBeVisible();
	await expect(brand).toContainText("Logo, a PNG.");

	// The band shows it, drawn, beside the organisation's name, on this page and the next.
	for (const path of [destinationPath(slug, "settings"), destinationPath(slug, "timesheet")]) {
		await openShell(page, path);
		const logo = bandLogo(page);
		await expect(logo).toBeVisible();
		expect(await logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(96);
		await expect(page.getByRole("banner")).toContainText(name);
	}
	await openShell(page, destinationPath(slug, "settings"));

	// The colour: its preview says whether white words read on it before it is saved.
	await press(page, brand.getByRole("button", { name: "Change the colour" }));
	const colourSheet = page.getByRole("dialog", { name: "Change the colour" });
	await expect(colourSheet).toBeVisible();
	const colour = colourSheet.getByRole("textbox", { name: "Colour" });
	await colour.focus();
	await page.keyboard.type("#0f7");
	await expect(colourSheet).toContainText("Not a colour yet.");
	await page.keyboard.press("ControlOrMeta+a");
	await page.keyboard.type(AMBER);
	await expect(colourSheet).toContainText(/White on it: 1\.\d to 1\. Too light: it needs at least/);
	const save = colourSheet.getByRole("button", { name: "Save colour" });
	await expect(save).toBeDisabled();
	await page.keyboard.press("ControlOrMeta+a");
	await page.keyboard.type(TEAL);
	await expect(colourSheet).toContainText("White on it: 5.5 to 1. Dark enough.");
	await expect(save).toBeEnabled();
	await page.keyboard.press("Enter");
	await expect(colourSheet).toBeHidden();
	await expect(page.getByRole("status")).toHaveText(
		"The colour is saved. It leads your documents and the emails that carry them.",
	);
	await expect(brand).toContainText(TEAL);
	await page.reload();
	await expect(page.getByRole("region", { name: "Brand" })).toContainText(TEAL);

	// Removed, the logo leaves the page and the band; the colour stays.
	await press(page, brand.getByRole("button", { name: "Remove the logo" }));
	const removeSheet = page.getByRole("dialog", { name: "Remove the logo" });
	await expect(removeSheet).toBeVisible();
	await press(page, removeSheet.getByRole("button", { name: "Remove logo" }));
	await expect(removeSheet).toBeHidden();
	await expect(page.getByRole("status")).toHaveText(
		"The logo is removed. Your documents carry your name alone.",
	);
	await expect(brand).toContainText("No logo");
	await expect(shown).toHaveCount(0);
	await expect(bandLogo(page)).toHaveCount(0);
	await expect(brand).toContainText(TEAL);
	await expect(brand.getByRole("button", { name: "Upload a logo" })).toBeVisible();
});

/** The sheet `sheet` open, then closed by Escape, with no problem while it is open. */
async function expectNoProblemsInSheet(page: Page, sheet: Locator, text: Locator) {
	await expect(sheet).toBeVisible();
	expect(
		await problems(page, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS, EMPTY_INPUT]),
		"problems with the sheet open",
	).toEqual([]);
	expect(await contrast(text), "contrast of the sheet's text").toBeGreaterThanOrEqual(4.5);
	await page.keyboard.press("Escape");
	await expect(sheet).toBeHidden();
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });

			test("Brand, its two sheets, and the band with the organisation's logo", async ({ page }) => {
				await signIn(page, newPerson().email);
				const { name, slug } = await createOrganisation(page);
				await openShell(page, destinationPath(slug, "settings"));
				await uploadLogo(page);
				await expect(bandLogo(page)).toBeVisible();
				await expect(page.getByRole("img", { name: `The logo of ${name}` })).toBeVisible();
				await expect(
					page.getByRole("heading", { level: 1, name: "Workspace settings", exact: true }),
				).toBeVisible();
				expect(await problems(page, [EMPTY_INPUT]), "problems in Workspace settings").toEqual([]);

				await page.getByRole("button", { name: "Replace the logo" }).click();
				const logoSheet = page.getByRole("dialog", { name: "Replace the logo" });
				await expectNoProblemsInSheet(
					page,
					logoSheet,
					logoSheet.getByText(/^A PNG, SVG, JPEG or WebP/),
				);

				await page.getByRole("button", { name: "Change the colour" }).click();
				const colourSheet = page.getByRole("dialog", { name: "Change the colour" });
				await colourSheet.getByRole("textbox", { name: "Colour" }).fill(TEAL);
				await expect(colourSheet).toContainText("Dark enough.");
				await expectNoProblemsInSheet(page, colourSheet, colourSheet.getByText(/^White on it/));
			});
		});
	}
}
