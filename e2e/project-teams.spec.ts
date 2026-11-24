import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { projectPath } from "../app/projects/projects";
import {
	APP_PATH,
	destinationPath,
	NEW_ORGANISATION_PATH,
	organisationPath,
} from "../app/shell/destinations";
import { foundInMessageSentBy, newPerson, setName, signIn } from "./auth";
import { contrast, EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import {
	expectRefusal,
	INVITATION_LINK,
	invite,
	newOrganisationName,
	openInvitations,
	openOutsideOrganisation,
} from "./organisation";
import { createClient, createCodedProject, newBrowser } from "./projects";
import { pastWeekday, zoneIsTheBrowsers } from "./timesheet";

// Project teams (TS-115c, decision 75) in the browser, at 390px and 1280px
// wide, in light and in dark, in an organisation where only a project's team
// tracks time to it ("Assigned people only"):
//
// 1. The owner assigns people on the project's Team tab by the keyboard,
//    a delivery manager and members, changes a stretch's role from a day,
//    removes a stretch and ends one.
// 2. A delivery manager assigns a member, is offered no Delivery manager,
//    and has no action on a delivery manager's stretch, their own included.
// 3. A member sees their own stretch alone and no action, and Track time's
//    picker offers the project under "Your projects", first; the entry saves.
// 4. The owner, not on the team on the day, finds the project under "Not on
//    the team", adds themselves with "Add me to the team", and the entry
//    saves; the project is then under "Your projects". A stretch with time in
//    it is refused removal, with the server's sentence, and is ended instead.
// 5. A member not on the team on the day is not offered the project at all.
//
// Every page is operated with the keyboard and scanned by axe, which finds
// nothing. The rules themselves are tested through the Worker. Each window
// size and scheme has people and an organisation of its own, made through the
// pages. With SHOT_DIR set, each page is photographed into it.

const OWNER = "Ada Lovelace";
const LEAD = "Grace Hopper";
const MEMBER = "Alan Turing";
const OUTSIDER = "Mary Jackson";
const SHOT_DIR = process.env.SHOT_DIR;

const WEBSITE = "ACME-001 · Website";
// The page's own words (app/projects/teams.ts), which this project's files cannot import.
const JOIN_LABEL = "Add me to the team";
const JOIN_NOTE = `You are not on ${WEBSITE}'s team on this day.`;
const HAS_TIME =
	"They have tracked time to this project in that stretch, so it cannot be removed. End it instead.";
const TEAMS_ONLY =
	"Only the projects whose team you are on that day are offered. Ask a project's delivery manager to add you to its team.";
/** The organisation's address: `/app/<slug>`, and not the page that creates one. */
const ORGANISATION_ADDRESS = /^\/app\/(?!new$)[a-z0-9-]+$/;

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

/** A day `count` days after `day`, as an address writes it. */
function plusDays(day: string, count: number): string {
	const date = new Date(`${day}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + count);
	return date.toISOString().slice(0, 10);
}

/** The parts of a day as the page writes them, in English. */
function partsOf(day: string) {
	const parts = new Intl.DateTimeFormat("en-GB", {
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	}).formatToParts(new Date(`${day}T00:00:00Z`));
	const part = (type: string) => parts.find((each) => each.type === type)?.value ?? "";
	return { weekday: part("weekday"), day: part("day"), month: part("month"), year: part("year") };
}

/** A day as the page's sentences say it: "Wednesday 11 November". */
function dayLabel(day: string): string {
	const { weekday, day: date, month } = partsOf(day);
	return `${weekday} ${date} ${month}`;
}

/** Days as a row says them: "11 November 2026", "9–15 November 2026", "30 November – 6 December 2026". */
function rangeLabel(first: string, last: string): string {
	const from = partsOf(first);
	const to = partsOf(last);
	const end = `${to.day} ${to.month} ${to.year}`;
	if (first === last) return end;
	if (from.year !== to.year) return `${from.day} ${from.month} ${from.year} – ${end}`;
	if (from.month !== to.month) return `${from.day} ${from.month} – ${end}`;
	return `${from.day}–${end}`;
}

/** A stretch's days as its row says them. */
function daysOf(startsOn: string, endsOn: string | null = null): string {
	return endsOn === null ? `From ${rangeLabel(startsOn, startsOn)}` : rangeLabel(startsOn, endsOn);
}

/** The list of the project's team. */
const team = (page: Page) => page.getByRole("list", { name: "The project's team" });

/** The project's Team tab, reached from Overview by the keyboard. */
async function openTeam(page: Page, slug: string, id: string) {
	await openShell(page, projectPath(slug, id));
	await tabTo(
		page,
		page.getByRole("group", { name: "Project pages" }).getByRole("link", { name: "Team" }),
	);
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(projectPath(slug, id, "team"));
	await expect(team(page).or(page.getByText(/^(?:Nobody is|You are not) on this/))).toBeVisible();
}

/** Opens the Actions menu of the stretch `of` by the keyboard and chooses `item`. */
async function act(page: Page, of: string, item: string) {
	await tabTo(page, page.getByRole("button", { name: `Actions for ${of}`, exact: true }));
	await page.keyboard.press("Enter");
	const menu = page.getByRole("menu");
	await expect(menu).toBeVisible();
	await menu.getByRole("menuitem", { name: item, exact: true }).press("Enter");
}

/** Presses a sheet's primary action by the keyboard and waits for what the page says. */
async function submit(page: Page, sheet: Locator, button: string, said: string) {
	await tabTo(page, sheet.getByRole("button", { name: button, exact: true }));
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

/** Opens the project picker's list, nothing typed, by the keyboard, and returns it. */
async function openPicker(page: Page, sheet: Locator): Promise<Locator> {
	const picker = sheet.getByRole("combobox", { name: "Project" });
	await tabTo(page, picker);
	await page.keyboard.press("ControlOrMeta+A");
	await page.keyboard.press("Delete");
	await page.keyboard.press("ArrowDown");
	const list = page.getByRole("listbox");
	await expect(list).toBeVisible();
	return list;
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
			const session = (who: string) => join(tmpdir(), `timesifier-teams-${run}-${who}.json`);
			let slug = "";
			let website = "";
			/** The weekday that has passed on which time is tracked. */
			let day = "";
			/** Days to come, for stretches that do not cover `day`. */
			const today = new Date().toISOString().slice(0, 10);
			const [in2, in3, in4, in5, in10] = [2, 3, 4, 5, 10].map((n) => plusDays(today, n));

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
			 * an empty field (an optional last day, a picker not yet typed in), so
			 * each piece of the sheet's text is measured here instead.
			 */
			async function expectNoProblems(page: Page, state: string, unmeasurable: string[] = []) {
				const dialog = page.getByRole("dialog");
				const sheetOpen = (await dialog.count()) > 0;
				expect(
					await problems(
						page,
						sheetOpen ? [...unmeasurable, OVER_SEVERAL_ELEMENTS, EMPTY_INPUT] : unmeasurable,
					),
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

			/** Fills in Assign someone by the keyboard and sends it. */
			async function assign(
				page: Page,
				person: string,
				role: "Member" | "Delivery manager",
				first: string,
				said: string,
				look?: string,
			) {
				await tabTo(page, page.getByRole("button", { name: "Assign someone" }));
				await page.keyboard.press("Enter");
				const sheet = page.getByRole("dialog", { name: "Assign someone" });
				await expect(sheet).toBeVisible();
				const picker = sheet.getByRole("combobox", { name: "Person" });
				await tabTo(page, picker);
				await page.keyboard.type(person.slice(0, 3));
				const list = page.getByRole("listbox", { name: "Person" });
				await expect(list.getByRole("option", { name: person, exact: true })).toBeVisible();
				if (look) {
					await expectNoProblems(page, `in ${look}'s person list`, [UNDER_AN_OVERLAY]);
					await shoot(page, `assign-picker-${look}`);
				}
				await page.keyboard.press("ArrowDown");
				await page.keyboard.press("Enter");
				await expect(picker).toHaveValue(person);
				if (role !== "Member") {
					await choose(page, sheet.getByRole("button", { name: /Role/ }), "Role", role);
				}
				const firstDay = sheet.getByRole("textbox", { name: "First day" });
				await expect(firstDay).not.toHaveValue("");
				await tabTo(page, firstDay);
				await firstDay.fill(first);
				if (look) {
					await expectNoProblems(page, `in ${look}'s Assign someone`, [UNDER_AN_OVERLAY]);
					await shoot(page, `assign-sheet-${look}`);
				}
				await submit(page, sheet, "Assign", said);
			}

			test.beforeAll(async ({ browser, baseURL }) => {
				test.setTimeout(300_000);
				const page = await newBrowser(browser, baseURL);
				await signIn(page, newPerson().email);
				// Its own organisation, where only a project's team tracks time to it.
				await openOutsideOrganisation(page, NEW_ORGANISATION_PATH);
				await page.getByLabel("Organisation name").fill(newOrganisationName());
				await page.getByText("Assigned people only", { exact: true }).click();
				await expect(page.getByRole("radio", { name: /^Assigned people only/ })).toBeChecked();
				await page.getByRole("button", { name: "Create organisation" }).click();
				await page.waitForURL(
					({ pathname, search }) => ORGANISATION_ADDRESS.test(pathname) && search === "",
				);
				slug = new URL(page.url()).pathname.slice(APP_PATH.length + 1);
				await setName(page, OWNER);
				await createClient(page, slug, "Acme", "ACME");
				await createCodedProject(page, slug, "Website", "ACME-001", "ACME · Acme");
				await openShell(page, destinationPath(slug, "projects"));
				const href = await page
					.getByRole("main")
					.getByRole("link", { name: /Website/ })
					.first()
					.getAttribute("href");
				website = href?.split("/").at(-1) ?? "";
				expect(website).not.toBe("");
				// Time is tracked on a past weekday of the browser's zone, which is the person's.
				await zoneIsTheBrowsers(page, slug);
				day = await pastWeekday(page);

				for (const [who, name] of [
					["lead", LEAD],
					["member", MEMBER],
					["outsider", OUTSIDER],
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

			test.describe("as the owner", () => {
				test.use({ storageState: session("owner") });

				test("1. assigns, changes a role, removes and ends stretches on the Team tab, by keyboard", async ({
					page,
				}) => {
					await openTeam(page, slug, website);
					const main = page.getByRole("main");
					await expect(main).toContainText(
						"Only the people on this project's team on a day track time to it on that day.",
					);
					await expect(main).toContainText("Nobody is on this project's team yet.");
					await expectNoProblems(page, "on an empty Team tab");
					await shoot(page, "team-tab-empty");

					await assign(
						page,
						LEAD,
						"Delivery manager",
						day,
						`${LEAD} leads the team from ${dayLabel(day)}.`,
						"owner",
					);
					await assign(
						page,
						MEMBER,
						"Member",
						day,
						`${MEMBER} is on the team from ${dayLabel(day)}.`,
					);
					await assign(
						page,
						OUTSIDER,
						"Member",
						in2,
						`${OUTSIDER} is on the team from ${dayLabel(in2)}.`,
					);
					await expect(team(page).getByRole("listitem")).toHaveCount(3);
					await expect(team(page).getByRole("listitem").filter({ hasText: LEAD })).toContainText(
						`Delivery manager · ${daysOf(day)}`,
					);

					// Mary Jackson leads it from a later day: her stretch is split there.
					await act(page, `${OUTSIDER}, ${daysOf(in2)}`, "Change role");
					const role = page.getByRole("dialog", { name: `Change ${OUTSIDER}'s role` });
					await expect(role).toBeVisible();
					await expect(role.getByRole("button", { name: /New role/ })).toContainText(
						"Delivery manager",
					);
					const from = role.getByRole("textbox", { name: "From" });
					await tabTo(page, from);
					await from.fill(in5);
					await expectNoProblems(page, "in Change role", [UNDER_AN_OVERLAY]);
					await shoot(page, "change-role-sheet");
					await submit(
						page,
						role,
						"Change role",
						`From ${dayLabel(in5)}, they are a delivery manager of the team.`,
					);
					await expect(team(page)).toContainText(`Member · ${daysOf(in2, in4)}`);
					await expect(team(page)).toContainText(`Delivery manager · ${daysOf(in5)}`);

					// The stretch as delivery manager goes: no time was tracked in it.
					await act(page, `${OUTSIDER}, ${daysOf(in5)}`, "Remove");
					const remove = page.getByRole("dialog", { name: `Remove ${OUTSIDER}?` });
					await expect(remove).toBeVisible();
					await expectNoProblems(page, "in Remove", [UNDER_AN_OVERLAY]);
					await shoot(page, "remove-sheet");
					await submit(page, remove, "Remove", "Taken off the team.");
					await expect(team(page)).not.toContainText(daysOf(in5));

					// Her stretch as a member ends a day sooner.
					await act(page, `${OUTSIDER}, ${daysOf(in2, in4)}`, "End");
					const end = page.getByRole("dialog", { name: `End ${OUTSIDER}'s stretch` });
					await expect(end).toBeVisible();
					const last = end.getByRole("textbox", { name: "Last day" });
					await expect(last).toHaveValue(in4);
					await tabTo(page, last);
					await last.fill(in3);
					await expectNoProblems(page, "in End", [UNDER_AN_OVERLAY]);
					await shoot(page, "end-sheet");
					await submit(
						page,
						end,
						"Save last day",
						`Their last day on the team is ${dayLabel(in3)}.`,
					);
					await expect(team(page).getByRole("listitem")).toHaveCount(3);
					await expect(team(page)).toContainText(`Member · ${daysOf(in2, in3)}`);
					await expectNoProblems(page, "on the Team tab with its team");
					await shoot(page, "team-tab-owner");
				});
			});

			test.describe("as a delivery manager", () => {
				test.use({ storageState: session("lead") });

				test("2. assigns a member, is not offered Delivery manager, and has no action on a delivery manager's stretch", async ({
					page,
				}) => {
					await openTeam(page, slug, website);
					await expect(team(page).getByRole("listitem")).toHaveCount(3);
					await expect(
						page.getByRole("button", { name: `Actions for ${LEAD}, ${daysOf(day)}` }),
					).toHaveCount(0);
					await expect(
						page.getByRole("button", { name: `Actions for ${MEMBER}, ${daysOf(day)}` }),
					).toBeVisible();

					// A member's stretch is ended or removed, not given a role.
					await tabTo(
						page,
						page.getByRole("button", { name: `Actions for ${MEMBER}, ${daysOf(day)}` }),
					);
					await page.keyboard.press("Enter");
					const menu = page.getByRole("menu");
					await expect(menu.getByRole("menuitem")).toHaveText(["End", "Remove"]);
					await page.keyboard.press("Escape");
					await expect(menu).toBeHidden();

					// Member is the one role offered.
					await tabTo(page, page.getByRole("button", { name: "Assign someone" }));
					await page.keyboard.press("Enter");
					const sheet = page.getByRole("dialog", { name: "Assign someone" });
					await expect(sheet).toBeVisible();
					await tabTo(page, sheet.getByRole("button", { name: /Role/ }));
					await page.keyboard.press("Enter");
					const roles = page.getByRole("listbox", { name: "Role" });
					await expect(roles.getByRole("option")).toHaveText(["Member"]);
					await expectNoProblems(page, "in Assign someone's roles as a delivery manager", [
						UNDER_AN_OVERLAY,
					]);
					await shoot(page, "assign-roles-lead");
					await page.keyboard.press("Escape");
					await expect(roles).toBeHidden();
					await tabTo(page, sheet.getByRole("button", { name: "Cancel" }));
					await page.keyboard.press("Enter");
					await expect(sheet).toBeHidden();

					await assign(
						page,
						OUTSIDER,
						"Member",
						in10,
						`${OUTSIDER} is on the team from ${dayLabel(in10)}.`,
					);
					await expect(team(page).getByRole("listitem")).toHaveCount(4);
					await expectNoProblems(page, "on the Team tab as a delivery manager");
					await shoot(page, "team-tab-lead");
				});
			});

			test.describe("as a member", () => {
				test.use({ storageState: session("member") });

				test("3. sees their own stretch alone and no action, and tracks to the project offered first", async ({
					page,
				}) => {
					await openTeam(page, slug, website);
					const main = page.getByRole("main");
					await expect(main).toContainText(
						"You see your own place on this project's team, not the rest of it.",
					);
					await expect(team(page).getByRole("listitem")).toHaveCount(1);
					await expect(team(page)).toContainText(MEMBER);
					await expect(team(page)).not.toContainText(LEAD);
					await expect(page.getByRole("button", { name: "Assign someone" })).toHaveCount(0);
					await expect(page.getByRole("button", { name: /^Actions for / })).toHaveCount(0);
					await expectNoProblems(page, "on the Team tab as a member");
					await shoot(page, "team-tab-member");

					const sheet = await openTrackTime(page, slug, day);
					const list = await openPicker(page, sheet);
					const first = list.getByRole("group").first();
					await expect(first).toHaveAccessibleName("Your projects");
					await expect(first.getByRole("option", { name: WEBSITE })).toBeVisible();
					await expectNoProblems(page, "in the picker as a member of the team", [UNDER_AN_OVERLAY]);
					await shoot(page, "picker-your-projects");
					await page.keyboard.press("ArrowDown");
					await page.keyboard.press("Enter");
					const picker = sheet.getByRole("combobox", { name: "Project" });
					await expect(picker).toHaveValue(WEBSITE);
					await tabTo(page, sheet.getByRole("textbox", { name: "Hours" }));
					await page.keyboard.type("2");
					await page.keyboard.press("Enter");
					await expect(sheet).toBeHidden();
					await expect(main).toContainText(WEBSITE);
				});
			});

			test.describe("as the owner, on the Timesheet", () => {
				test.use({ storageState: session("owner") });

				test("4. adds themselves to the team from the picker, the entry saves, and a stretch with time is ended, not removed", async ({
					page,
					refusals,
				}) => {
					const sheet = await openTrackTime(page, slug, day);
					const list = await openPicker(page, sheet);
					const apart = list.getByRole("group", { name: "Not on the team" });
					await expect(apart.getByRole("option", { name: WEBSITE })).toBeVisible();
					await expect(list.getByRole("group", { name: "Your projects" })).toHaveCount(0);
					await expectNoProblems(page, "in the picker, not on the team", [UNDER_AN_OVERLAY]);
					await shoot(page, "picker-not-on-team");
					await page.keyboard.type("ACME-001");
					await page.keyboard.press("ArrowDown");
					await page.keyboard.press("Enter");
					const picker = sheet.getByRole("combobox", { name: "Project" });
					await expect(picker).toHaveValue(WEBSITE);

					const note = sheet.getByRole("note").filter({ hasText: JOIN_NOTE });
					await expect(note).toBeVisible();
					await expectNoProblems(page, "with Add me to the team", [UNDER_AN_OVERLAY]);
					await shoot(page, "add-me");
					await tabTo(page, note.getByRole("button", { name: JOIN_LABEL }));
					await page.keyboard.press("Enter");
					await expect(note).toBeHidden();
					await expect(picker).toHaveValue(WEBSITE);
					await tabTo(page, sheet.getByRole("textbox", { name: "Hours" }));
					await page.keyboard.type("1");
					await page.keyboard.press("Enter");
					await expect(sheet).toBeHidden();
					await expect(page.getByRole("main")).toContainText(WEBSITE);

					// Now on the team, the project heads the list.
					const again = await openTrackTime(page, slug, day);
					const mine = await openPicker(page, again);
					const first = mine.getByRole("group").first();
					await expect(first).toHaveAccessibleName("Your projects");
					await expect(first.getByRole("option", { name: WEBSITE })).toBeVisible();
					await page.keyboard.press("Escape");
					await page.keyboard.press("Escape");
					await expect(again).toBeHidden();

					await openTeam(page, slug, website);
					await expect(team(page).getByRole("listitem").filter({ hasText: OWNER })).toContainText(
						`Member · ${daysOf(day)}`,
					);

					// Alan Turing tracked time in his stretch: it is not removed, and is ended instead.
					expectRefusal(refusals, `${projectPath(slug, website)}.data`, 400);
					await act(page, `${MEMBER}, ${daysOf(day)}`, "Remove");
					const remove = page.getByRole("dialog", { name: `Remove ${MEMBER}?` });
					await tabTo(page, remove.getByRole("button", { name: "Remove", exact: true }));
					await page.keyboard.press("Enter");
					await expect(remove.getByRole("alert")).toHaveText(HAS_TIME);
					await expectNoProblems(page, "with a removal refused", [UNDER_AN_OVERLAY]);
					await shoot(page, "refused-remove");
					await tabTo(page, remove.getByRole("button", { name: "Cancel" }));
					await page.keyboard.press("Enter");
					await expect(remove).toBeHidden();

					await act(page, `${MEMBER}, ${daysOf(day)}`, "End");
					const end = page.getByRole("dialog", { name: `End ${MEMBER}'s stretch` });
					const last = end.getByRole("textbox", { name: "Last day" });
					await tabTo(page, last);
					await last.fill(day);
					await submit(
						page,
						end,
						"Save last day",
						`Their last day on the team is ${dayLabel(day)}.`,
					);
					const ended = team(page).getByRole("listitem").last();
					await expect(ended).toContainText(`${MEMBER} (ended)`);
					await expect(ended).toContainText(`Member · ${daysOf(day, day)}`);
					await expectNoProblems(page, "with an ended stretch");
					await shoot(page, "team-tab-ended", ended);
				});
			});

			test.describe("as a member not on the team", () => {
				test.use({ storageState: session("outsider") });

				test("5. is not offered the project on a day they are not on its team, and is told why", async ({
					page,
				}) => {
					const sheet = await openTrackTime(page, slug, day);
					const picker = sheet.getByRole("combobox", { name: "Project" });
					// The field says why projects are missing, and whom to ask.
					await expect(picker).toHaveAccessibleDescription(TEAMS_ONLY);
					await tabTo(page, picker);
					await page.keyboard.type("Website");
					const list = page.getByRole("listbox");
					await expect(list).toContainText("No project matches");
					// The list's empty state is its one row: no option names the project.
					await expect(list.getByRole("option", { name: /Website/ })).toHaveCount(0);
					await expectNoProblems(page, "in the picker, not on any team", [UNDER_AN_OVERLAY]);
					await shoot(page, "refused-not-offered");
				});
			});
		});
	}
}
