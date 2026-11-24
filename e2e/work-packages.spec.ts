import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { projectPath } from "../app/projects/projects";
import { destinationPath, organisationPath } from "../app/shell/destinations";
import { foundInMessageSentBy, newPerson, setName, signIn } from "./auth";
import {
	contrast,
	DIGIT_CHANGING,
	EMPTY_INPUT,
	OVER_SEVERAL_ELEMENTS,
	problems,
	UNDER_AN_OVERLAY,
} from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation, INVITATION_LINK, invite, openInvitations } from "./organisation";
import { createClient, createCodedProject, newBrowser } from "./projects";
import { mondayOf, pastWeekday, zoneIsTheBrowsers } from "./timesheet";

// Work packages (TS-115b, decision 73) in the browser, at 390px and 1280px
// wide, in light and in dark:
//
// 1. An owner adds, edits, closes, reopens, archives and restores a project's
//    work packages on its Work packages tab, each with its budget's progress.
// 2. Track time's picker offers "ACME-001 · Website › WP2 Build", finds a work
//    package by its code and by its name, and offers a project with open work
//    packages by them alone, never on its own.
// 3. The Week grid's rows are a project and a work package; the Day view and
//    the calendar name the work package; its budget counts the time.
// 4. An entry tracked before its project had work packages says, when it is
//    edited, that one must be chosen, and saves once one is.
// 5. An admin and the client's account manager manage work packages; a member
//    sees them and no action, as does the account manager on another client's
//    project.
//
// Every page is operated with the keyboard alone and scanned by axe, which
// finds nothing. The rules themselves, on every write path, are tested through
// the Worker (test/projects/work-packages.test.ts).
//
// Each window size and scheme has people and an organisation of its own, made
// through the pages, so nothing here changes what another test looks at, and
// the four run beside each other. With SHOT_DIR set, each page is photographed
// into it (`SHOT_DIR=… pnpm exec playwright test e2e/work-packages.spec.ts`).

const OWNER = "Ada Lovelace";
const ADMIN = "Katherine Johnson";
const MANAGER = "Grace Hopper";
const MEMBER = "Alan Turing";
const SHOT_DIR = process.env.SHOT_DIR;

const WEBSITE = "ACME-001 · Website";
const PAYROLL = "GLX-001 · Payroll";
const BUILD = `${WEBSITE} › WP2 Build`;
const MUST_CHOOSE = "Choose an open work package of this project: its time goes to one.";
/** What axe says of text that a scrolled container clips. */
const PARTLY_SCROLLED_AWAY = "elmPartiallyObscured";

/** Presses Tab until `target` has the focus: the way a person without a pointer gets there. */
async function tabTo(page: Page, target: Locator, most = 80) {
	for (let step = 0; step < most; step++) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press("Tab");
	}
	await expect(target).toBeFocused();
}

/** Opens a Select by the keyboard and chooses `option` in it. */
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

/** The id of the project whose Projects link holds `name`. */
async function projectIdOf(page: Page, slug: string, name: string): Promise<string> {
	await openShell(page, destinationPath(slug, "projects"));
	const href = await page
		.getByRole("main")
		.getByRole("link", { name: new RegExp(name) })
		.first()
		.getAttribute("href");
	const id = href?.split("/").at(-1);
	if (!id) throw new Error(`${name} has no link.`);
	return id;
}

/** The project's page, its Work packages tab reached from Overview by the keyboard. */
async function openWorkPackages(page: Page, slug: string, id: string) {
	await openShell(page, projectPath(slug, id));
	await tabTo(
		page,
		page.getByRole("group", { name: "Project pages" }).getByRole("link", { name: "Work packages" }),
	);
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(projectPath(slug, id, "work-packages"));
	await expect(
		packages(page).or(page.getByText(/^This project has no work packages\./)),
	).toBeVisible();
}

/** The list of a project's work packages. */
const packages = (page: Page) =>
	page.getByRole("list", { name: "Work packages and their budgets" });

/** Opens the Actions menu of `wp` by the keyboard and chooses `item`. */
async function act(page: Page, wp: string, item: string) {
	await tabTo(page, page.getByRole("button", { name: `Actions for ${wp}`, exact: true }));
	await page.keyboard.press("Enter");
	const menu = page.getByRole("menu");
	await expect(menu).toBeVisible();
	await menu.getByRole("menuitem", { name: item, exact: true }).press("Enter");
}

/** Says yes to the sheet that closes, reopens, archives or restores a work package. */
async function confirm(page: Page, title: string, button: string, said: string) {
	const sheet = page.getByRole("dialog", { name: title });
	await expect(sheet).toBeVisible();
	await tabTo(page, sheet.getByRole("button", { name: button }));
	await page.keyboard.press("Enter");
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("main").getByRole("status")).toHaveText(said);
}

/** Opens Track time on `day` by the keyboard and returns its sheet. */
async function openTrackTime(page: Page, slug: string, day: string): Promise<Locator> {
	await openShell(page, `${organisationPath(slug)}?day=${day}`);
	await tabTo(
		page,
		page.getByRole("main").getByRole("button", { name: "Track time", exact: true }),
	);
	await page.keyboard.press("Enter");
	const sheet = page.getByRole("dialog", { name: "Track time" });
	await expect(sheet).toBeVisible();
	return sheet;
}

/** Tracks `hours` on `day` to the option the picker finds by `typed`, by the keyboard. */
async function track(
	page: Page,
	slug: string,
	day: string,
	typed: string,
	chosen: string,
	hours: string,
) {
	const sheet = await openTrackTime(page, slug, day);
	const picker = sheet.getByRole("combobox", { name: "Project" });
	await tabTo(page, picker);
	await page.keyboard.press("ControlOrMeta+A");
	await page.keyboard.type(typed);
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");
	await expect(picker).toHaveValue(chosen);
	await tabTo(page, sheet.getByRole("textbox", { name: "Hours" }));
	await page.keyboard.type(hours);
	await page.keyboard.press("Enter");
	await expect(sheet).toBeHidden();
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const scheme of ["light", "dark"] as const) {
		test.describe(`${viewport.width}px wide, ${scheme}`, () => {
			test.describe.configure({ mode: "serial", timeout: 120_000 });
			test.use({ viewport, chosenScheme: scheme });

			const run = randomUUID();
			const session = (who: string) => join(tmpdir(), `timesifier-wp-${run}-${who}.json`);
			let slug = "";
			let website = "";
			let payroll = "";
			/** The weekday that has passed on which time is tracked. */
			let day = "";

			/** Photographs the page as `what`, `subject` in view, when SHOT_DIR asks for it. */
			async function shoot(page: Page, what: string, subject?: Locator) {
				if (!SHOT_DIR) return;
				await subject?.evaluate((element) => element.scrollIntoView({ block: "center" }));
				mkdirSync(SHOT_DIR, { recursive: true });
				await page.screenshot({
					path: join(SHOT_DIR, `${what}-${viewport.width}-${scheme}.png`),
				});
			}

			/**
			 * Scans the page with axe, which finds nothing. With a sheet open, text
			 * whose lines lie over several elements is out of axe's reach, so each
			 * piece of the sheet's text is measured here instead.
			 */
			async function expectNoProblems(page: Page, state: string, unmeasurable: string[] = []) {
				const dialog = page.getByRole("dialog");
				const sheetOpen = (await dialog.count()) > 0;
				expect(
					await problems(page, sheetOpen ? [...unmeasurable, OVER_SEVERAL_ELEMENTS] : unmeasurable),
					`problems ${state}`,
				).toEqual([]);
				if (!sheetOpen) return;
				const texts = dialog.locator("p, label span, legend, h2").filter({ hasText: /\S/ });
				for (const text of await texts.all()) {
					if (!(await text.isVisible())) continue;
					expect(
						await contrast(text),
						`contrast of "${await text.textContent()}" ${state}`,
					).toBeGreaterThanOrEqual(4.5);
				}
			}

			/**
			 * Scans a page whose `table` scrolls, as the Week grid and the calendar
			 * do at 390px. axe cannot measure what the scroll hides, so the page is
			 * scanned with the table scrolled to each corner.
			 */
			async function expectNoProblemsScrolled(
				page: Page,
				table: Locator,
				state: string,
				unmeasurable: string[],
			) {
				const scroller = table.locator("..");
				for (const corner of [0, 1]) {
					await scroller.evaluate((element, at) => {
						element.scrollLeft = at * element.scrollWidth;
						element.scrollTop = at * element.scrollHeight;
					}, corner);
					expect(
						await problems(page, [...unmeasurable, PARTLY_SCROLLED_AWAY]),
						`problems ${state}, scrolled to its ${corner ? "end" : "start"}`,
					).toEqual([]);
				}
			}

			test.beforeAll(async ({ browser, baseURL }) => {
				test.setTimeout(300_000);
				const page = await newBrowser(browser, baseURL);
				await signIn(page, newPerson().email);
				slug = (await createOrganisation(page)).slug;
				await setName(page, OWNER);
				await createClient(page, slug, "Acme", "ACME");
				await createClient(page, slug, "Globex", "GLX");
				await createCodedProject(page, slug, "Website", "ACME-001", "ACME · Acme");
				await createCodedProject(page, slug, "Payroll", "GLX-001", "GLX · Globex");
				website = await projectIdOf(page, slug, "Website");
				payroll = await projectIdOf(page, slug, "Payroll");
				// Time is tracked on a past weekday of the browser's zone, which is the person's.
				await zoneIsTheBrowsers(page, slug);
				day = await pastWeekday(page);

				const people: [string, string, "Admin" | "Member"][] = [
					["admin", ADMIN, "Admin"],
					["manager", MANAGER, "Member"],
					["member", MEMBER, "Member"],
				];
				for (const [who, name, role] of people) {
					await openInvitations(page, slug);
					const email = newPerson().email;
					const invitation = await foundInMessageSentBy(
						() => invite(page, email, role),
						INVITATION_LINK,
						"the invitation's link",
					);
					const theirs = await newBrowser(browser, baseURL);
					await signIn(theirs, email, `/sign-in?next=${encodeURIComponent(invitation)}`);
					await expect(theirs).toHaveURL(invitation);
					await theirs.getByRole("button", { name: "Join" }).click();
					await expect(theirs.getByRole("heading", { level: 1, name: "Timesheet" })).toBeVisible();
					await setName(theirs, name);
					await theirs.context().storageState({ path: session(who) });
					await theirs.context().close();
				}

				// Grace Hopper manages Acme's account: she manages Website's work packages, not Payroll's.
				await openShell(page, destinationPath(slug, "clients"));
				await tabTo(page, page.getByRole("button", { name: "ACME · Acme" }));
				await page.keyboard.press("Enter");
				const client = page.getByRole("dialog", { name: "Rename Acme" });
				await tabTo(page, client.getByRole("button", { name: "Change account managers" }));
				await page.keyboard.press("Enter");
				const managers = page.getByRole("dialog", { name: "Account managers of Acme" });
				const manager = managers.getByRole("checkbox", { name: MANAGER });
				await tabTo(page, manager);
				await page.keyboard.press("Space");
				await expect(manager).toBeChecked();
				await tabTo(page, managers.getByRole("button", { name: "Save" }));
				await page.keyboard.press("Enter");
				await expect(managers).toBeHidden();
				await expect(page.getByText("Acme has 1 account manager.")).toBeVisible();

				await page.context().storageState({ path: session("owner") });
				await page.context().close();
			});

			test.describe("as the owner", () => {
				test.use({ storageState: session("owner") });

				test("1. adds, edits, closes, reopens, archives and restores work packages on the project's tab, by keyboard, with budget progress", async ({
					page,
				}) => {
					await openWorkPackages(page, slug, website);
					const main = page.getByRole("main");
					await expect(main).toContainText("This project has no work packages.");
					await expectNoProblems(page, "on an empty Work packages tab");
					await shoot(page, "1-tab-empty");

					// Two work packages, each with a budget in hours.
					for (const [code, name, hours] of [
						["WP1", "Discovery", "10"],
						["WP2", "Build", "40"],
					] as const) {
						await tabTo(page, page.getByRole("button", { name: "Add a work package" }));
						await page.keyboard.press("Enter");
						const sheet = page.getByRole("dialog", { name: "Add a work package" });
						await expect(sheet).toBeVisible();
						const codeField = sheet.getByRole("textbox", { name: "Code" });
						await expect(codeField).toHaveAccessibleDescription(
							"Unique in this project, for example WP2.",
						);
						await tabTo(page, codeField);
						await page.keyboard.type(code);
						await page.keyboard.press("Tab");
						await expect(sheet.getByRole("textbox", { name: "Name" })).toBeFocused();
						await page.keyboard.type(name);
						await choose(page, sheet.getByRole("button", { name: /Budget/ }), "Budget", "Hours");
						const budget = sheet.getByRole("textbox", { name: "Budget, hours" });
						await tabTo(page, budget);
						await page.keyboard.type(hours);
						await expect(sheet.getByRole("checkbox", { name: /^Billable/ })).toBeChecked();
						if (code === "WP2") {
							await expectNoProblems(page, "in Add a work package", [UNDER_AN_OVERLAY]);
							await shoot(page, "1-add-sheet");
						}
						await tabTo(page, sheet.getByRole("button", { name: "Add work package" }));
						await page.keyboard.press("Enter");
						await expect(sheet).toBeHidden();
						await expect(main.getByRole("status")).toHaveText(`${code} ${name} added.`);
					}
					await expect(packages(page).getByRole("listitem")).toHaveCount(2);
					await expect(page.getByRole("meter", { name: "Budget of WP2 Build" })).toHaveAttribute(
						"aria-valuetext",
						"0% spent",
					);
					await expect(packages(page)).toContainText("0:00 of 40:00 · 40:00 left");
					await expect(main).toContainText(
						"While this project has an open work package, every new or changed entry names one of them.",
					);

					// Edit: WP1's budget becomes 12 hours.
					await act(page, "WP1 Discovery", "Edit");
					const edit = page.getByRole("dialog", { name: "Edit WP1 Discovery" });
					await expect(edit).toBeVisible();
					const budget = edit.getByRole("textbox", { name: "Budget, hours" });
					await expect(budget).toHaveValue("10");
					await tabTo(page, budget);
					await page.keyboard.press("ControlOrMeta+A");
					await page.keyboard.type("12");
					await expectNoProblems(page, "in Edit a work package", [UNDER_AN_OVERLAY]);
					await shoot(page, "1-edit-sheet");
					await tabTo(page, edit.getByRole("button", { name: "Save work package" }));
					await page.keyboard.press("Enter");
					await expect(edit).toBeHidden();
					await expect(main.getByRole("status")).toHaveText("WP1 Discovery saved.");
					await expect(packages(page)).toContainText("0:00 of 12:00 · 12:00 left");

					// Close, then reopen.
					await act(page, "WP1 Discovery", "Close");
					await expectNoProblems(page, "in Close a work package", [UNDER_AN_OVERLAY]);
					await shoot(page, "1-close-sheet");
					await confirm(
						page,
						"Close WP1 Discovery?",
						"Close work package",
						"Closed. It takes no new time; what it has stays.",
					);
					await expect(packages(page)).toContainText("WP1 Discovery (closed)");
					await expect(packages(page)).toContainText("Takes no new time");
					await expectNoProblems(page, "with a closed work package");
					await shoot(page, "1-tab-closed", packages(page).getByRole("listitem").last());
					await act(page, "WP1 Discovery", "Reopen");
					await confirm(
						page,
						"Reopen WP1 Discovery?",
						"Reopen work package",
						"Reopened. It takes time again.",
					);
					await expect(packages(page)).not.toContainText("(closed)");

					// Archive, then restore.
					await act(page, "WP1 Discovery", "Archive");
					await confirm(
						page,
						"Archive WP1 Discovery?",
						"Archive work package",
						"Archived. Its entries keep it.",
					);
					await expect(packages(page).getByRole("listitem").last()).toContainText(
						"WP1 Discovery (archived)",
					);
					await expectNoProblems(page, "with an archived work package");
					await shoot(page, "1-tab-archived", packages(page).getByRole("listitem").last());
					await act(page, "WP1 Discovery", "Restore");
					await confirm(page, "Restore WP1 Discovery?", "Restore work package", "Restored.");
					await expect(packages(page)).not.toContainText("(archived)");
					await expect(packages(page).getByRole("listitem").first()).toContainText("WP1 Discovery");
				});

				test("2. Track time's picker offers 'ACME-001 · Website › WP2 Build', finds it by its code and by its name, and offers Website by its work packages alone", async ({
					page,
				}) => {
					const sheet = await openTrackTime(page, slug, day);
					const picker = sheet.getByRole("combobox", { name: "Project" });
					await tabTo(page, picker);
					await page.keyboard.press("ControlOrMeta+A");
					await page.keyboard.press("Delete");
					await page.keyboard.press("ArrowDown");
					const list = page.getByRole("listbox");
					await expect(list).toBeVisible();
					const acme = list.getByRole("group", { name: "ACME · Acme", exact: true });
					await expect(acme.getByRole("option")).toHaveCount(2);
					await expect(acme.getByRole("option").nth(0)).toHaveAccessibleName(
						`${WEBSITE} › WP1 Discovery ACME · Acme`,
					);
					await expect(acme.getByRole("option").nth(1)).toHaveAccessibleName(
						`${BUILD} ACME · Acme`,
					);
					// Website is not offered on its own: its time goes to one of its work packages.
					await expect(
						list.getByRole("option", { name: `${WEBSITE} ACME · Acme`, exact: true }),
					).toHaveCount(0);
					// Payroll has none, so it is offered as before.
					await expect(
						list.getByRole("option", { name: `${PAYROLL} GLX · Globex`, exact: true }),
					).toHaveCount(1);
					await expectNoProblems(page, "with the picker open", [EMPTY_INPUT, UNDER_AN_OVERLAY]);
					await shoot(page, "2-picker");

					// By its code, in any case.
					await page.keyboard.type("wp2");
					await expect(list.getByRole("option")).toHaveCount(1);
					await expect(list.getByRole("option")).toHaveAccessibleName(`${BUILD} ACME · Acme`);
					await shoot(page, "2-picker-by-code");
					// By its name.
					await page.keyboard.press("ControlOrMeta+A");
					await page.keyboard.type("Build");
					await expect(list.getByRole("option")).toHaveCount(1);
					await expect(list.getByRole("option")).toHaveAccessibleName(`${BUILD} ACME · Acme`);
					await expectNoProblems(page, "with the picker searched", [EMPTY_INPUT, UNDER_AN_OVERLAY]);
					await shoot(page, "2-picker-by-name");

					// Chosen with the keyboard, the field names the project and its work package.
					await page.keyboard.press("ArrowDown");
					await page.keyboard.press("Enter");
					await expect(list).toBeHidden();
					await expect(picker).toHaveValue(BUILD);
					await tabTo(page, sheet.getByRole("textbox", { name: "Hours" }));
					await page.keyboard.type("2");
					await expectNoProblems(page, "in Track time", [EMPTY_INPUT, UNDER_AN_OVERLAY]);
					await shoot(page, "2-track-time");
					await page.keyboard.press("Enter");
					await expect(sheet).toBeHidden();
					await expect(
						page.getByRole("main").getByRole("status").filter({ hasText: "Entry saved." }),
					).toBeVisible();
				});

				test("3. the Day view, the Week grid's rows and the calendar name the work package, and its budget counts the time", async ({
					page,
				}) => {
					const main = page.getByRole("main");
					await openShell(page, `${organisationPath(slug)}?day=${day}`);
					await expect(main.getByRole("list", { name: "Entries" })).toContainText(BUILD);
					await expect(main.getByRole("list", { name: "Entries" })).toContainText("2:00");
					await expectNoProblems(page, "on the Day view");
					await shoot(page, "3-day", main.getByRole("list", { name: "Entries" }));

					await openShell(page, `${organisationPath(slug)}?view=week&start=${mondayOf(day)}`);
					const grid = main.getByRole("table");
					await expect(grid.getByRole("rowheader", { name: BUILD, exact: true })).toBeVisible();
					const row = grid.getByRole("row").filter({
						has: page.getByRole("rowheader", { name: BUILD, exact: true }),
					});
					await expect(row).toContainText("2:00");
					await shoot(page, "3-week", grid);
					await expectNoProblemsScrolled(page, grid, "on the Week view", [EMPTY_INPUT]);

					await openShell(page, `${organisationPath(slug)}?view=calendar&date=${day}`);
					const calendar = page.getByRole("table", { name: /^Week calendar, / });
					await expect(
						calendar.getByRole("button", { name: `${BUILD}, 09:00–11:00, 2:00, edit` }),
					).toBeVisible();
					// From its start, so an early day is not scrolled under the column of hours.
					await calendar.locator("..").evaluate((element) => {
						element.scrollLeft = 0;
					});
					await shoot(
						page,
						"3-calendar",
						calendar.getByRole("button", { name: `${BUILD}, 09:00–11:00, 2:00, edit` }),
					);
					await expectNoProblemsScrolled(page, calendar, "on the calendar", [
						EMPTY_INPUT,
						DIGIT_CHANGING,
					]);

					await openWorkPackages(page, slug, website);
					await expect(page.getByRole("meter", { name: "Budget of WP2 Build" })).toHaveAttribute(
						"aria-valuetext",
						"5% spent",
					);
					await expect(packages(page)).toContainText("2:00 of 40:00 · 38:00 left");
					await expectNoProblems(page, "on the Work packages tab with time");
					await shoot(page, "3-tab-budget-progress", packages(page).getByRole("listitem").last());
				});

				test("4. an entry from before its project had work packages says one must be chosen when edited, and saves once one is", async ({
					page,
				}) => {
					// An hour on Payroll while it has no work package, then one added.
					await track(page, slug, day, "payroll", PAYROLL, "1");
					await openWorkPackages(page, slug, payroll);
					await tabTo(page, page.getByRole("button", { name: "Add a work package" }));
					await page.keyboard.press("Enter");
					const add = page.getByRole("dialog", { name: "Add a work package" });
					await tabTo(page, add.getByRole("textbox", { name: "Code" }));
					await page.keyboard.type("WP1");
					await page.keyboard.press("Tab");
					await page.keyboard.type("Run");
					await tabTo(page, add.getByRole("button", { name: "Add work package" }));
					await page.keyboard.press("Enter");
					await expect(add).toBeHidden();

					const main = page.getByRole("main");
					await openShell(page, `${organisationPath(slug)}?day=${day}`);
					const entries = main.getByRole("list", { name: "Entries" });
					await expect(entries).toContainText(PAYROLL);
					await tabTo(
						page,
						main.getByRole("button", { name: new RegExp(`^Actions for ${PAYROLL}`) }),
					);
					await page.keyboard.press("Enter");
					await page.getByRole("menuitem", { name: "Edit entry" }).press("Enter");
					const editing = page.getByRole("dialog", { name: "Edit entry" });
					await expect(editing).toBeVisible();
					await expect(editing).toContainText(MUST_CHOOSE);
					const picker = editing.getByRole("combobox", { name: "Project" });
					await expect(picker).toHaveAccessibleDescription(
						`${PAYROLL} has work packages. ${MUST_CHOOSE}`,
					);
					await expectNoProblems(page, "in Edit entry with no work package", [
						EMPTY_INPUT,
						UNDER_AN_OVERLAY,
					]);
					await shoot(page, "4-edit-old-entry");

					// Saved as it is, the sheet stays and says so again.
					await tabTo(page, editing.getByRole("button", { name: "Save" }));
					await page.keyboard.press("Enter");
					await expect(editing).toBeVisible();
					await expect(editing).toContainText(MUST_CHOOSE);

					await tabTo(page, picker);
					await page.keyboard.press("ControlOrMeta+A");
					await page.keyboard.type("run");
					await page.keyboard.press("ArrowDown");
					await page.keyboard.press("Enter");
					await expect(picker).toHaveValue(`${PAYROLL} › WP1 Run`);
					// The field is checked again as the focus leaves it, as every field is.
					await page.keyboard.press("Tab");
					await expect(picker).not.toHaveAttribute("aria-invalid", "true");
					await expect(editing).not.toContainText(MUST_CHOOSE);
					await shoot(page, "4-edit-old-entry-chosen");
					await tabTo(page, editing.getByRole("button", { name: "Save" }));
					await page.keyboard.press("Enter");
					await expect(editing).toBeHidden();
					await expect(main.getByRole("status").filter({ hasText: "Entry saved." })).toBeVisible();
					await expect(entries).toContainText(`${PAYROLL} › WP1 Run`);
				});
			});

			test.describe("as an admin", () => {
				test.use({ storageState: session("admin") });

				test("5. an admin adds a work package by keyboard", async ({ page }) => {
					await openWorkPackages(page, slug, website);
					await tabTo(page, page.getByRole("button", { name: "Add a work package" }));
					await page.keyboard.press("Enter");
					const sheet = page.getByRole("dialog", { name: "Add a work package" });
					await tabTo(page, sheet.getByRole("textbox", { name: "Code" }));
					await page.keyboard.type("WP3");
					await page.keyboard.press("Tab");
					await page.keyboard.type("Launch");
					await tabTo(page, sheet.getByRole("button", { name: "Add work package" }));
					await page.keyboard.press("Enter");
					await expect(sheet).toBeHidden();
					await expect(page.getByRole("main").getByRole("status")).toHaveText("WP3 Launch added.");
					await expect(packages(page)).toContainText("WP3 Launch");
					await expect(
						page.getByRole("button", { name: "Actions for WP3 Launch", exact: true }),
					).toBeVisible();
					await expectNoProblems(page, "on the Work packages tab as an admin");
					await shoot(page, "5-admin");
				});
			});

			test.describe("as the client's account manager", () => {
				test.use({ storageState: session("manager") });

				test("5. the account manager edits a work package of their client's project, and manages none of another's", async ({
					page,
				}) => {
					await openWorkPackages(page, slug, website);
					await expect(page.getByRole("button", { name: "Add a work package" })).toBeVisible();
					await act(page, "WP3 Launch", "Edit");
					const edit = page.getByRole("dialog", { name: "Edit WP3 Launch" });
					const name = edit.getByRole("textbox", { name: "Name" });
					await tabTo(page, name);
					await page.keyboard.press("ControlOrMeta+A");
					await page.keyboard.type("Launch and handover");
					await tabTo(page, edit.getByRole("button", { name: "Save work package" }));
					await page.keyboard.press("Enter");
					await expect(edit).toBeHidden();
					await expect(page.getByRole("main").getByRole("status")).toHaveText(
						"WP3 Launch and handover saved.",
					);
					await expectNoProblems(page, "on the Work packages tab as an account manager");
					await shoot(page, "5-account-manager");

					// Payroll is Globex's, whose account she does not manage.
					await openWorkPackages(page, slug, payroll);
					await expect(packages(page)).toContainText("WP1 Run");
					await expect(page.getByRole("button", { name: "Add a work package" })).toHaveCount(0);
					await expect(page.getByRole("button", { name: /^Actions for / })).toHaveCount(0);
				});
			});

			test.describe("as a member", () => {
				test.use({ storageState: session("member") });

				test("5. a member sees the work packages and no action", async ({ page }) => {
					await openWorkPackages(page, slug, website);
					await expect(packages(page).getByRole("listitem")).toHaveCount(3);
					await expect(packages(page)).toContainText("WP2 Build");
					await expect(page.getByRole("button", { name: "Add a work package" })).toHaveCount(0);
					await expect(page.getByRole("button", { name: /^Actions for / })).toHaveCount(0);
					await expectNoProblems(page, "on the Work packages tab as a member");
					await shoot(page, "5-member");
				});
			});
		});
	}
}
