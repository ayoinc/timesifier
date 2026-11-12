import type { Locator, Page } from "@playwright/test";

import { destinationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { contrast, EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";
import { createProject } from "./timesheet";

// Expenses in a browser (TS-070): an owner adds expense categories in
// Workspace settings, records an expense with its receipt from the keyboard
// alone, opens the receipt, submits the week, which locks the expense, and
// finds it in the Expenses view of Reports. Then the pages and the sheet at
// both window sizes and in both schemes, with no WCAG 2.2 A or AA violation.
// Each test is a new person with an organisation of their own, and nothing is
// seeded.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS * 2 });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

/** Today in UTC, the organisation's zone until someone chooses another. */
const today = () => new Date().toISOString().slice(0, 10);

/** The smallest file that starts as a PNG does. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const recordSheet = (page: Page) => page.getByRole("dialog", { name: "Record an expense" });

/** Adds a category in Workspace settings, with a unit and its price when given. */
async function addCategory(page: Page, slug: string, name: string, unit?: [string, string]) {
	await openShell(page, destinationPath(slug, "settings"));
	await page.getByRole("button", { name: "Add category" }).click();
	const sheet = page.getByRole("dialog", { name: "Add an expense category" });
	await sheet.getByLabel("Name").fill(name);
	if (unit) {
		await sheet.getByLabel("Unit", { exact: true }).fill(unit[0]);
		await sheet.getByLabel(/^Price per unit/).fill(unit[1]);
	}
	await sheet.getByRole("button", { name: "Add" }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("status")).toHaveText(`${name} added.`);
}

/** An owner with an organisation, a project and two categories, on Expenses. */
async function ownerWithCategories(page: Page) {
	await signIn(page, newPerson().email);
	const { slug } = await createOrganisation(page);
	await createProject(page, slug, "Site");
	await addCategory(page, slug, "Travel");
	await addCategory(page, slug, "Mileage", ["mile", "0.45"]);
	await expect(page.getByRole("list", { name: "Expense categories" })).toContainText(
		"£0.45 per mile",
	);
	return slug;
}

test("an expense is recorded with its receipt, submitted with the week, and reported", async ({
	page,
}) => {
	const slug = await ownerWithCategories(page);
	await openShell(page, destinationPath(slug, "expenses"));
	await expect(page.getByRole("heading", { level: 1, name: "Expenses" })).toBeVisible();

	// The keyboard alone records it.
	await page.getByRole("button", { name: "Record expense" }).focus();
	await page.keyboard.press("Enter");
	const sheet = recordSheet(page);
	await expect(sheet).toBeVisible();
	await sheet.getByRole("textbox", { name: "Date" }).fill(today());
	const category = sheet.getByRole("button", { name: /Category/ });
	await category.focus();
	await page.keyboard.press("Enter");
	const categories = page.getByRole("listbox", { name: "Category" });
	await expect(categories).toBeVisible();
	await page.keyboard.type("Tr");
	await expect(categories.getByRole("option", { name: "Travel" })).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(category).toContainText("Travel");
	await sheet.getByLabel(/^Receipt/).setInputFiles({
		name: "taxi.png",
		mimeType: "image/png",
		buffer: PNG,
	});
	await sheet.getByLabel("Notes (optional)").focus();
	await page.keyboard.type("Taxi to the client");
	const amount = sheet.getByLabel(/^Amount \(GBP\)/);
	await amount.focus();
	await page.keyboard.type("12.50");
	await page.keyboard.press("Enter");
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("status")).toHaveText("Expense recorded.");

	const week = page.getByRole("list", { name: /^Expenses, week of/ });
	await expect(week).toContainText("Travel · Site");
	await expect(week).toContainText("£12.50");
	await expect(week).toContainText("Taxi to the client");

	// Its receipt is served to its person, as it was sent.
	const receipt = week.getByRole("link", { name: "Receipt: taxi.png" });
	const href = await receipt.getAttribute("href");
	const served = await page.request.get(href ?? "");
	expect(served.status()).toBe(200);
	expect(served.headers()["content-type"]).toBe("image/png");
	expect(Buffer.from(await served.body())).toEqual(PNG);

	// A unit-priced category asks for a quantity at its price.
	await page.getByRole("button", { name: "Record expense" }).click();
	await sheet.getByRole("button", { name: /Category/ }).click();
	await page
		.getByRole("listbox", { name: "Category" })
		.getByRole("option", { name: "Mileage" })
		.click();
	await expect(sheet.getByText("£0.45 per mile on that day.")).toBeVisible();
	await sheet.getByLabel(/^Quantity \(mile\)/).fill("10");
	await sheet.getByRole("button", { name: "Record" }).click();
	await expect(sheet).toBeHidden();
	await expect(week).toContainText("10 × £0.45 per mile");
	await expect(page.getByRole("main")).toContainText("£17.00");

	// Submitting the week locks its expenses with its time.
	await page.getByRole("button", { name: "Submit week" }).click();
	const confirming = page.getByRole("dialog", { name: "Submit this week?" });
	await confirming.getByRole("button", { name: "Submit week" }).click();
	await expect(page.getByRole("status")).toHaveText(
		"Week submitted. Its time and expenses are locked until it is decided.",
	);
	await expect(week).toContainText("Locked while the week is submitted");
	await expect(week.getByRole("button", { name: /^Change / })).toHaveCount(0);

	// Reports has an Expenses view, by category.
	await openShell(page, destinationPath(slug, "reports"));
	await page.getByRole("link", { name: "Report on expenses" }).click();
	await expect(page.getByRole("heading", { level: 1, name: "Expense report" })).toBeVisible();
	const byCategory = page.getByRole("list", { name: "Expenses by category" });
	await expect(byCategory).toContainText("Travel");
	await expect(byCategory).toContainText("£12.50");
	await expect(byCategory).toContainText("Mileage");
	await expect(page.getByRole("link", { name: "Export as CSV" })).toHaveAttribute(
		"href",
		/\/reports\/expenses\/export\?/,
	);
});

/** `unmeasurable`: what axe may leave unmeasured, such as an empty field. */
async function expectNoProblems(page: Page, heading: string, unmeasurable: string[] = []) {
	await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
	expect(await problems(page, unmeasurable), `problems in "${heading}"`).toEqual([]);
}

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

			test("Expenses, its sheet, the categories and the Expenses view of Reports", async ({
				page,
			}) => {
				await signIn(page, newPerson().email);
				const { slug } = await createOrganisation(page);
				// With no category yet, the empty state says where to add one.
				await openShell(page, destinationPath(slug, "expenses"));
				await expect(
					page.getByRole("link", { name: "Add them in Workspace settings" }),
				).toBeVisible();
				await expectNoProblems(page, "Expenses");

				await createProject(page, slug, "Site");
				await addCategory(page, slug, "Mileage", ["mile", "0.45"]);
				await expectNoProblems(page, "Workspace settings", [EMPTY_INPUT]);

				await openShell(page, destinationPath(slug, "expenses"));
				await page.getByRole("button", { name: "Record expense" }).click();
				const sheet = recordSheet(page);
				await expectNoProblemsInSheet(page, sheet, sheet.getByText("Reimburse me"));

				await page.getByRole("button", { name: "Record expense" }).click();
				await sheet.getByLabel(/^Quantity \(mile\)/).fill("4");
				await sheet.getByRole("button", { name: "Record" }).click();
				await expect(sheet).toBeHidden();
				await expect(page.getByRole("status")).toHaveText("Expense recorded.");
				await expectNoProblems(page, "Expenses", [EMPTY_INPUT]);

				await openShell(page, `${destinationPath(slug, "reports")}/expenses`);
				await expectNoProblems(page, "Expense report", [EMPTY_INPUT]);
			});
		});
	}
}
