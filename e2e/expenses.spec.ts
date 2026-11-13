import type { Locator, Page } from "@playwright/test";

import { destinationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { contrast, EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";
import { createProject } from "./timesheet";

// Expenses in a browser (TS-070): an owner finds the usual expense categories
// in Workspace settings (TS-119), records an expense with its receipt from the keyboard
// alone, opens the receipt, submits the week, which locks the expense, and
// finds it in the Expenses view of Reports. With TS-092, an expense carries a
// tag chosen from the keyboard, the Expenses view is a tab of Reports chosen
// as the time report is, filtered by the tag and stepped by the stepper, and
// a backwards range is refused under its field. Then the pages and the sheet
// at both window sizes and in both schemes, with no WCAG 2.2 A or AA
// violation. Each test is a new person with an organisation of their own, and
// nothing is seeded.

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

/** An owner with an organisation, a project and the usual categories (TS-119). */
async function ownerWithCategories(page: Page) {
	await signIn(page, newPerson().email);
	const { slug } = await createOrganisation(page);
	await createProject(page, slug, "Site");
	await openShell(page, destinationPath(slug, "settings"));
	const categories = page.getByRole("list", { name: "Expense categories" });
	await expect(categories).toContainText("Travel");
	await expect(categories).toContainText("£0.55 per mile from Monday 6 April 2026");
	return slug;
}

/** Creates an active tag on Tasks, Tags. */
async function createTag(page: Page, slug: string, name: string) {
	await openShell(page, `${destinationPath(slug, "tasks")}?list=tags`);
	await page.getByRole("button", { name: "Create tag" }).click();
	const sheet = page.getByRole("dialog", { name: "Create a tag" });
	await sheet.getByLabel("Tag name").fill(name);
	await sheet.getByRole("button", { name: "Create the tag" }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("status")).toHaveText(`Tag created: ${name}.`);
}

/** Opens the list of `button`, a Select, from the keyboard and picks `option` by typing. */
async function choose(page: Page, button: Locator, list: string, option: string) {
	await button.focus();
	await page.keyboard.press("Enter");
	const listbox = page.getByRole("listbox", { name: list });
	await expect(listbox).toBeVisible();
	await page.keyboard.type(option.slice(0, 4));
	await expect(listbox.getByRole("option", { name: option })).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(listbox).toBeHidden();
}

/** Follows a link from the keyboard. */
async function follow(page: Page, link: Locator) {
	await link.focus();
	await page.keyboard.press("Enter");
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
	await page.keyboard.type("Trav");
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
	await expect(sheet.getByText("£0.55 per mile on that day.")).toBeVisible();
	await sheet.getByLabel(/^Quantity \(mile\)/).fill("10");
	await sheet.getByRole("button", { name: "Record" }).click();
	await expect(sheet).toBeHidden();
	await expect(week).toContainText("10 × £0.55 per mile");
	await expect(page.getByRole("main")).toContainText("£18.00");

	// Submitting the week locks its expenses with its time.
	await page.getByRole("button", { name: "Submit week" }).click();
	const confirming = page.getByRole("dialog", { name: "Submit this week?" });
	await confirming.getByRole("button", { name: "Submit week" }).click();
	await expect(page.getByRole("status")).toHaveText(
		"Week submitted. Its time and expenses are locked until it is decided.",
	);
	await expect(week).toContainText("Locked while the week is submitted");
	await expect(week.getByRole("button", { name: /^Change / })).toHaveCount(0);

	// Reports has an Expenses view, by category, among its tabs.
	await openShell(page, destinationPath(slug, "reports"));
	await page
		.getByRole("group", { name: "Report views" })
		.getByRole("link", { name: "Expenses" })
		.click();
	await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
	const byCategory = page.getByRole("list", { name: "Expenses by category" });
	await expect(byCategory).toContainText("Travel");
	await expect(byCategory).toContainText("£12.50");
	await expect(byCategory).toContainText("Mileage");
	await expect(page.getByRole("link", { name: "Export as CSV" })).toHaveAttribute(
		"href",
		/\/reports\/expenses\/export\?/,
	);
});

test.describe("tags on expenses and the Expenses view of Reports (TS-092)", () => {
	// A backwards range is answered 400 on purpose, which Chromium logs; the
	// address is known once the organisation is made.
	const refused: Record<string, number[]> = {};
	// biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's needs from its first argument.
	test.use({ refusals: async ({}, use) => use(refused) });

	test("an expense tagged from the keyboard, the report filtered by it, stepped, and a range refused inline", async ({
		page,
	}) => {
		const slug = await ownerWithCategories(page);
		await createTag(page, slug, "Retainer");
		await openShell(page, destinationPath(slug, "expenses"));

		// The keyboard alone records it with its tag.
		await follow(page, page.getByRole("button", { name: "Record expense" }));
		const sheet = recordSheet(page);
		await expect(sheet).toBeVisible();
		await sheet.getByRole("textbox", { name: "Date" }).fill(today());
		await choose(page, sheet.getByRole("button", { name: /Category/ }), "Category", "Travel");
		const tag = sheet.getByRole("checkbox", { name: "Retainer" });
		await tag.focus();
		await page.keyboard.press("Space");
		await expect(tag).toBeChecked();
		await sheet.getByLabel(/^Amount \(GBP\)/).fill("12.50");
		await page.keyboard.press("Enter");
		await expect(sheet).toBeHidden();
		await expect(page.getByRole("status")).toHaveText("Expense recorded.");
		const week = page.getByRole("list", { name: /^Expenses, week of/ });
		await expect(week).toContainText("Tags: Retainer");

		// One without the tag.
		await follow(page, page.getByRole("button", { name: "Record expense" }));
		await sheet.getByRole("textbox", { name: "Date" }).fill(today());
		await choose(page, sheet.getByRole("button", { name: /Category/ }), "Category", "Travel");
		await sheet.getByLabel(/^Amount \(GBP\)/).fill("4.50");
		await page.keyboard.press("Enter");
		await expect(sheet).toBeHidden();

		// The Expenses tab of Reports, filtered by the tag.
		await openShell(page, destinationPath(slug, "reports"));
		const tabs = page.getByRole("group", { name: "Report views" });
		await follow(page, tabs.getByRole("link", { name: "Expenses" }));
		await expect(tabs.getByRole("link", { name: "Expenses" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		const ledger = page.getByRole("main");
		await expect(ledger).toContainText("£17.00");
		await choose(page, page.getByRole("button", { name: "Any tag Tag" }), "Tag", "Retainer");
		await expect(page).toHaveURL(/[?&]tag=/);
		await expect(ledger).toContainText("£12.50");
		await expect(ledger).not.toContainText("£17.00");
		await expect(page.getByRole("link", { name: "Export as CSV" })).toHaveAttribute(
			"href",
			/\/reports\/expenses\/export\?.*tag=/,
		);

		// The stepper moves the range, keeping the tag, and comes back.
		const stepper = page.getByRole("group", { name: "Report range" });
		await follow(page, stepper.getByRole("link", { name: "Previous week" }));
		await expect(page.getByText("No expenses in this range.")).toBeVisible();
		await expect(page).toHaveURL(/range=week.*tag=/);
		await follow(page, stepper.getByRole("link", { name: "This week" }));
		await expect(ledger).toContainText("£12.50");
		await expect(page).toHaveURL(/tag=/);

		// A range that runs backwards is refused under its field, and putting it right applies it.
		const path = `${destinationPath(slug, "reports")}/expenses`;
		refused[path] = [400];
		refused[`${path}.data`] = [400];
		await openShell(page, `${path}?range=custom&from=2026-11-12&to=2026-11-01&group=category`);
		await expect(page.getByText("Must be on or after the first day")).toBeVisible();
		await expect(page.getByRole("link", { name: "Export as CSV" })).toHaveCount(0);
		await page.getByLabel("Last day").fill("2026-11-13");
		await expect(page.getByText("Must be on or after the first day")).toHaveCount(0);
		await expect(page.getByRole("link", { name: "Export as CSV" })).toBeVisible();
	});
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

			test("Expenses with a tag, its sheet, the categories, and the Expenses and Contractors tabs of Reports", async ({
				page,
			}) => {
				await signIn(page, newPerson().email);
				const { slug } = await createOrganisation(page);
				// The usual categories are there from the start (TS-119); a project is not.
				await openShell(page, destinationPath(slug, "expenses"));
				await expect(
					page.getByText("There are no active projects to record an expense on yet."),
				).toBeVisible();
				await expectNoProblems(page, "Expenses");

				await createProject(page, slug, "Site");
				await createTag(page, slug, "Retainer");
				await openShell(page, destinationPath(slug, "settings"));
				await expect(page.getByRole("list", { name: "Expense categories" })).toContainText(
					"Mileage",
				);
				await expectNoProblems(page, "Workspace settings", [EMPTY_INPUT]);

				await openShell(page, destinationPath(slug, "expenses"));
				await page.getByRole("button", { name: "Record expense" }).click();
				const sheet = recordSheet(page);
				await expectNoProblemsInSheet(page, sheet, sheet.getByText("Reimburse me"));

				await page.getByRole("button", { name: "Record expense" }).click();
				await choose(page, sheet.getByRole("button", { name: /Category/ }), "Category", "Mileage");
				await sheet.getByLabel(/^Quantity \(mile\)/).fill("4");
				const tag = sheet.getByRole("checkbox", { name: "Retainer" });
				await tag.focus();
				await page.keyboard.press("Space");
				await expect(tag).toBeChecked();
				await sheet.getByRole("button", { name: "Record" }).click();
				await expect(sheet).toBeHidden();
				await expect(page.getByRole("status")).toHaveText("Expense recorded.");
				await expect(page.getByText("Tags: Retainer")).toBeVisible();
				await expectNoProblems(page, "Expenses", [EMPTY_INPUT]);

				await openShell(page, `${destinationPath(slug, "reports")}/expenses`);
				const tabs = page.getByRole("group", { name: "Report views" });
				// At 390px the six tabs wrap into rows of three, every one in view.
				for (const name of ["Time", "Expenses", "Contractors"]) {
					await expect(tabs.getByRole("link", { name })).toHaveCount(1);
				}
				await expect(page.getByRole("group", { name: "Report range" })).toBeVisible();
				await expectNoProblems(page, "Reports", [EMPTY_INPUT]);
				await tabs.getByRole("link", { name: "Contractors" }).click();
				await expect(tabs.getByRole("link", { name: "Contractors" })).toHaveAttribute(
					"aria-current",
					"page",
				);
				await expectNoProblems(page, "Reports", [EMPTY_INPUT]);
			});
		});
	}
}
