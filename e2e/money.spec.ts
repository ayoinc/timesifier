import type { Locator, Page } from "@playwright/test";

import { defaultRatesPath, projectPath } from "../app/projects/projects";
import { destinationPath, organisationPath } from "../app/shell/destinations";
import { foundInMessageSentBy, newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { contrast, EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";
import { createProject, workEveryDay } from "./timesheet";

// Tasks, rates and budgets in a browser (TS-066, TS-067, TS-069): an owner
// makes a task, opens a project's own page and moves between its tabs, sets
// the project's rate and a budget, and tracks time with the task picker, the
// keyboard alone doing all of it; the project then shows the hours, the money
// and the budget gone over, and Track time warns of it. Then every page and
// sheet of it at both window sizes and in both schemes, with no WCAG 2.2 A or
// AA violation. Each test is a new person with an organisation of their own:
// what they add is seen by no other test, and nothing is seeded.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS * 2 });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

const trackSheet = (page: Page) => page.getByRole("dialog", { name: "Track time" });
const tabs = (page: Page) => page.getByRole("group", { name: "Project pages" });
/** The Budget sheet; its Select's list is a dialog named Budget too, so the sheet is the one with Save. */
const budgetSheet = (page: Page) =>
	page
		.getByRole("dialog", { name: "Budget" })
		.filter({ has: page.getByRole("button", { name: "Save budget" }) });

/** Presses Tab until `target` has the focus: the way a person without a pointer gets there. */
async function tabTo(page: Page, target: Locator, most = 80) {
	for (let step = 0; step < most; step++) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press("Tab");
	}
	throw new Error("Tab never reached the control.");
}

/** Chooses `option` in the Select `select` with the keyboard: Enter opens it, typing moves, Enter chooses. */
async function choose(page: Page, select: Locator, list: string, option: string) {
	await tabTo(page, select);
	await page.keyboard.press("Enter");
	const listbox = page.getByRole("listbox", { name: list });
	await expect(listbox).toBeVisible();
	await page.keyboard.type(option.slice(0, 3));
	await expect(listbox.getByRole("option", { name: option, exact: true })).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(listbox).toBeHidden();
}

/** Creates a task on the Tasks page, on every new project, with the keyboard alone. */
async function createTask(page: Page, slug: string, name: string) {
	await openShell(page, destinationPath(slug, "tasks"));
	await tabTo(page, page.getByRole("button", { name: "Create task" }));
	await page.keyboard.press("Enter");
	const sheet = page.getByRole("dialog", { name: "Create a task" });
	await expect(sheet.getByLabel("Task name")).toBeFocused();
	await page.keyboard.type(name);
	await page.keyboard.press("Enter");
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("status")).toHaveText(`Task created: ${name}.`);
	await expect(page.getByRole("list", { name: "Active tasks" })).toContainText(name);
}

/**
 * A new person's organisation, with a task Research on every new project, and
 * the project Site, that works every day: time is tracked today, and is
 * regular time whatever day the run is on (TS-095).
 */
async function siteWithResearch(page: Page) {
	await signIn(page, newPerson().email);
	const { slug } = await createOrganisation(page);
	await createTask(page, slug, "Research");
	await createProject(page, slug, "Site");
	await workEveryDay(page, slug);
	return slug;
}

test("an owner sets a project's rate and budget and tracks time to a task, the keyboard alone doing it; the project shows the hours, money and budget, and Track time warns", async ({
	page,
}) => {
	const slug = await siteWithResearch(page);

	// From Projects, the project's name opens its own page.
	await openShell(page, destinationPath(slug, "projects"));
	await tabTo(page, page.getByRole("main").getByRole("link", { name: "Site", exact: true }));
	await page.keyboard.press("Enter");
	await expect(page.getByRole("heading", { level: 1, name: "Site" })).toBeVisible();
	await expect(tabs(page).getByRole("link", { name: "Overview" })).toHaveAttribute(
		"aria-current",
		"page",
	);

	// Its tabs are links, each its own address.
	await tabTo(page, tabs(page).getByRole("link", { name: "Settings" }));
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(projectPath(slug, await projectIdIn(page), "settings"));
	await expect(tabs(page).getByRole("link", { name: "Settings" })).toHaveAttribute(
		"aria-current",
		"page",
	);

	// A rate: £120 an hour for the project, from today.
	await tabTo(page, page.getByRole("button", { name: "Change billing" }));
	await page.keyboard.press("Enter");
	const billing = page.getByRole("dialog", { name: "Billing" });
	await expect(billing).toBeVisible();
	await tabTo(page, billing.getByRole("textbox", { name: "Project rate an hour" }));
	await page.keyboard.type("120");
	await page.keyboard.press("Enter");
	await expect(billing).toBeHidden();
	await expect(page.getByRole("status")).toHaveText("Billing saved: Time and materials.");
	const settings = page.getByRole("list", { name: "The project's settings" });
	await expect(settings).toContainText("£120.00 an hour");

	// A budget: one hour in all, its people warned once it is over.
	await tabTo(page, page.getByRole("button", { name: "Change budget" }));
	await page.keyboard.press("Enter");
	const budget = budgetSheet(page);
	await expect(budget).toBeVisible();
	await choose(page, budget.getByRole("button", { name: /Budget$/ }), "Budget", "Total hours");
	await tabTo(page, budget.getByRole("textbox", { name: "Hours" }));
	await page.keyboard.type("1");
	await tabTo(
		page,
		budget.getByRole("checkbox", { name: "Warn people tracking time once it is over" }),
	);
	await page.keyboard.press("Space");
	await tabTo(page, budget.getByRole("button", { name: "Save budget" }));
	await page.keyboard.press("Enter");
	await expect(budget).toBeHidden();
	await expect(page.getByRole("status")).toHaveText("Budget saved.");
	await expect(settings).toContainText("Total hours · Alert at 80% · Warns when over");

	// Two hours to Research, chosen with the task picker.
	await openShell(page, organisationPath(slug));
	await tabTo(
		page,
		page.getByRole("main").getByRole("button", { name: "Track time", exact: true }),
	);
	await page.keyboard.press("Enter");
	const sheet = trackSheet(page);
	await expect(sheet).toBeVisible();
	const task = sheet.getByRole("button", { name: /Task$/ });
	await expect(task).toContainText("General");
	await choose(page, task, "Task", "Research");
	await expect(task).toContainText("Research");
	await expect(sheet.getByText("Billable", { exact: true })).toBeVisible();
	await tabTo(page, sheet.getByRole("textbox", { name: "Hours" }));
	await page.keyboard.type("2");
	// Past the alert at 80%: the owner is sent the budget's alert, its link the project's page.
	// Read through the mailbox's lock, so no other test's message is taken for it.
	const link = await foundInMessageSentBy(
		() => page.keyboard.press("Enter"),
		/https?:\/\/\S+\/projects\/[^\s/]+/,
		"the budget alert's link",
	);
	await expect(sheet).toBeHidden();

	// The project's page: two hours, £240, and the budget an hour over.
	const id = await projectIdOf(page, slug);
	expect(link).toContain(projectPath(slug, id));
	await openShell(page, projectPath(slug, id));
	const main = page.getByRole("main");
	await expect(main).toContainText("Total hours2:00");
	await expect(main).toContainText("£240.00");
	await expect(main).toContainText("2:00 spent of 1:00");
	await expect(main).toContainText("1:00 over · 200%");
	await expect(page.getByRole("meter", { name: "Budget spent" })).toHaveAttribute(
		"aria-valuetext",
		"200% spent",
	);
	await tabTo(page, tabs(page).getByRole("link", { name: "Tasks" }));
	await page.keyboard.press("Enter");
	await expect(page.getByRole("list", { name: "Tasks and their hours" })).toContainText("Research");

	// Track time warns of the budget gone over, and still tracks.
	await openShell(page, organisationPath(slug));
	await page.getByRole("main").getByRole("button", { name: "Track time", exact: true }).click();
	await expect(trackSheet(page).getByRole("note")).toHaveText(
		"This project is over budget. You can still track time to it.",
	);
});

/** The id of the project whose page is open, from its address. */
async function projectIdIn(page: Page): Promise<string> {
	const id = new URL(page.url()).pathname.split("/").at(-1);
	if (!id) throw new Error("No project in the address.");
	return id;
}

/** The id of Site, from its link on Projects. */
async function projectIdOf(page: Page, slug: string): Promise<string> {
	await openShell(page, destinationPath(slug, "projects"));
	const href = await page
		.getByRole("main")
		.getByRole("link", { name: "Site", exact: true })
		.getAttribute("href");
	const id = href?.split("/").at(-1);
	if (!id) throw new Error("Site has no link.");
	return id;
}

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

			test("Tasks and Tags, a project's page and its tabs and sheets, the default rates, and the task picker", async ({
				page,
			}) => {
				const slug = await siteWithResearch(page);

				await openShell(page, destinationPath(slug, "tasks"));
				await expectNoProblems(page, "Tasks");
				await page.getByRole("button", { name: "Create task" }).click();
				const create = page.getByRole("dialog", { name: "Create a task" });
				await expectNoProblemsInSheet(
					page,
					create,
					create.getByText("Put it on every project now"),
				);
				await page
					.getByRole("group", { name: "Tasks and tags" })
					.getByRole("link", { name: "Tags" })
					.click();
				await expect(page.getByText("No tags yet")).toBeVisible();
				await expectNoProblems(page, "Tasks");

				const id = await projectIdOf(page, slug);
				await openShell(page, projectPath(slug, id));
				await expectNoProblems(page, "Site");
				for (const tab of ["Tasks", "Team", "Settings"]) {
					await tabs(page).getByRole("link", { name: tab }).click();
					await expect(tabs(page).getByRole("link", { name: tab })).toHaveAttribute(
						"aria-current",
						"page",
					);
					await expectNoProblems(page, "Site");
				}

				await page.getByRole("button", { name: "Change billing" }).click();
				const billing = page.getByRole("dialog", { name: "Billing" });
				await expectNoProblemsInSheet(page, billing, billing.getByText("Project type").first());

				await page.getByRole("button", { name: "Change budget" }).click();
				const budget = budgetSheet(page);
				await budget.getByRole("button", { name: /Budget$/ }).click();
				await page
					.getByRole("listbox", { name: "Budget" })
					.getByRole("option", { name: "Total hours" })
					.click();
				await budget.getByRole("textbox", { name: "Hours" }).fill("1");
				await budget.getByRole("button", { name: "Save budget" }).click();
				await expect(budget).toBeHidden();
				await expect(page.getByRole("status")).toHaveText("Budget saved.");
				await page.getByRole("button", { name: "Change budget" }).click();
				await expectNoProblemsInSheet(page, budget, budget.getByText("Start again each month"));
				await tabs(page).getByRole("link", { name: "Overview" }).click();
				await expect(page.getByRole("meter", { name: "Budget spent" })).toBeVisible();
				await expectNoProblems(page, "Site");

				await openShell(page, defaultRatesPath(slug));
				await expectNoProblems(page, "Default rates");

				await openShell(page, organisationPath(slug));
				await page
					.getByRole("main")
					.getByRole("button", { name: "Track time", exact: true })
					.click();
				const sheet = trackSheet(page);
				await expect(sheet.getByRole("button", { name: /Task$/ })).toContainText("General");
				await expectNoProblemsInSheet(page, sheet, sheet.getByText("Billable", { exact: true }));
			});
		});
	}
}
