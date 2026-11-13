import type { Locator, Page } from "@playwright/test";

import { destinationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { contrast, EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";

// Projects, Clients and Workspace settings, General (TS-011a, TS-011b,
// TS-048), in a browser: no WCAG 2.2 A or AA violation on each page, empty and
// filled, at both window sizes and in both schemes; and the work of each with
// the keyboard alone. Each test signs in a new person who makes an
// organisation of their own, so what it adds is seen by no other test.

test.use({ storageState: SIGNED_OUT });
// Each test asks for a sign-in code, and may stand behind the other tests asking for theirs.
test.describe.configure({ timeout: TIME_WITH_TURNS });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

/** Signs a new person in and makes them the owner of a new organisation. Its slug. */
async function ownNewOrganisation(page: Page): Promise<string> {
	await signIn(page, newPerson().email);
	return (await createOrganisation(page)).slug;
}

/** `unmeasurable`: what axe may leave unmeasured, such as a filled list's empty search field. */
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

/** Creates a record through the page's sheet: "project" or "client". */
async function createThrough(page: Page, kind: "project" | "client", name: string) {
	await page.getByRole("button", { name: `Create ${kind}` }).click();
	const sheet = page.getByRole("dialog", { name: `Create a ${kind}` });
	await sheet.getByLabel(kind === "project" ? "Project name" : "Client name").fill(name);
	await sheet.getByRole("button", { name: `Create the ${kind}` }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("status")).toContainText(name);
}

/** The element holds the keyboard focus and shows it. */
async function expectFocusShown(element: Locator) {
	await expect(element).toBeFocused();
	const outline = await element.evaluate((focused) => {
		const { outlineStyle, outlineWidth } = getComputedStyle(focused);
		return { outlineStyle, width: Number.parseFloat(outlineWidth) };
	});
	expect(outline.outlineStyle).toBe("solid");
	expect(outline.width).toBeGreaterThan(0);
}

async function tabTo(page: Page, element: Locator) {
	await page.keyboard.press("Tab");
	await expectFocusShown(element);
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });

			test("Projects, empty and filled, its tabs and its sheets", async ({ page }) => {
				const slug = await ownNewOrganisation(page);
				await openShell(page, destinationPath(slug, "projects"));
				await expect(
					page.getByRole("heading", { level: 2, name: "No projects yet" }),
				).toBeVisible();
				await expectNoProblems(page, "Projects");

				await createThrough(page, "project", "Design");
				await expectNoProblems(page, "Projects", [EMPTY_INPUT]);

				await page.getByRole("button", { name: "Create project" }).click();
				const creating = page.getByRole("dialog", { name: "Create a project" });
				await expectNoProblemsInSheet(
					page,
					creating,
					creating.getByText("Everyone in", { exact: false }),
				);

				// The row's Edit opens its sheet, which holds Archive (TS-091, W24); its
				// name opens the project's own page (TS-066). The check of the sheet
				// closes it, so Edit opens it again.
				const row = page.getByRole("button", { name: "Edit Design", exact: true });
				await row.click();
				const editing = page.getByRole("dialog", { name: "Edit Design" });
				await expectNoProblemsInSheet(page, editing, editing.getByText("Done with it?"));
				await row.click();
				await editing.getByRole("button", { name: "Archive project" }).click();
				const archiving = page.getByRole("dialog", { name: "Archive Design?" });
				await archiving.getByRole("button", { name: "Archive project" }).click();
				await expect(archiving).toBeHidden();
				await page.getByRole("tab", { name: "Archived" }).click();
				await expect(page).toHaveURL(/\?show=archived$/);
				await expect(page.getByRole("list", { name: "Archived projects" })).toContainText("Design");
				await expectNoProblems(page, "Projects", [EMPTY_INPUT]);
			});

			test("Clients and Workspace settings, with their sheets", async ({ page }) => {
				const slug = await ownNewOrganisation(page);
				await openShell(page, destinationPath(slug, "clients"));
				await expect(page.getByRole("heading", { level: 2, name: "No clients yet" })).toBeVisible();
				await expectNoProblems(page, "Clients");
				await createThrough(page, "client", "Globex");
				await expectNoProblems(page, "Clients", [EMPTY_INPUT]);

				await openShell(page, destinationPath(slug, "settings"));
				await expectNoProblems(page, "Workspace settings");
				await page.getByRole("button", { name: "Change the default time zone" }).click();
				const zone = page.getByRole("dialog", { name: "Change the default time zone" });
				await expectNoProblemsInSheet(page, zone, zone.getByText("Everyone who has not chosen"));
				await page.getByRole("button", { name: "Change the day weeks start on" }).click();
				const week = page.getByRole("dialog", { name: "Change the day weeks start on" });
				await expectNoProblemsInSheet(page, week, week.getByText("Every timesheet week"));
			});
		});
	}
}

test("a project is created, renamed and archived with the keyboard alone", async ({ page }) => {
	const slug = await ownNewOrganisation(page);
	await openShell(page, destinationPath(slug, "projects"));
	const heading = page.getByRole("heading", { level: 1, name: "Projects" });

	// Create: the one button of the empty page opens the sheet with the focus in its field.
	const create = page.getByRole("button", { name: "Create project" });
	await create.focus();
	await expectFocusShown(create);
	await page.keyboard.press("Enter");
	const creating = page.getByRole("dialog", { name: "Create a project" });
	await expect(creating.getByLabel("Project name")).toBeFocused();
	await page.keyboard.type("Design");
	await page.keyboard.press("Enter");
	await expect(creating).toBeHidden();
	await expect(page.getByRole("status")).toHaveText("Project created: Design.");

	// Rename: the row's Edit is a button in the tab order that opens its sheet
	// (TS-091, W24); the project's name, before it, is the link to its own page (TS-066).
	await expect(
		page.getByRole("main").getByRole("link", { name: "Design", exact: true }),
	).toHaveAttribute("href", /\/projects\/[^/]+$/);
	const row = page.getByRole("button", { name: "Edit Design", exact: true });
	await heading.focus();
	while (!(await row.evaluate((element) => element === document.activeElement))) {
		await page.keyboard.press("Tab");
	}
	await expectFocusShown(row);
	await expect(page.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
	await page.keyboard.press("Enter");
	const renaming = page.getByRole("dialog", { name: "Edit Design" });
	const name = renaming.getByLabel("Project name");
	await expect(name).toBeFocused();
	await page.keyboard.press("ControlOrMeta+a");
	await page.keyboard.type("Design system");
	await page.keyboard.press("Enter");
	await expect(renaming).toBeHidden();
	await expect(page.getByRole("status")).toHaveText("Project saved: Design system.");

	// Archive: from the same sheet, then the confirming sheet's own button.
	const renamed = page.getByRole("button", { name: "Edit Design system", exact: true });
	await renamed.focus();
	await expectFocusShown(renamed);
	await page.keyboard.press("Enter");
	const editing = page.getByRole("dialog", { name: "Edit Design system" });
	const archive = editing.getByRole("button", { name: "Archive project" });
	while (!(await archive.evaluate((element) => element === document.activeElement))) {
		await page.keyboard.press("Tab");
	}
	await expectFocusShown(archive);
	await page.keyboard.press("Enter");
	const archiving = page.getByRole("dialog", { name: "Archive Design system?" });
	await expect(archiving).toBeVisible();
	await tabTo(page, archiving.getByRole("button", { name: "Cancel" }));
	await tabTo(page, archiving.getByRole("button", { name: "Archive project" }));
	await page.keyboard.press("Enter");
	await expect(archiving).toBeHidden();
	await expect(page.getByRole("status")).toContainText("Design system is archived.");

	// The Archived tab, by the arrow keys in the tab list.
	const activeTab = page.getByRole("tab", { name: "Active" });
	await activeTab.focus();
	await page.keyboard.press("ArrowRight");
	await expect(page.getByRole("tab", { name: "Archived" })).toBeFocused();
	await expect(page.getByRole("list", { name: "Archived projects" })).toContainText(
		"Design system",
	);
});

test("Clients turned off with the keyboard leaves the navigation, and its page is 404", async ({
	page,
}) => {
	const slug = await ownNewOrganisation(page);
	await openShell(page, destinationPath(slug, "settings"));
	const navigation = page.getByRole("navigation").first();
	await expect(navigation.getByRole("link", { name: "Clients" })).toBeVisible();

	const clients = page.getByRole("switch", { name: "Clients" });
	await expect(clients).toBeChecked();
	await clients.focus();
	await page.keyboard.press("Space");
	await expect(page.getByRole("status")).toContainText("Clients is off.");
	await expect(clients).not.toBeChecked();
	await expect(navigation.getByRole("link", { name: "Clients" })).toHaveCount(0);

	const response = await page.request.get(destinationPath(slug, "clients"));
	expect(response.status()).toBe(404);

	await page.keyboard.press("Space");
	await expect(page.getByRole("status")).toContainText("Clients is on.");
	await expect(navigation.getByRole("link", { name: "Clients" })).toBeVisible();
});
