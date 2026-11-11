import type { Locator, Page } from "@playwright/test";

import { expect, openGallery, test } from "./fixtures";

// The label of a field rests on the line where the value goes and moves up out
// of its way once the field has focus or a value; the line under the field
// thickens with focus. Both follow the control's state.
//
// These run in WebKit as well as Chromium (playwright.config.ts). WebKit 27.2
// did not restyle a text input's siblings for an attribute written during an
// event, which is how React Aria reports focus: the label stayed on top of what
// a person typed. docs/design-system.md, "State from another element".

function gallery(page: Page): Locator {
	return page.getByRole("region", { name: "Light scheme" });
}

/** The label, and the line along the bottom, of the field `control` is in. */
function parts(control: Locator) {
	const container = control.locator("xpath=..");
	return {
		label: container.locator(":scope > label, :scope > span").first(),
		line: container.locator(":scope > span").last(),
	};
}

/**
 * How far the label reaches down into the line the value is written on, in
 * pixels: positive while the label rests there, zero or less once it has moved
 * above it.
 */
async function reachIntoValueLine(control: Locator): Promise<number> {
	const { label } = parts(control);
	const [labelBox, valueTop] = await Promise.all([
		label.boundingBox(),
		control.evaluate(
			(element) =>
				element.getBoundingClientRect().top +
				Number.parseFloat(getComputedStyle(element).paddingTop),
		),
	]);
	if (!labelBox) throw new Error("the field has no label on the page");
	return Math.round(labelBox.y + labelBox.height - valueTop);
}

async function lineHeight(control: Locator): Promise<number> {
	return Math.round((await parts(control).line.boundingBox())?.height ?? Number.NaN);
}

test.beforeEach(async ({ page }) => {
	await openGallery(page);
});

test("TextField: the label rests on the value's line while the field is empty and left alone", async ({
	page,
}) => {
	const field = gallery(page).getByRole("textbox", { name: "Project name" });

	expect(await reachIntoValueLine(field)).toBeGreaterThan(0);
	expect(await lineHeight(field)).toBe(1);
});

test("TextField: the label moves above the value's line with focus, stays there while a person types, and after", async ({
	page,
}) => {
	const field = gallery(page).getByRole("textbox", { name: "Project name" });

	await field.focus();
	await expect.poll(() => reachIntoValueLine(field)).toBeLessThanOrEqual(0);
	await expect.poll(() => lineHeight(field)).toBe(2);

	await field.pressSequentially("Atlas");
	await expect(field).toHaveValue("Atlas");
	expect(await reachIntoValueLine(field)).toBeLessThanOrEqual(0);

	await field.blur();
	await expect.poll(() => lineHeight(field)).toBe(1);
	expect(await reachIntoValueLine(field)).toBeLessThanOrEqual(0);
});

test("TextField: the label comes back down when the field is left empty", async ({ page }) => {
	const field = gallery(page).getByRole("textbox", { name: "Project name" });

	await field.focus();
	await expect.poll(() => reachIntoValueLine(field)).toBeLessThanOrEqual(0);

	await field.blur();
	await expect.poll(() => reachIntoValueLine(field)).toBeGreaterThan(0);
});

test("TextField: a value that arrives without focus, as a browser's autofill does, moves the label up", async ({
	page,
}) => {
	const field = gallery(page).getByRole("textbox", { name: "Project name" });

	// Autofill sets the value and sends an input event; the field never has focus.
	await field.evaluate((element) => {
		const input = element as HTMLInputElement;
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Atlas");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});

	await expect(field).toHaveValue("Atlas");
	await expect.poll(() => reachIntoValueLine(field)).toBeLessThanOrEqual(0);
});

test("Select: the label moves above the value's line with focus and comes back down without a value", async ({
	page,
}) => {
	const select = gallery(page).getByRole("button", { name: "Billing project" });

	expect(await reachIntoValueLine(select)).toBeGreaterThan(0);

	await select.focus();
	await expect.poll(() => reachIntoValueLine(select)).toBeLessThanOrEqual(0);
	await expect.poll(() => lineHeight(select)).toBe(2);

	await select.blur();
	await expect.poll(() => reachIntoValueLine(select)).toBeGreaterThan(0);
});

test("the sign-up page: the label of the name moves above the value's line with focus and stays there while a person types", async ({
	page,
}) => {
	// Where the defect was seen: a page the server rendered, with nothing else on it.
	await page.context().clearCookies();
	await page.goto("/sign-up");
	const field = page.getByRole("textbox", { name: "Name" });
	await expect(page.locator("#react-aria-pressable-style")).toBeAttached();
	expect(await reachIntoValueLine(field)).toBeGreaterThan(0);

	await field.focus();
	await expect.poll(() => reachIntoValueLine(field)).toBeLessThanOrEqual(0);
	await expect.poll(() => lineHeight(field)).toBe(2);

	await field.pressSequentially("Ada");
	await expect(field).toHaveValue("Ada");
	expect(await reachIntoValueLine(field)).toBeLessThanOrEqual(0);

	await page.getByRole("textbox", { name: "Email" }).focus();
	await expect.poll(() => lineHeight(field)).toBe(1);
	expect(await reachIntoValueLine(field)).toBeLessThanOrEqual(0);
});
