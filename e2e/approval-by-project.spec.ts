import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { projectPath } from "../app/projects/projects";
import { destinationPath, organisationPath } from "../app/shell/destinations";
import { foundInMessageSentBy, newPerson, setName, signIn } from "./auth";
import { contrast, EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import {
	createOrganisation,
	expectRefusal,
	INVITATION_LINK,
	invite,
	openInvitations,
} from "./organisation";
import { createClient, createCodedProject, newBrowser } from "./projects";
import { mondayOf, pastWeekday, zoneIsTheBrowsers } from "./timesheet";

// Approval by project (TS-117, decision 79) in the browser, at 390px and
// 1280px wide, in light and in dark. Each window size and scheme has an
// organisation of its own, made through the pages: its owner, a delivery
// manager to be, and a member who tracks time to two client projects.
//
// 1. With no delivery manager anywhere, the member submits a week and the
//    owner finds Approvals exactly as before: no tabs, the week whole, no
//    parts, approved whole.
// 2. The owner makes Grace Hopper the delivery manager of both projects.
// 3. The member submits the next week, which is held in parts: their
//    timesheet lists each part as waiting.
// 4. The owner sees both tabs. People shows the week's project parts as
//    waiting, and the owner approves the rest of the week, its line part;
//    Projects shows each project's people and their hours on each day.
// 5. The delivery manager approves her part on one project and returns the
//    other with a reason. The week is not approved.
// 6. The member reads which part came back and why, cannot change the
//    approved part, corrects the returned one and submits again; the week
//    cannot be withdrawn with a part approved.
// 7. The delivery manager approves the part that came back, and only then
//    does the member's week show as approved.
//
// Every step is taken with the keyboard, and every page is scanned by axe,
// which finds nothing. The rules themselves are tested through the Worker
// (test/approvals/approval-by-project.test.ts). With SHOT_DIR set, each page
// is photographed into it.

const OWNER = "Ada Lovelace";
const LEAD = "Grace Hopper";
const MEMBER = "Alan Turing";
const SHOT_DIR = process.env.SHOT_DIR;
const WEBSITE = "Website";
const BRAND = "Brand";
const REASON = "The brand hours were on the website.";
// The pages' own words (app/time/manual.server.ts, app/approvals/parts.ts).
const LOCKED = "That day is locked";
const WAITING = "Waiting for approval";
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

/** Opens a Select by the keyboard and chooses `option` in it, by the arrow keys. */
async function choose(page: Page, select: Locator, list: string, option: string | RegExp) {
	await tabTo(page, select);
	await page.keyboard.press("Enter");
	const listbox = page.getByRole("listbox", { name: list });
	await expect(listbox).toBeVisible();
	const wanted = listbox.getByRole("option", { name: option });
	for (let step = 0; step < 20; step++) {
		if (await wanted.evaluate((element) => element === document.activeElement)) break;
		await page.keyboard.press("ArrowDown");
	}
	await expect(wanted).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(listbox).toBeHidden();
}

/** A day `count` days after `day`, as an address writes it. */
function plusDays(day: string, count: number): string {
	const date = new Date(`${day}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + count);
	return date.toISOString().slice(0, 10);
}

/** A day as the page's sentences and the grid's cells say it: "Wednesday 11 November". */
function dayLabel(day: string): string {
	return new Intl.DateTimeFormat("en-GB", {
		weekday: "long",
		day: "numeric",
		month: "long",
		timeZone: "UTC",
	}).format(new Date(`${day}T00:00:00Z`));
}

/** A day as the Projects tab writes it before its hours: "Wed 11". */
function shortDay(day: string): string {
	const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(
		new Date(`${day}T00:00:00Z`),
	);
	return `${weekday} ${Number(day.slice(8, 10))}`;
}

/** Text for a regular expression that matches it exactly. */
function escaped(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The status line of the page's main column with `text` in it. */
function said(page: Page, text: string): Locator {
	return page.getByRole("main").getByRole("status").filter({ hasText: text });
}

/** Presses a sheet's primary action by the keyboard and waits for what the page says. */
async function submitSheet(page: Page, sheet: Locator, button: string, saying: string) {
	await tabTo(page, sheet.getByRole("button", { name: button, exact: true }));
	await page.keyboard.press("Enter");
	await expect(sheet).toBeHidden();
	await expect(said(page, saying)).toHaveText(saying);
}

/** The member's week on the Timesheet's grid. */
async function openWeek(page: Page, slug: string, monday: string) {
	await openShell(page, `${organisationPath(slug)}?view=week&start=${monday}`);
	await expect(page.getByRole("group", { name: "Weeks" })).toBeVisible();
}

/** The grid's cell of `project` on `day`. */
function cell(page: Page, project: string, day: string): Locator {
	return page.getByRole("textbox", {
		name: new RegExp(`${escaped(project)}, ${escaped(dayLabel(day))}(?:,|$)`),
	});
}

/** Adds a row for `project` to the open week's grid, by the keyboard. */
async function addRow(page: Page, project: string) {
	await choose(
		page,
		page.getByRole("button", { name: /Project to add/ }),
		"Project to add",
		project,
	);
	await tabTo(page, page.getByRole("button", { name: "Add row" }));
	await page.keyboard.press("Enter");
	await expect(page.getByRole("row", { name: new RegExp(escaped(project)) })).toBeVisible();
}

/** Types `hours` into a cell of the grid and leaves it, which saves it. */
async function typeHours(page: Page, field: Locator, hours: string) {
	await tabTo(page, field);
	await page.keyboard.press("ControlOrMeta+A");
	await page.keyboard.type(hours);
	await page.keyboard.press("Tab");
}

/** Submits the open week by the keyboard, through its confirmation. */
async function submitWeek(page: Page) {
	await tabTo(page, page.getByRole("button", { name: "Submit week" }));
	await page.keyboard.press("Enter");
	const dialog = page.getByRole("dialog", { name: "Submit this week?" });
	await expect(dialog).toBeVisible();
	await tabTo(page, dialog.getByRole("button", { name: "Submit week" }));
	await page.keyboard.press("Enter");
	await expect(dialog).toBeHidden();
}

/** The Timesheet's list of the parts of a week held in parts. */
const partsList = (page: Page) => page.getByRole("list", { name: "Parts of this week" });

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const scheme of ["light", "dark"] as const) {
		test.describe(`${viewport.width}px wide, ${scheme}`, () => {
			test.describe.configure({ mode: "serial", timeout: 120_000 });
			test.use({ viewport, chosenScheme: scheme });

			const run = randomUUID();
			const session = (who: string) => join(tmpdir(), `timesifier-parts-${run}-${who}.json`);
			let slug = "";
			const ids = { [WEBSITE]: "", [BRAND]: "" };
			/** A weekday that has passed, in the week held in parts. */
			let day = "";
			/** The same weekday a week before, in the week decided whole. */
			let before = "";
			let approvals = "";

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
			 * whose lines lie over several elements is out of axe's reach, and so is
			 * an empty field, so each piece of the sheet's text is measured here instead.
			 */
			async function expectNoProblems(page: Page, state: string, unmeasurable: string[] = []) {
				const dialog = page.getByRole("dialog");
				const sheetOpen = (await dialog.count()) > 0;
				expect(
					await problems(
						page,
						sheetOpen
							? [...unmeasurable, UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS, EMPTY_INPUT]
							: unmeasurable,
					),
					`problems ${state}`,
				).toEqual([]);
				if (!sheetOpen) return;
				const texts = dialog.locator("p, label span, h2").filter({ hasText: /\S/ });
				for (const text of await texts.all()) {
					if (!(await text.isVisible())) continue;
					expect(
						await contrast(text),
						`contrast of "${await text.textContent()}" ${state}`,
					).toBeGreaterThanOrEqual(4.5);
				}
			}

			/**
			 * Scans the Week view with axe, which finds nothing. Where the grid is
			 * wider than the window it scrolls, and axe cannot measure what the
			 * scroll hides, so it is scanned from each end, as e2e/timesheet.spec.ts
			 * does; an empty cell is a field with nothing in it yet.
			 */
			async function expectNoGridProblems(page: Page, state: string) {
				const grid = page.locator("table").locator("..");
				const scrolls = await grid.evaluate((element) => element.scrollWidth > element.clientWidth);
				if (!scrolls) {
					expect(await problems(page, [EMPTY_INPUT]), `problems ${state}`).toEqual([]);
					return;
				}
				for (const end of ["end", "start"] as const) {
					await grid.evaluate((element, to) => {
						element.scrollLeft = to === "start" ? 0 : element.scrollWidth;
					}, end);
					expect(
						await problems(page, [EMPTY_INPUT, PARTLY_SCROLLED_AWAY]),
						`problems ${state}, scrolled to the ${end}`,
					).toEqual([]);
				}
			}

			test.beforeAll(async ({ browser, baseURL }) => {
				test.setTimeout(300_000);
				const page = await newBrowser(browser, baseURL);
				await signIn(page, newPerson().email);
				({ slug } = await createOrganisation(page));
				approvals = destinationPath(slug, "approvals");
				await setName(page, OWNER);
				await createClient(page, slug, "Acme", "ACME");
				await createCodedProject(page, slug, WEBSITE, "ACME-001", "ACME · Acme");
				await createCodedProject(page, slug, BRAND, "ACME-002", "ACME · Acme");
				await openShell(page, destinationPath(slug, "projects"));
				for (const name of [WEBSITE, BRAND] as const) {
					const href = await page
						.getByRole("main")
						.getByRole("link", { name: new RegExp(name) })
						.first()
						.getAttribute("href");
					ids[name] = href?.split("/").at(-1) ?? "";
					expect(ids[name]).not.toBe("");
				}
				// Time is tracked on a weekday that has passed in the browser's zone, which is the person's.
				await zoneIsTheBrowsers(page, slug);
				day = await pastWeekday(page);
				before = plusDays(day, -7);

				for (const [who, name] of [
					["lead", LEAD],
					["member", MEMBER],
				]) {
					await openInvitations(page, slug);
					const email = newPerson().email;
					const invitation = await foundInMessageSentBy(
						() => invite(page, email, "Member"),
						INVITATION_LINK,
						"the invitation's link",
					);
					const theirs = await newBrowser(browser, baseURL);
					await signIn(theirs, email, `/sign-in?next=${encodeURIComponent(invitation)}`);
					await expect(theirs).toHaveURL(invitation);
					await theirs.getByRole("button", { name: "Join" }).click();
					await expect(theirs.getByRole("heading", { level: 1, name: "Timesheet" })).toBeVisible();
					await setName(theirs, name);
					await zoneIsTheBrowsers(theirs, slug);
					await theirs.context().storageState({ path: session(who) });
					await theirs.context().close();
				}

				await page.context().storageState({ path: session("owner") });
				await page.context().close();
			});

			test.describe("with no delivery manager, the member", () => {
				test.use({ storageState: session("member") });

				test("1. submits a week, decided whole", async ({ page }) => {
					await openWeek(page, slug, mondayOf(before));
					await addRow(page, WEBSITE);
					await typeHours(page, cell(page, WEBSITE, before), "2");
					await expect(page.getByRole("row", { name: /Website/ })).toContainText("2:00");
					await submitWeek(page);
					await expect(page.getByText("Status: Submitted")).toBeAttached();
					await expect(partsList(page)).toHaveCount(0);
					await expect(page.getByRole("main")).toContainText(
						"Submitted. Its entries are locked until it is decided.",
					);
				});
			});

			test.describe("with no delivery manager, the owner", () => {
				test.use({ storageState: session("owner") });

				test("1. sees Approvals as before, and approves the week whole", async ({ page }) => {
					await openShell(page, `${approvals}?week=${mondayOf(before)}`);
					const main = page.getByRole("main");
					await expect(main.getByRole("list", { name: "Pending, by person" })).toBeVisible();
					await expect(page.getByRole("group", { name: "Approve by" })).toHaveCount(0);
					const row = main
						.getByRole("list", { name: "Pending, by person" })
						.getByRole("listitem")
						.filter({ hasText: MEMBER });
					await expect(row).toContainText("2:00");
					await expect(row).not.toContainText("Time on");
					await expectNoProblems(page, "on Approvals with no delivery manager");
					await shoot(page, "no-delivery-managers", row);

					await tabTo(page, page.getByRole("button", { name: `Approve ${MEMBER}'s timesheet` }));
					await page.keyboard.press("Enter");
					const sheet = page.getByRole("dialog", { name: `Approve ${MEMBER}'s timesheet?` });
					await expect(sheet).toContainText(
						"Its entries stay locked. An owner or admin can reopen it if it needs changing.",
					);
					await submitSheet(page, sheet, "Approve", "Timesheet approved.");
					await expect(main).toContainText("Nothing is waiting for you this week.");
				});

				test("2. makes Grace Hopper the delivery manager of both projects", async ({ page }) => {
					for (const name of [WEBSITE, BRAND] as const) {
						await openShell(page, projectPath(slug, ids[name], "team"));
						await tabTo(page, page.getByRole("button", { name: "Assign someone" }));
						await page.keyboard.press("Enter");
						const sheet = page.getByRole("dialog", { name: "Assign someone" });
						await expect(sheet).toBeVisible();
						const picker = sheet.getByRole("combobox", { name: "Person" });
						await tabTo(page, picker);
						await page.keyboard.type(LEAD.slice(0, 3));
						const list = page.getByRole("listbox", { name: "Person" });
						await expect(list.getByRole("option", { name: LEAD, exact: true })).toBeVisible();
						await page.keyboard.press("ArrowDown");
						await page.keyboard.press("Enter");
						await expect(picker).toHaveValue(LEAD);
						await choose(
							page,
							sheet.getByRole("button", { name: /Role/ }),
							"Role",
							"Delivery manager",
						);
						const firstDay = sheet.getByRole("textbox", { name: "First day" });
						await tabTo(page, firstDay);
						await firstDay.fill(mondayOf(day));
						await submitSheet(
							page,
							sheet,
							"Assign",
							`${LEAD} leads the team from ${dayLabel(mondayOf(day))}.`,
						);
					}
				});
			});

			test.describe("the member, in parts", () => {
				test.use({ storageState: session("member") });

				test("3. submits a week with time on both projects, held in parts", async ({ page }) => {
					await openWeek(page, slug, mondayOf(day));
					await addRow(page, WEBSITE);
					await typeHours(page, cell(page, WEBSITE, day), "3");
					await addRow(page, BRAND);
					await typeHours(page, cell(page, BRAND, day), "2");
					await expect(page.getByRole("row", { name: /Brand/ })).toContainText("2:00");
					await submitWeek(page);
					await expect(page.getByText("Status: Submitted")).toBeAttached();
					await expect(partsList(page).getByRole("listitem")).toHaveText([
						`The rest of the week: ${WAITING}`,
						`Time on ${BRAND}: ${WAITING}`,
						`Time on ${WEBSITE}: ${WAITING}`,
					]);
					await expect(page.getByRole("main")).toContainText(
						"Submitted in parts, each approved by its own approver.",
					);
					await expectNoGridProblems(page, "on a week submitted in parts");
					await shoot(page, "timesheet-submitted-in-parts", partsList(page));
				});
			});

			test.describe("the owner, in parts", () => {
				test.use({ storageState: session("owner") });

				test("4. sees the parts on People, approves the rest of the week, and sees Projects", async ({
					page,
				}) => {
					await openShell(page, `${approvals}?week=${mondayOf(day)}`);
					const main = page.getByRole("main");
					const tabs = page.getByRole("group", { name: "Approve by" });
					await expect(tabs.getByRole("link")).toHaveText(["People", "Projects"]);
					await expect(tabs.getByRole("link", { name: "People" })).toHaveAttribute(
						"aria-current",
						"page",
					);
					const row = main
						.getByRole("list", { name: "Pending, by person" })
						.getByRole("listitem")
						.filter({ hasText: MEMBER });
					await expect(row).toContainText(`Time on ${BRAND}: waiting for its delivery manager`);
					await expect(row).toContainText(`Time on ${WEBSITE}: waiting for its delivery manager`);
					await expectNoProblems(page, "on People with a week in parts");
					await shoot(page, "people-tab-waiting", row);

					await tabTo(page, page.getByRole("button", { name: `Approve ${MEMBER}'s timesheet` }));
					await page.keyboard.press("Enter");
					const sheet = page.getByRole("dialog", {
						name: `Approve the rest of ${MEMBER}'s timesheet?`,
					});
					await expect(sheet).toContainText(
						"Their time on projects with a delivery manager is approved by each project's delivery managers",
					);
					await expectNoProblems(page, "in Approve the rest");
					await shoot(page, "people-tab-approve-rest");
					await submitSheet(page, sheet, "Approve", "Timesheet approved.");

					// The rest is approved; the week waits on its projects' parts.
					await openShell(page, `${approvals}?week=${mondayOf(day)}&status=approved`);
					const decided = main
						.getByRole("list", { name: "Approved, by person" })
						.getByRole("listitem")
						.filter({ hasText: MEMBER });
					await expect(decided).toContainText(`Approved by ${OWNER}`);
					await expect(decided).toContainText(`Time on ${BRAND}: waiting for its delivery manager`);
					await expect(
						page.getByRole("button", { name: `Reopen ${MEMBER}'s timesheet` }),
					).toHaveCount(0);

					// Projects, by the keyboard: each project's people and their hours on each day.
					await tabTo(page, tabs.getByRole("link", { name: "Projects" }));
					await page.keyboard.press("Enter");
					await expect(page).toHaveURL(new RegExp(`view=projects&week=${mondayOf(day)}`));
					for (const [name, hours] of [
						[WEBSITE, "3:00"],
						[BRAND, "2:00"],
					] as const) {
						const person = main
							.getByRole("list", { name: `${name}, by person` })
							.getByRole("listitem")
							.filter({ hasText: MEMBER });
						await expect(person).toContainText(`${shortDay(day)} ${hours}`);
						await expect(person).toContainText("Submitted");
						await expect(
							person.getByRole("button", { name: `Approve ${MEMBER}'s time on ${name}` }),
						).toBeVisible();
					}
					await expectNoProblems(page, "on Projects as the owner");
					await shoot(page, "projects-tab-owner");
				});
			});

			test.describe("the delivery manager", () => {
				test.use({ storageState: session("lead") });

				test("5. approves her part on one project and returns the other with a reason", async ({
					page,
				}) => {
					await openShell(page, `${approvals}?view=projects&week=${mondayOf(day)}`);
					const main = page.getByRole("main");
					// A delivery manager alone is shown Projects alone, with no tabs.
					await expect(page.getByRole("group", { name: "Approve by" })).toHaveCount(0);
					await expect(main.getByRole("list", { name: `${WEBSITE}, by person` })).toContainText(
						`${shortDay(day)} 3:00`,
					);
					await expectNoProblems(page, "on Projects as a delivery manager");
					await shoot(page, "projects-tab-lead");

					await tabTo(
						page,
						page.getByRole("button", { name: `Approve ${MEMBER}'s time on ${WEBSITE}` }),
					);
					await page.keyboard.press("Enter");
					const approve = page.getByRole("dialog", {
						name: `Approve ${MEMBER}'s time on ${WEBSITE}?`,
					});
					await expect(approve).toBeVisible();
					await expectNoProblems(page, "in Approve a part");
					await shoot(page, "projects-tab-approve-part");
					await submitSheet(page, approve, "Approve", "Their time on the project approved.");
					await expect(main.getByRole("list", { name: `${WEBSITE}, by person` })).toContainText(
						`Approved by ${LEAD}`,
					);

					await tabTo(
						page,
						page.getByRole("button", { name: `Return ${MEMBER}'s time on ${BRAND}` }),
					);
					await page.keyboard.press("Enter");
					const back = page.getByRole("dialog", { name: `Return ${MEMBER}'s time on ${BRAND}` });
					const reason = back.getByRole("textbox", { name: "What needs changing" });
					await expect(reason).toBeFocused();
					await page.keyboard.type(REASON);
					await expectNoProblems(page, "in Return a part");
					await shoot(page, "projects-tab-return-part");
					await submitSheet(
						page,
						back,
						"Return",
						"Their time on the project returned. They can change it and submit it again.",
					);
					const brand = main.getByRole("list", { name: `${BRAND}, by person` });
					await expect(brand).toContainText(`Returned by ${LEAD}`);
					await expect(brand).toContainText(`“${REASON}”`);
					await expect(
						page.getByRole("button", { name: `Approve ${MEMBER}'s time on ${BRAND}` }),
					).toHaveCount(0);
					await expectNoProblems(page, "on Projects with parts decided");
					await shoot(page, "projects-tab-decided");
				});
			});

			test.describe("the member, with a part returned", () => {
				test.use({ storageState: session("member") });

				test("6. corrects the returned part alone and submits the week again", async ({
					page,
					refusals,
				}) => {
					await openWeek(page, slug, mondayOf(day));
					await expect(page.getByText("Status: Returned")).toBeAttached();
					const main = page.getByRole("main");
					await expect(main).toContainText("Part of it was returned.");
					await expect(partsList(page).getByRole("listitem")).toHaveText([
						"The rest of the week: Approved",
						`Time on ${BRAND}: Returned, “${REASON}”`,
						`Time on ${WEBSITE}: Approved`,
					]);
					await expectNoGridProblems(page, "on a week with a part returned");
					await shoot(page, "timesheet-part-returned", partsList(page));

					// The approved part stays as it was.
					expectRefusal(refusals, `${organisationPath(slug)}.data`, 409);
					await typeHours(page, cell(page, WEBSITE, day), "4");
					await expect(main.getByRole("alert").filter({ hasText: LOCKED })).toHaveCount(1);
					await openWeek(page, slug, mondayOf(day));
					await expect(cell(page, WEBSITE, day)).toHaveValue("3:00");

					// The returned part is corrected.
					await typeHours(page, cell(page, BRAND, day), "1.5");
					await expect(page.getByRole("row", { name: /Brand/ })).toContainText("1:30");

					await submitWeek(page);
					await expect(page.getByText("Status: Submitted")).toBeAttached();
					await expect(page.getByRole("row", { name: /Website/ })).toContainText("3:00");
					await expect(partsList(page).getByRole("listitem")).toHaveText([
						"The rest of the week: Approved",
						`Time on ${BRAND}: ${WAITING}`,
						`Time on ${WEBSITE}: Approved`,
					]);
					// With a part approved, the week is not withdrawn.
					await expect(page.getByRole("button", { name: "Withdraw submission" })).toHaveCount(0);
					await expectNoGridProblems(page, "on a week submitted again");
					await shoot(page, "timesheet-submitted-again", partsList(page));
				});
			});

			test.describe("the delivery manager, again", () => {
				test.use({ storageState: session("lead") });

				test("7. approves the part that came back", async ({ page }) => {
					await openShell(page, `${approvals}?view=projects&week=${mondayOf(day)}`);
					const brand = page.getByRole("main").getByRole("list", { name: `${BRAND}, by person` });
					await expect(brand).toContainText(`${shortDay(day)} 1:30`);
					await tabTo(
						page,
						page.getByRole("button", { name: `Approve ${MEMBER}'s time on ${BRAND}` }),
					);
					await page.keyboard.press("Enter");
					const approve = page.getByRole("dialog", {
						name: `Approve ${MEMBER}'s time on ${BRAND}?`,
					});
					await submitSheet(page, approve, "Approve", "Their time on the project approved.");
					await expect(brand).toContainText(`Approved by ${LEAD}`);
				});
			});

			test.describe("the member, with every part approved", () => {
				test.use({ storageState: session("member") });

				test("8. sees the week approved", async ({ page }) => {
					await openWeek(page, slug, mondayOf(day));
					await expect(page.getByText("Status: Approved")).toBeAttached();
					await expect(partsList(page).getByRole("listitem")).toHaveText([
						"The rest of the week: Approved",
						`Time on ${BRAND}: Approved`,
						`Time on ${WEBSITE}: Approved`,
					]);
					await expect(page.getByRole("main")).toContainText("Approved. Its entries are locked.");
					await expectNoGridProblems(page, "on a week approved in parts");
					await shoot(page, "timesheet-approved", partsList(page));
				});
			});
		});
	}
}
