import type { Locator } from "@playwright/test";

import { expect, openGallery, test } from "./fixtures";

// The gallery shows every component in every state, in the light scheme and the
// dark scheme. That it answers 404 in a normal build is test/design-route.test.ts.

const COMPONENTS = [
	"Button",
	"IconButton",
	"TextField",
	"Checkbox",
	"Switch",
	"RadioGroup",
	"Select",
	"Menu",
	"Dialog",
	"Sheet",
	"Tabs",
	"LinkTabs",
	"FilterBar",
	"PeriodStepper",
	"Links",
	"Snackbar",
	"Tooltip",
	"Digits",
	"TimerMark",
	"Ledger",
	"Dates",
	"WaitClock",
];

async function style(element: Locator, property: string): Promise<string> {
	return element.evaluate((node, name) => getComputedStyle(node).getPropertyValue(name), property);
}

test.beforeEach(async ({ page }) => {
	await openGallery(page);
});

for (const [scheme, colorScheme] of [
	["Light scheme", "light"],
	["Dark scheme", "dark"],
] as const) {
	test(`${scheme}: every component is drawn in the ${colorScheme} colours`, async ({ page }) => {
		const gallery = page.getByRole("region", { name: scheme });
		expect(await style(gallery, "color-scheme")).toBe(colorScheme);
		for (const component of COMPONENTS) {
			await expect(gallery.getByRole("heading", { name: component, exact: true })).toBeVisible();
		}

		// The two halves resolve the same colour role to different colours.
		const other = page.getByRole("region", {
			name: scheme === "Light scheme" ? "Dark scheme" : "Light scheme",
		});
		expect(await style(gallery, "background-color")).not.toBe(
			await style(other, "background-color"),
		);
		const save = gallery.getByRole("button", { name: "Save" }).first();
		expect(await style(save, "background-color")).not.toBe(
			await style(other.getByRole("button", { name: "Save" }).first(), "background-color"),
		);
	});

	test(`${scheme}: hover, focus and pressed are held in place and look different from rest`, async ({
		page,
	}) => {
		const gallery = page.getByRole("region", { name: scheme });
		const rest = gallery.getByRole("button", { name: "Save" }).first();
		const hover = gallery.getByRole("button", { name: "Hover" }).first();
		const focus = gallery.getByRole("button", { name: "Focus" }).first();
		const pressed = gallery.getByRole("button", { name: "Pressed" }).first();

		// The attributes are the ones React Aria sets for the real state.
		await expect(hover).toHaveAttribute("data-hovered", "true");
		await expect(focus).toHaveAttribute("data-focus-visible", "true");
		await expect(pressed).toHaveAttribute("data-pressed", "true");

		// Let the state layers and the pressed shape finish arriving.
		await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
		const restColour = await style(rest, "background-color");
		expect(await style(hover, "background-color")).not.toBe(restColour);
		expect(await style(pressed, "background-color")).not.toBe(restColour);
		expect(await style(pressed, "border-top-left-radius")).not.toBe(
			await style(rest, "border-top-left-radius"),
		);
		expect(await style(rest, "outline-style")).toBe("none");
		expect(await style(focus, "outline-style")).toBe("solid");

		// The same holds for a control built on hooks, and for one inside a collection.
		await expect(gallery.getByText("Hover", { exact: true }).nth(0)).toBeVisible();
		await expect(
			gallery.locator("label", { has: page.getByRole("checkbox", { name: "Hover" }) }),
		).toHaveAttribute("data-hovered", "true");
		await expect(
			gallery.locator("label", { has: page.getByRole("switch", { name: "Pressed" }) }),
		).toHaveAttribute("data-pressed", "true");
		await expect(
			gallery.locator("label", { has: page.getByRole("radio", { name: "Hover" }) }),
		).toHaveAttribute("data-hovered", "true");
		await expect(gallery.getByRole("textbox", { name: "Focus" })).toHaveAttribute(
			"data-focused",
			"true",
		);
		const tabs = gallery.getByRole("tablist", { name: "Tab states" });
		await expect(tabs.getByRole("tab", { name: "Hover" })).toHaveAttribute("data-hovered", "true");
		expect(await style(tabs.getByRole("tab", { name: "Focus" }), "outline-style")).toBe("solid");
	});

	test(`${scheme}: disabled, invalid and selected states are shown`, async ({ page }) => {
		const gallery = page.getByRole("region", { name: scheme });

		// One for each variant of Button (six) and of IconButton (four), and the Select.
		const disabled = gallery.getByRole("button", { name: /disabled$/i });
		await expect(disabled).toHaveCount(11);
		for (const button of await disabled.all()) await expect(button).toBeDisabled();
		await expect(gallery.getByRole("textbox", { name: "Disabled" })).toBeDisabled();
		await expect(gallery.getByRole("checkbox", { name: "Disabled and selected" })).toBeDisabled();
		await expect(gallery.getByRole("checkbox", { name: "Disabled and selected" })).toBeChecked();
		await expect(gallery.getByRole("switch", { name: "Disabled on" })).toBeDisabled();
		await expect(gallery.getByRole("radio", { name: "Disabled and chosen" })).toBeDisabled();
		await expect(gallery.getByRole("radio", { name: "Disabled and chosen" })).toBeChecked();
		await expect(gallery.getByRole("tab", { name: "Year" })).toHaveAttribute(
			"aria-disabled",
			"true",
		);

		await expect(gallery.getByRole("textbox", { name: "Hourly rate" })).toHaveAttribute(
			"aria-invalid",
			"true",
		);
		await expect(gallery.getByText("Enter a number, such as 85.")).toBeVisible();
		await expect(gallery.getByRole("checkbox", { name: "Accept the terms" })).toHaveAttribute(
			"aria-invalid",
			"true",
		);
		await expect(gallery.getByText("Choose a project.")).toBeVisible();

		await expect(gallery.getByRole("checkbox", { name: "Round to 15 minutes" })).toBeChecked();
		await expect(gallery.getByRole("switch", { name: "Idle detection" })).toBeChecked();
		await expect(gallery.getByRole("radio", { name: "Monday" })).toBeChecked();
		await expect(gallery.getByRole("button", { name: "Borealis With a value" })).toBeVisible();
		await expect(gallery.getByRole("tab", { name: "Week" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	});
}

// Every kind of date, written by app/time/format.ts as the gallery renders. The
// server and the browser write each the same, whatever the engine: WebKit once
// wrote "Mon 9" where the server wrote "9 Mon", and the page failed to hydrate
// (audit W06). The fixtures fail a test on that error too.
test("Dates: each kind is written one way, the server's, in this browser", async ({ page }) => {
	for (const scheme of ["Light scheme", "Dark scheme"]) {
		const dates = page
			.getByRole("region", { name: scheme })
			.locator("section")
			.filter({ has: page.getByRole("heading", { name: "Dates", exact: true }) });
		await expect(dates.locator("dd")).toHaveText([
			"Wednesday 11 November",
			"Mon 9",
			"Wednesday 11 November 2026",
			"9–15 November 2026",
			"30 November – 6 December 2026",
			"28 December 2026 – 3 January 2027",
			"November 2026",
			"09:30",
			"21:33–02:33",
			"Wednesday 11 November at 09:30",
			"0:07",
		]);
	}
});
