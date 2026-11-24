import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Locator, Page } from "@playwright/test";

import {
	destinationPath,
	NEW_ORGANISATION_PATH,
	organisationPath,
} from "../app/shell/destinations";
import { foundInMessageSentBy, newPerson, ownAddress, setName, signIn } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { contrast, EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import {
	INVITATION_LINK,
	invite,
	newOrganisationName,
	openInvitations,
	openOutsideOrganisation,
} from "./organisation";
import { pastWeekday, zoneIsTheBrowsers } from "./timesheet";

// Codes and How you work (TS-115a, decision 67; account managers, decision 42)
// in the browser, at 390px and 1280px wide, in light and in dark:
//
// 1. Track time's project picker names each project by its code first
//    (`ACME-001 · Website`), finds one by its code or its client's, and under
//    How you work = Both holds the work codes in a group of their own.
// 2. An owner changes How you work on Workspace settings, between Client
//    projects, Internal work and Both, with the internal term, the code rule,
//    the pattern and, under Both, the work codes' own rule; and /app/new asks
//    the question of a new organisation.
// 3. On Clients an owner names a member account manager of a client; the
//    member is then offered Create on Projects, for that client only, and is
//    offered it no longer once the owner takes it away.
// 4. An organisation that works internally says its own term, "Work codes", on
//    the Timesheet and on its Projects page, never "project" or "client", and
//    its navigation has no Clients, Invoices or Estimates.
//
// Every page is operated with the keyboard alone and scanned by axe, which
// finds nothing. Who may do what, and the rules themselves, are tested through
// the Worker (test/pages/codes-timesheet.test.ts, test/integrations/codes.test.ts).
//
// Each window size and scheme has people and organisations of its own, made
// through the pages, so nothing here changes what another test looks at, and
// the four run beside each other. With SHOT_DIR set, each page is photographed
// into it (`SHOT_DIR=… pnpm exec playwright test e2e/codes.spec.ts`).

const OWNER = "Ada Lovelace";
const MEMBER = "Grace Hopper";
const SHOT_DIR = process.env.SHOT_DIR;

/** Every word of a page that would name a project or a client. */
const PROJECT_OR_CLIENT = /\b(?:projects?|clients?)\b/i;

/** Presses Tab until `target` has the focus: the way a person without a pointer gets there. */
async function tabTo(page: Page, target: Locator, most = 80) {
	for (let step = 0; step < most; step++) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press("Tab");
	}
	await expect(target).toBeFocused();
}

/** Somebody with a browser of their own, signed out, at a client address of their own. */
async function newBrowser(browser: Browser, baseURL: string | undefined): Promise<Page> {
	const context = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
	await ownAddress(context, baseURL);
	return context.newPage();
}

type Model = "Client projects" | "Internal work" | "Both";

/** A radio of How you work: its name is the answer, then what the answer means. */
function modelRadio(within: Page | Locator, model: Model): Locator {
	return within.getByRole("radio", { name: new RegExp(`^${model}`) });
}

/** Creates an organisation that works by `model` through /app/new, and returns its slug. */
async function newOrganisation(page: Page, model: Model): Promise<string> {
	await openOutsideOrganisation(page, NEW_ORGANISATION_PATH);
	await page.getByLabel("Organisation name").fill(newOrganisationName());
	// The radio itself is hidden; its label is what a pointer presses.
	await page.getByText(model, { exact: true }).click();
	await expect(modelRadio(page, model)).toBeChecked();
	await page.getByRole("button", { name: "Create organisation" }).click();
	await page.waitForURL(
		({ pathname, search }) => /^\/app\/(?!new$)[a-z0-9-]+$/.test(pathname) && search === "",
	);
	return new URL(page.url()).pathname.split("/")[2] ?? "";
}

/** Creates a client with a code on Clients. */
async function createClient(page: Page, slug: string, name: string, code: string) {
	await openShell(page, destinationPath(slug, "clients"));
	await page.getByRole("button", { name: "Create client" }).click();
	const sheet = page.getByRole("dialog", { name: "Create a client" });
	await sheet.getByLabel("Client name").fill(name);
	await sheet.getByLabel("Code", { exact: true }).fill(code);
	await sheet.getByRole("button", { name: "Create the client" }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("status")).toHaveText(`Client created: ${name}.`);
}

/**
 * Creates a project with a code on Projects, for `client` as the Client field
 * names it, or with the field as it opens: no client, which under Both is a
 * work code. Under Internal work the page says the organisation's own term.
 */
async function createCodedProject(
	page: Page,
	slug: string,
	name: string,
	code: string,
	client?: string,
) {
	await openShell(page, destinationPath(slug, "projects"));
	await page.getByRole("button", { name: /^Create (?:project|work code)$/ }).click();
	const sheet = page.getByRole("dialog", { name: /^Create an? (?:project|work code)$/ });
	await sheet.getByLabel(/^(?:Project|Work code) name/).fill(name);
	await sheet.getByLabel("Code", { exact: true }).fill(code);
	if (client) {
		await sheet.getByRole("button", { name: /Client/ }).click();
		await page
			.getByRole("listbox", { name: "Client" })
			.getByRole("option", { name: client })
			.click();
	}
	await sheet.getByRole("button", { name: /^Create the (?:project|work code)$/ }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("main")).toContainText(`${code} · ${name}`);
}

/**
 * Whether the main navigation links to `name`, wherever it draws the link:
 * the column, the bar under 600px, or what More opens, which draws some twice.
 */
async function expectInNavigation(page: Page, name: string, linked: boolean) {
	const links = page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name, exact: true, includeHidden: true });
	if (linked) await expect(links.first()).toBeAttached();
	else await expect(links).toHaveCount(0);
}

/** Opens Track time on a weekday that has passed, by the keyboard, and returns its sheet. */
async function openTrackTime(page: Page, slug: string): Promise<Locator> {
	await openShell(page, `${organisationPath(slug)}?day=${await pastWeekday(page)}`);
	await tabTo(
		page,
		page.getByRole("main").getByRole("button", { name: "Track time", exact: true }),
	);
	await page.keyboard.press("Enter");
	const sheet = page.getByRole("dialog", { name: "Track time" });
	await expect(sheet).toBeVisible();
	return sheet;
}

/** What the page's main region, its navigation and any open dialog say, as shown. */
async function shownText(page: Page): Promise<string> {
	const parts = await page
		.locator("main, nav[aria-label='Main'], [role='dialog'], [role='listbox']")
		.allInnerTexts();
	return parts.join("\n");
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
			const ownerSession = join(tmpdir(), `timesifier-codes-${run}-owner.json`);
			const memberSession = join(tmpdir(), `timesifier-codes-${run}-member.json`);
			/** The organisations: one that works by both, one internally, one whose settings change. */
			let both = "";
			let internal = "";
			let changing = "";

			/** Photographs the page as `what`, when SHOT_DIR asks for it. */
			async function shoot(page: Page, what: string) {
				if (!SHOT_DIR) return;
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

			test.beforeAll(async ({ browser, baseURL }) => {
				test.setTimeout(240_000);
				const page = await newBrowser(browser, baseURL);
				await signIn(page, newPerson().email);
				both = await newOrganisation(page, "Both");
				// While Both is the person's one organisation, its My account is where `setName` leads.
				await setName(page, OWNER);
				internal = await newOrganisation(page, "Internal work");
				changing = await newOrganisation(page, "Client projects");

				await createClient(page, both, "Acme", "ACME");
				await createClient(page, both, "Globex", "GLX");
				await createCodedProject(page, both, "Website", "ACME-001", "ACME · Acme");
				await createCodedProject(page, both, "Payroll", "GLX-001", "GLX · Globex");
				// No client, under Both: a work code, which bills nothing.
				await createCodedProject(page, both, "Support", "OPS-01");
				await createCodedProject(page, internal, "Support", "OPS-01");
				await createCodedProject(page, internal, "Maintenance", "OPS-02");
				// Time is tracked on a past weekday of the browser's zone, which is the person's.
				await zoneIsTheBrowsers(page, both);
				await zoneIsTheBrowsers(page, internal);

				await openInvitations(page, both);
				const member = newPerson().email;
				const invitation = await foundInMessageSentBy(
					() => invite(page, member),
					INVITATION_LINK,
					"the invitation's link",
				);
				await page.context().storageState({ path: ownerSession });
				await page.context().close();

				const membersPage = await newBrowser(browser, baseURL);
				await signIn(membersPage, member, `/sign-in?next=${encodeURIComponent(invitation)}`);
				await expect(membersPage).toHaveURL(invitation);
				await membersPage.getByRole("button", { name: "Join" }).click();
				await expect(
					membersPage.getByRole("heading", { level: 1, name: "Timesheet" }),
				).toBeVisible();
				await setName(membersPage, MEMBER);
				await membersPage.context().storageState({ path: memberSession });
				await membersPage.context().close();
			});

			test.describe("as the owner", () => {
				test.use({ storageState: ownerSession });

				test("1. Track time's picker shows codes first, finds a project by its code or its client's, and keeps work codes apart under Both", async ({
					page,
				}) => {
					const sheet = await openTrackTime(page, both);
					const picker = sheet.getByRole("combobox", { name: "Project" });
					await tabTo(page, picker);
					await page.keyboard.press("ArrowDown");
					const list = page.getByRole("listbox");
					await expect(list).toBeVisible();

					// Each client's projects under it, by code then name; the work codes after them, apart.
					const groups = list.getByRole("group");
					await expect(groups).toHaveCount(3);
					await expect(list.getByRole("option")).toHaveCount(3);
					// An option is named as it is seen: its code and name, then its client's code and name (WCAG 2.5.3).
					// A work code has no client.
					for (const [group, option] of [
						["ACME · Acme", "ACME-001 · Website ACME · Acme"],
						["GLX · Globex", "GLX-001 · Payroll GLX · Globex"],
						["Work codes", "OPS-01 · Support"],
					] as const) {
						const inGroup = list.getByRole("group", { name: group, exact: true });
						await expect(inGroup.getByRole("option")).toHaveCount(1);
						await expect(inGroup.getByRole("option").first()).toHaveAccessibleName(option);
					}
					// The code comes first in what the option shows.
					await expect(list.getByRole("option").first()).toHaveText(/^ACME-001 · Website/);
					await expect(groups.nth(0)).toHaveAccessibleName("ACME · Acme");
					await expect(groups.nth(2)).toHaveAccessibleName("Work codes");
					await expectNoProblems(page, "with the picker open", [EMPTY_INPUT, UNDER_AN_OVERLAY]);
					await shoot(page, "1-timesheet-picker-both");

					// The project's code, in any case, finds it alone. The field opens holding the last project
					// tracked or created, so what is typed replaces it.
					await page.keyboard.press("ControlOrMeta+A");
					await page.keyboard.type("acme-0");
					await expect(list.getByRole("option")).toHaveCount(1);
					await expect(list.getByRole("option").first()).toHaveAccessibleName(
						"ACME-001 · Website ACME · Acme",
					);
					await shoot(page, "1-timesheet-picker-searched-by-code");
					// Its client's code finds the client's projects.
					await page.keyboard.press("ControlOrMeta+A");
					await page.keyboard.type("GLX");
					await expect(list.getByRole("option")).toHaveCount(1);
					await expect(
						list.getByRole("group", { name: "GLX · Globex", exact: true }),
					).toBeVisible();
					// A work code's code finds it, still in its own group.
					await page.keyboard.press("ControlOrMeta+A");
					await page.keyboard.type("ops-01");
					await expect(list.getByRole("option")).toHaveCount(1);
					await expect(
						list.getByRole("group", { name: "Work codes", exact: true }).getByRole("option"),
					).toHaveAccessibleName("OPS-01 · Support");
					await expectNoProblems(page, "with the picker searched", [EMPTY_INPUT, UNDER_AN_OVERLAY]);

					// Chosen with the keyboard, the field names it by its code first.
					await page.keyboard.press("ControlOrMeta+A");
					await page.keyboard.type("ACME-001");
					await page.keyboard.press("ArrowDown");
					await page.keyboard.press("Enter");
					await expect(list).toBeHidden();
					await expect(picker).toHaveValue("ACME-001 · Website");
					await expect(picker).toBeFocused();
					await page.keyboard.press("Escape");
					await expect(sheet).toBeHidden();
				});

				test("2. Workspace settings changes How you work between Client projects, Internal work and Both, with the term, the codes and the pattern, by keyboard", async ({
					page,
				}) => {
					const settings = destinationPath(changing, "settings");
					await openShell(page, settings);
					const main = page.getByRole("main");
					await expect(main).toContainText("Clients, their projects, invoices and estimates.");
					const changeModel = page.getByRole("button", { name: "Change how you work" });
					const changeCodes = page.getByRole("button", { name: "Change the codes", exact: true });
					const sheet = page.getByRole("dialog", { name: "Change how you work" });
					const term = sheet.getByRole("textbox", { name: "What you call internal work" });
					const save = sheet.getByRole("button", { name: "Save" });

					// Internal work, called Cost centres.
					await tabTo(page, changeModel);
					await page.keyboard.press("Enter");
					await expect(sheet).toBeVisible();
					await expect(modelRadio(sheet, "Client projects")).toBeChecked();
					await expect(term).toHaveCount(0);
					await tabTo(page, modelRadio(sheet, "Client projects"));
					await page.keyboard.press("ArrowDown");
					await expect(modelRadio(sheet, "Internal work")).toBeChecked();
					await expect(term).toHaveValue("Work codes");
					await tabTo(page, term);
					await page.keyboard.press("ControlOrMeta+A");
					await page.keyboard.type("Cost centres");
					await expectNoProblems(page, "in Change how you work", [UNDER_AN_OVERLAY]);
					await tabTo(page, save);
					await page.keyboard.press("Enter");
					await expect(sheet).toBeHidden();
					await expect(page.getByText("How you work is now Internal work.")).toBeVisible();
					await expect(main).toContainText("No invoices or estimates. Time goes to cost centres.");
					await expect(main).toContainText("Cost centre codes, such as OPS-01");
					await expectInNavigation(page, "Cost centres", true);
					for (const gone of ["Clients", "Invoices", "Estimates", "Projects"]) {
						await expectInNavigation(page, gone, false);
					}

					// Both, with work codes called Work codes again.
					await tabTo(page, changeModel);
					await page.keyboard.press("Enter");
					await expect(modelRadio(sheet, "Internal work")).toBeChecked();
					await tabTo(page, modelRadio(sheet, "Internal work"));
					await page.keyboard.press("ArrowDown");
					await expect(modelRadio(sheet, "Both")).toBeChecked();
					await tabTo(page, term);
					await page.keyboard.press("ControlOrMeta+A");
					await page.keyboard.type("Work codes");
					await expectNoProblems(page, "in Change how you work, Both", [UNDER_AN_OVERLAY]);
					await shoot(page, "2-settings-change-how-you-work-sheet");
					await tabTo(page, save);
					await page.keyboard.press("Enter");
					await expect(sheet).toBeHidden();
					await expect(page.getByText("How you work is now Both.")).toBeVisible();
					await expect(main).toContainText(
						"Clients and their projects, and work codes for internal time that bills nobody.",
					);
					for (const back of ["Clients", "Invoices", "Estimates", "Projects"]) {
						await expectInNavigation(page, back, true);
					}

					// The codes: numbered from PRJ-0001, and every work code needs one of its own.
					const codes = page.getByRole("dialog", { name: "Change the codes" });
					await tabTo(page, changeCodes);
					await page.keyboard.press("Enter");
					await expect(codes).toBeVisible();
					const required = codes.getByRole("checkbox", { name: "Every new project has a code" });
					const workCodeRequired = codes.getByRole("checkbox", {
						name: "Every new work code has a code",
					});
					const pattern = codes.getByRole("textbox", { name: "Number new ones from" });
					await expect(required).not.toBeChecked();
					await expect(workCodeRequired).not.toBeChecked();
					await tabTo(page, workCodeRequired);
					await page.keyboard.press("Space");
					await expect(workCodeRequired).toBeChecked();
					await tabTo(page, pattern);
					await page.keyboard.type("PRJ-0001");
					await expectNoProblems(page, "in Change the codes", [UNDER_AN_OVERLAY]);
					await shoot(page, "2-settings-change-the-codes-sheet");
					await tabTo(page, codes.getByRole("button", { name: "Save" }));
					await page.keyboard.press("Enter");
					await expect(codes).toBeHidden();
					await expect(
						page.getByText(
							"New projects without a code are numbered from PRJ-0001. Every new work code needs a code.",
						),
					).toBeVisible();
					await expect(main).toContainText("Numbered from PRJ-0001");
					await expect(
						page.getByRole("button", { name: "Change the codes of work codes", exact: true }),
					).toBeVisible();
					await page
						.getByRole("heading", { name: "How you work", level: 2 })
						.scrollIntoViewIfNeeded();
					await expectNoProblems(page, "on Workspace settings under Both");
					await shoot(page, "2-settings-how-you-work-both");

					// Back: codes optional, and Client projects, which asks no term.
					await tabTo(page, changeCodes);
					await page.keyboard.press("Enter");
					await expect(workCodeRequired).toBeChecked();
					await expect(pattern).toHaveValue("PRJ-0001");
					await tabTo(page, workCodeRequired);
					await page.keyboard.press("Space");
					await tabTo(page, pattern);
					await page.keyboard.press("ControlOrMeta+A");
					await page.keyboard.press("Delete");
					await tabTo(page, codes.getByRole("button", { name: "Save" }));
					await page.keyboard.press("Enter");
					await expect(
						page.getByText("Project codes are optional. Codes for work codes are optional."),
					).toBeVisible();

					await tabTo(page, changeModel);
					await page.keyboard.press("Enter");
					await tabTo(page, modelRadio(sheet, "Both"));
					await page.keyboard.press("ArrowUp");
					await page.keyboard.press("ArrowUp");
					await expect(modelRadio(sheet, "Client projects")).toBeChecked();
					await expect(term).toHaveCount(0);
					await tabTo(page, save);
					await page.keyboard.press("Enter");
					await expect(page.getByText("How you work is now Client projects.")).toBeVisible();
					await expect(main).toContainText("Clients, their projects, invoices and estimates.");
					await expect(
						page.getByRole("button", { name: "Change the codes of work codes", exact: true }),
					).toHaveCount(0);
					await expectInNavigation(page, "Clients", true);
				});

				test("2. /app/new asks how the organisation works, answered by keyboard, and Internal work arrives without clients", async ({
					page,
				}) => {
					await openOutsideOrganisation(page, NEW_ORGANISATION_PATH);
					const question = page.getByRole("radiogroup", { name: "How you work" });
					await expect(question).toBeVisible();
					await expect(modelRadio(question, "Client projects")).toBeChecked();
					await tabTo(page, page.getByRole("textbox", { name: "Organisation name" }));
					await page.keyboard.type(newOrganisationName());
					await page.keyboard.press("Tab");
					await expect(modelRadio(question, "Client projects")).toBeFocused();
					await page.keyboard.press("ArrowDown");
					await expect(modelRadio(question, "Internal work")).toBeChecked();
					await page.keyboard.press("ArrowDown");
					await expect(modelRadio(question, "Both")).toBeChecked();
					await page.keyboard.press("ArrowUp");
					await expect(modelRadio(question, "Internal work")).toBeChecked();
					await expectNoProblems(page, "on /app/new");
					await shoot(page, "2-new-organisation-how-you-work");

					await tabTo(page, page.getByRole("button", { name: "Create organisation" }));
					await page.keyboard.press("Enter");
					await page.waitForURL(
						({ pathname, search }) => /^\/app\/(?!new$)[a-z0-9-]+$/.test(pathname) && search === "",
					);
					await expect(page.getByRole("heading", { level: 1, name: "Timesheet" })).toBeVisible();
					await expectInNavigation(page, "Work codes", true);
					for (const gone of ["Clients", "Invoices", "Estimates", "Projects"]) {
						await expectInNavigation(page, gone, false);
					}
				});

				test("4. an Internal-work organisation's Timesheet says Work codes, never project or client, and its navigation has no Clients, Invoices or Estimates", async ({
					page,
				}) => {
					const sheet = await openTrackTime(page, internal);
					for (const gone of ["Clients", "Invoices", "Estimates", "Projects"]) {
						await expectInNavigation(page, gone, false);
					}
					await expectInNavigation(page, "Work codes", true);

					const picker = sheet.getByRole("combobox", { name: "Work code" });
					await tabTo(page, picker);
					await page.keyboard.press("ArrowDown");
					const list = page.getByRole("listbox");
					await expect(list).toBeVisible();
					await expect(list.getByRole("group")).toHaveCount(1);
					const workCodes = list.getByRole("group", { name: "Work codes", exact: true });
					await expect(workCodes.getByRole("option")).toHaveCount(2);
					await expect(workCodes.getByRole("option").nth(0)).toHaveAccessibleName(
						"OPS-01 · Support",
					);
					await expect(workCodes.getByRole("option").nth(1)).toHaveAccessibleName(
						"OPS-02 · Maintenance",
					);
					expect(await shownText(page)).not.toMatch(PROJECT_OR_CLIENT);
					await expectNoProblems(page, "with the picker open", [EMPTY_INPUT, UNDER_AN_OVERLAY]);
					await shoot(page, "4-internal-timesheet-track-time");

					await page.keyboard.press("ControlOrMeta+A");
					await page.keyboard.type("ops-02");
					await page.keyboard.press("ArrowDown");
					await page.keyboard.press("Enter");
					await expect(picker).toHaveValue("OPS-02 · Maintenance");
					await page.keyboard.press("Escape");
					await expect(sheet).toBeHidden();
					expect(await shownText(page)).not.toMatch(PROJECT_OR_CLIENT);
					await expectNoProblems(page, "on the Timesheet");
					await shoot(page, "4-internal-timesheet");

					// Under 600px the bar's More holds the rest: none of them is Clients, Invoices or Estimates.
					if (viewport.width < 600) {
						await tabTo(
							page,
							page
								.getByRole("navigation", { name: "Main" })
								.getByRole("button", { name: /^More\b/ }),
						);
						await page.keyboard.press("Enter");
						const held = page.locator("#navigation-more").getByRole("link");
						await expect(held.first()).toBeVisible();
						const names = (await held.allTextContents()).map((name) => name.trim());
						for (const gone of ["Clients", "Invoices", "Estimates"]) {
							expect(names).not.toContain(gone);
						}
						await expectNoProblems(page, "with More open", [UNDER_AN_OVERLAY]);
						await shoot(page, "4-internal-navigation-more");
						await page.keyboard.press("Escape");
						await expect(held.first()).toBeHidden();
					}
				});

				test("4. an Internal-work organisation's Projects page is Work codes, created by keyboard, with no project or client", async ({
					page,
				}) => {
					await openShell(page, destinationPath(internal, "projects"));
					const heading = page.getByRole("heading", { level: 1, name: "Work codes" });
					await expect(heading).toBeVisible();
					const active = page.getByRole("list", { name: "Active work codes" });
					await expect(active).toContainText("OPS-01 · Support");
					await expect(active).toContainText("OPS-02 · Maintenance");
					expect(await shownText(page)).not.toMatch(PROJECT_OR_CLIENT);
					await expectNoProblems(page, "on Work codes", [EMPTY_INPUT]);
					await shoot(page, "4-internal-work-codes-page");

					await tabTo(page, page.getByRole("button", { name: "Create work code" }));
					await page.keyboard.press("Enter");
					const sheet = page.getByRole("dialog", { name: "Create a work code" });
					const name = sheet.getByRole("textbox", { name: "Work code name" });
					await tabTo(page, name);
					await page.keyboard.type("Facilities");
					await page.keyboard.press("Tab");
					await expect(sheet.getByRole("textbox", { name: "Code", exact: true })).toBeFocused();
					await page.keyboard.type("OPS-03");
					expect(await shownText(page)).not.toMatch(PROJECT_OR_CLIENT);
					await expectNoProblems(page, "in Create a work code", [EMPTY_INPUT, UNDER_AN_OVERLAY]);
					await shoot(page, "4-internal-create-work-code-sheet");
					await page.keyboard.press("Enter");
					await expect(sheet).toBeHidden();
					await expect(page.getByText("Work code created: Facilities.")).toBeVisible();
					await expect(active).toContainText("OPS-03 · Facilities");
					expect(await shownText(page)).not.toMatch(PROJECT_OR_CLIENT);
				});

				test("3. an owner names a member account manager of a client on Clients, by keyboard", async ({
					page,
				}) => {
					await openShell(page, destinationPath(both, "clients"));
					const clients = page.getByRole("list", { name: "Active clients" });
					await expect(clients).toContainText("ACME · Acme");
					await expect(clients).not.toContainText("Account manager");
					await expectNoProblems(page, "on Clients", [EMPTY_INPUT]);

					await tabTo(page, page.getByRole("button", { name: "ACME · Acme" }));
					await page.keyboard.press("Enter");
					const client = page.getByRole("dialog", { name: "Rename Acme" });
					await expect(client).toContainText("No account managers.");
					await tabTo(page, client.getByRole("button", { name: "Change account managers" }));
					await page.keyboard.press("Enter");
					const managers = page.getByRole("dialog", { name: "Account managers of Acme" });
					await expect(managers).toBeVisible();
					const member = managers.getByRole("checkbox", { name: MEMBER });
					await expect(member).not.toBeChecked();
					await expect(managers.getByRole("checkbox", { name: OWNER })).not.toBeChecked();
					await tabTo(page, member);
					await page.keyboard.press("Space");
					await expect(member).toBeChecked();
					await expectNoProblems(page, "in Account managers", [UNDER_AN_OVERLAY]);
					await shoot(page, "3-clients-account-managers-sheet");
					await tabTo(page, managers.getByRole("button", { name: "Save" }));
					await page.keyboard.press("Enter");
					await expect(managers).toBeHidden();
					await expect(page.getByText("Acme has 1 account manager.")).toBeVisible();
					await expect(clients).toContainText(`Account manager: ${MEMBER}`);
					await expectNoProblems(page, "on Clients with an account manager", [EMPTY_INPUT]);
					await shoot(page, "3-clients-with-account-manager");
				});
			});

			test.describe("as the account manager", () => {
				test.use({ storageState: memberSession });

				test("3. the account manager is offered Create on Projects, for their client only, and creates a project by keyboard", async ({
					page,
				}) => {
					await openShell(page, destinationPath(both, "projects"));
					await tabTo(page, page.getByRole("button", { name: "Create project" }));
					await page.keyboard.press("Enter");
					const sheet = page.getByRole("dialog", { name: "Create a project" });
					await expect(sheet).toBeVisible();
					await expect(sheet).toContainText(
						"You create projects for the clients you are an account manager of.",
					);
					await tabTo(page, sheet.getByRole("textbox", { name: "Project name" }));
					await page.keyboard.type("Launch");
					await page.keyboard.press("Tab");
					await expect(sheet.getByRole("textbox", { name: "Code", exact: true })).toBeFocused();
					await page.keyboard.type("ACME-002");

					// The Client field offers Acme alone: not Globex, and no work code.
					const client = sheet.getByRole("button", { name: /Client/ });
					await expect(client).toContainText("ACME · Acme");
					await tabTo(page, client);
					await page.keyboard.press("Enter");
					const offered = page.getByRole("listbox", { name: "Client" });
					await expect(offered).toBeVisible();
					await expect(offered.getByRole("option")).toHaveCount(1);
					await expect(offered.getByRole("option")).toHaveAccessibleName("ACME · Acme");
					await page.keyboard.press("Escape");
					await expect(offered).toBeHidden();
					await expect(sheet).toBeVisible();
					await expectNoProblems(page, "in Create a project", [UNDER_AN_OVERLAY]);
					await shoot(page, "3-account-manager-create-project-sheet");

					await tabTo(page, sheet.getByRole("button", { name: "Create the project" }));
					await page.keyboard.press("Enter");
					await expect(sheet).toBeHidden();
					await expect(page.getByText("Project created: Launch.")).toBeVisible();
					await expect(
						page.getByRole("list", { name: "Active projects: ACME · Acme" }),
					).toContainText("ACME-002 · Launch");
					await expectNoProblems(page, "on Projects as an account manager", [EMPTY_INPUT]);
					await shoot(page, "3-account-manager-projects");
				});
			});

			test.describe("as the owner, again", () => {
				test.use({ storageState: ownerSession });

				test("3. the owner takes the account manager away, by keyboard", async ({ page }) => {
					await openShell(page, destinationPath(both, "clients"));
					await tabTo(page, page.getByRole("button", { name: "ACME · Acme" }));
					await page.keyboard.press("Enter");
					const client = page.getByRole("dialog", { name: "Rename Acme" });
					await expect(client).toContainText(
						`Account manager: ${MEMBER}. They create its projects.`,
					);
					await tabTo(page, client.getByRole("button", { name: "Change account managers" }));
					await page.keyboard.press("Enter");
					const managers = page.getByRole("dialog", { name: "Account managers of Acme" });
					const member = managers.getByRole("checkbox", { name: MEMBER });
					await expect(member).toBeChecked();
					await tabTo(page, member);
					await page.keyboard.press("Space");
					await expect(member).not.toBeChecked();
					await tabTo(page, managers.getByRole("button", { name: "Save" }));
					await page.keyboard.press("Enter");
					await expect(page.getByText("Acme has no account managers.")).toBeVisible();
					await expect(page.getByRole("list", { name: "Active clients" })).not.toContainText(
						"Account manager",
					);
				});
			});

			test.describe("as the member, no longer an account manager", () => {
				test.use({ storageState: memberSession });

				test("3. a member who manages no client is offered no Create on Projects, and keeps the project they made", async ({
					page,
				}) => {
					await openShell(page, destinationPath(both, "projects"));
					await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
					await expect(
						page.getByRole("list", { name: "Active projects: ACME · Acme" }),
					).toContainText("ACME-002 · Launch");
					await expect(page.getByRole("button", { name: "Create project" })).toHaveCount(0);
					await expectNoProblems(page, "on Projects as a member", [EMPTY_INPUT]);
				});
			});
		});
	}
}
