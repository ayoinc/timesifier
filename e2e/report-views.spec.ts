import type { Locator, Page } from "@playwright/test";

import { destinationPath, organisationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { EMPTY_INPUT, problems } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";
import { createProject, pastWeekday } from "./timesheet";

// The views of Reports beside Time and Dashboards in a browser (TS-068, TS-071,
// TS-080, TS-084, TS-086): the tabs, the shared filter bar and stepper,
// saving a report and opening it from Saved, the money panels of Dashboards
// and a project's profit, the keyboard alone, and axe at 390px and 1280px in
// both schemes. Each test is a new person, the owner of an organisation of
// their own, with two hours tracked on the latest weekday before today.

const COMPACT = { width: 390, height: 844 };
const MEDIUM = { width: 1280, height: 800 };

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

/** Signs a new owner in with a project, Site, and two hours on it on the latest weekday before today, a working day (TS-095). */
async function ownerWithTime(page: Page) {
	await signIn(page, newPerson().email);
	const organisation = await createOrganisation(page);
	await createProject(page, organisation.slug, "Site");
	const day = await pastWeekday(page);
	await openShell(page, `${organisationPath(organisation.slug)}?day=${day}`);
	await page.getByRole("button", { name: "Track time", exact: true }).click();
	const sheet = page.getByRole("dialog", { name: "Track time" });
	await sheet.getByRole("textbox", { name: "Hours" }).fill("2");
	await sheet.getByRole("button", { name: "Save entry" }).click();
	await expect(sheet).toBeHidden();
	return { reports: `${organisationPath(organisation.slug)}/reports`, organisation, day };
}

const tabs = (page: Page) => page.getByRole("group", { name: "Report views" });

/** Presses Tab until `target` has the focus: the way a person without a pointer gets there. */
async function tabTo(page: Page, target: Locator, most = 80) {
	for (let step = 0; step < most; step++) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press("Tab");
	}
	throw new Error("Tab never reached the control.");
}

/** The address of Site's own page, from its link on Projects. */
async function siteAddress(page: Page, slug: string): Promise<string> {
	await openShell(page, destinationPath(slug, "projects"));
	const href = await page
		.getByRole("main")
		.getByRole("link", { name: "Site", exact: true })
		.getAttribute("href");
	if (!href) throw new Error("Site has no link.");
	return href;
}

/** The views at their own addresses, each with what it is about. */
const VIEWS = [
	["Time", ""],
	["Utilisation", "/utilisation"],
	["Leave", "/leave"],
	["Profitability", "/profitability"],
] as const;

test("an owner moves between the views, saves a report and opens it again", async ({ page }) => {
	const { reports, day } = await ownerWithTime(page);
	const range = `?range=custom&from=${day}&to=${day}`;
	await openShell(page, `${reports}${range}`);
	await expect(page.getByText("Total: ")).toBeAttached();
	await expect(page.getByText("2:00", { exact: true }).first()).toBeVisible();

	for (const [label, path] of VIEWS) {
		await tabs(page).getByRole("link", { name: label }).click();
		await expect(page).toHaveURL(new RegExp(`/reports${path}(\\?|$)`));
		await expect(tabs(page).getByRole("link", { name: label })).toHaveAttribute(
			"aria-current",
			"page",
		);
	}

	await openShell(page, `${reports}/utilisation${range}`);
	await page.getByRole("button", { name: "Save report" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("textbox", { name: "Name" }).fill("One day's utilisation");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toBeHidden();

	await page.getByRole("link", { name: "Saved reports" }).click();
	await page.getByRole("link", { name: "One day's utilisation" }).click();
	await expect(page).toHaveURL(/\/reports\/utilisation\?/);
	await expect(page.getByText("Utilisation: ")).toBeAttached();
});

test("with the keyboard alone: the tabs, then a range field, apply", async ({ page }) => {
	const { reports } = await ownerWithTime(page);
	await openShell(page, `${reports}?range=this-week`);
	const utilisation = tabs(page).getByRole("link", { name: "Utilisation" });
	for (let step = 0; step < 80; step++) {
		if (await utilisation.evaluate((element) => element === document.activeElement)) break;
		await page.keyboard.press("Tab");
	}
	await expect(utilisation).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/reports\/utilisation\?/);
	await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
});

test("an owner reads the money panels of Dashboards and a project's profit, and reaches each report with the keyboard alone", async ({
	page,
}) => {
	const { organisation, day } = await ownerWithTime(page);
	const dashboards = `${organisationPath(organisation.slug)}/dashboards?range=this-week`;
	const main = page.getByRole("main");

	// Nothing is invoiced yet: each panel says so and carries its way on.
	await openShell(page, dashboards);
	await expect(main).toContainText("Nothing billable is waiting to be invoiced.");
	await expect(main).toContainText("Nothing is owed: every issued invoice is paid.");
	await expect(main.getByRole("link", { name: "Create an invoice" })).toBeVisible();
	await tabTo(page, main.getByRole("link", { name: "Open uninvoiced" }));
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/invoices\/uninvoiced$/);
	await expect(page.getByRole("heading", { level: 1, name: "Uninvoiced" })).toBeVisible();

	await openShell(page, dashboards);
	await tabTo(page, main.getByRole("link", { name: "Open receivables" }));
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/invoices\/reports\?report=receivables$/);
	await expect(page.getByRole("heading", { level: 1, name: "Invoice reports" })).toBeVisible();

	// The project's profit over that day is its row of the Profitability report.
	const site = await siteAddress(page, organisation.slug);
	await openShell(page, `${site}?range=custom&from=${day}&to=${day}`);
	const profit = page.getByRole("region", { name: "Profit" });
	await expect(profit.getByRole("group", { name: "Profit range" })).toBeVisible();
	await expect(profit.getByRole("list", { name: "Profit over the range" })).toContainText(
		"Revenue",
	);
	const totalLine = profit.locator("p", { has: page.getByText("Profit", { exact: true }) });
	const total = ((await totalLine.textContent()) ?? "").replace("Profit", "").trim();
	expect(total).not.toBe("");
	await tabTo(page, profit.getByRole("link", { name: "Open profitability" }));
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(
		new RegExp(`/reports/profitability\\?range=custom&from=${day}&to=${day}&group=project$`),
	);
	const row = page.getByRole("list", { name: "Profit by project" }).getByRole("listitem");
	await expect(row.filter({ hasText: "Site" })).toContainText(total);
});

for (const viewport of [COMPACT, MEDIUM]) {
	for (const scheme of ["light", "dark"] as const) {
		test.describe(`at ${viewport.width}px in the ${scheme} scheme`, () => {
			test.use({ viewport, chosenScheme: scheme });

			test("axe finds nothing on any view, Dashboards or a project's Overview; nothing overflows the window", async ({
				page,
			}) => {
				const { reports, organisation } = await ownerWithTime(page);
				const overflows = () =>
					page.evaluate(
						() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
					);
				const pages = [
					...VIEWS.map(([, path]) => `${reports}${path}?range=this-week`),
					`${reports}/saved`,
					`${organisationPath(organisation.slug)}/dashboards?range=this-week`,
					`${await siteAddress(page, organisation.slug)}?range=this-week`,
				];
				for (const address of pages) {
					await openShell(page, address);
					await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
					expect(await overflows(), address).toBe(false);
					expect(await problems(page, [EMPTY_INPUT]), address).toEqual([]);
				}
			});
		});
	}
}
