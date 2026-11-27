import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { projectPath } from "../app/projects/projects";
import { allocationPath, destinationPath, organisationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, setName, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { contrast, EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";
import { zoneIsTheBrowsers } from "./timesheet";

// Time share (TS-116, decision 78) in the browser, at 390px and 1280px wide,
// in light and in dark. Each window size and scheme signs in an owner of a new
// organisation, which is given people, projects, shares and time straight in
// the database:
//
// 1. On a project's Team tab the owner sets a time share by the keyboard, is
//    refused one that overlaps it, changes it from a day, ends it and removes
//    it, then goes to Team › Allocation for the project.
// 2. Team › Allocation lists people by week with over and under in words,
//    narrowed by team, client, project and name, fifty people a page.
// 3. The Timesheet's week shows the owner's plan beside each row's time, and
//    the plan with no row below the grid.
// 4. Reports › Planned sets each person's plan against their time, reached
//    from the report tabs by the keyboard.
//
// Every page is operated with the keyboard and scanned by axe, which finds
// nothing. The seven report tabs are also measured between 600px and 840px,
// where they wrap into rows of three as they do at 390px. The rules are tested
// through the Worker. With TS116_SHOTS set to a folder, each page is
// photographed into it.

const SHOTS = process.env.TS116_SHOTS;
const OWNER = "Ada Lovelace";
const GRACE = "Grace Hopper";
const MONA = "Mona Lisa";
const LINUS = "Linus Torvalds";
/** A week long past, the same in every zone: Monday 5 to Sunday 11 January 2026. */
const WEEK = "2026-01-05";
const WEEK_RANGE = `?range=custom&from=${WEEK}&to=2026-01-11`;
const FILLERS = 49;
/** The owner, Grace, Mona, Linus and the fillers. */
const EVERYONE = 4 + FILLERS;
// The page's own words (app/allocations/allocations.ts), which these files cannot import.
const OVERLAPS =
	"They already have a time share of this on one of those days. End it the day before, or change it from a day.";

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS * 3 });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

/**
 * Runs SQL against the database the test server uses. Two workers writing at
 * once find it locked, so a refused write is tried again.
 */
function sql(command: string): string {
	for (let attempt = 1; ; attempt++) {
		try {
			return execFileSync(
				"pnpm",
				["exec", "wrangler", "d1", "execute", "DB", "--local", "--json", "--command", command],
				{ encoding: "utf8", stdio: "pipe" },
			);
		} catch (error) {
			if (attempt === 5) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * attempt);
		}
	}
}

/**
 * Gives the organisation `slug`, whose owner signed in as `email`, its work:
 * Acme's Website (ACME-001) with work packages WP1 Design and WP2 Build, and
 * Intranet (INT-001) with no client; Grace, Mona and Linus, members since
 * 2025, Grace and Mona in the team Delivery; forty-nine more people. The
 * shares, from 1 December 2025: Grace three days a week of WP2 and half her
 * schedule of Intranet (over-allocated), Mona a day a week of Website, the
 * owner two and a half days a week of WP2 and 7:30 a week of Intranet. In the
 * week of `WEEK`, the owner tracked 3:00 to WP2 on Monday and Grace 7:30.
 */
function seedWork(slug: string, email: string): { website: string } {
	const now = Date.now();
	const since = Date.UTC(2025, 0, 1);
	const organisation = `(select id from organisations where slug = '${slug}')`;
	const owner = `(select id from users where email = '${email}')`;
	const [acme, website, intranet, design, build, delivery] = Array.from({ length: 6 }, () =>
		randomUUID(),
	);
	const [grace, mona, linus] = [randomUUID(), randomUUID(), randomUUID()];
	const member = (id: string, name: string) => [
		`insert into users (id, name, email, email_verified, created_at, updated_at) values ('${id}', '${name}', 'share-${id}@example.com', 1, ${since}, ${since})`,
		`insert into memberships (id, organisation_id, user_id, role, created_at, updated_at) values ('${randomUUID()}', ${organisation}, '${id}', 'member', ${since}, ${since})`,
	];
	const pkg = (id: string, code: string, name: string) =>
		`insert into work_packages (id, organisation_id, project_id, code, code_key, name, created_at, updated_at) values ('${id}', ${organisation}, '${website}', '${code}', '${code.toLowerCase()}', '${name}', ${now}, ${now})`;
	const share = (
		user: string,
		project: string,
		workPackage: string | null,
		amount: number,
		unit: string,
	) =>
		`insert into allocations (id, organisation_id, user_id, project_id, work_package_id, starts_on, amount, unit, created_at, updated_at) values ('${randomUUID()}', ${organisation}, ${user}, '${project}', ${workPackage ? `'${workPackage}'` : "null"}, '2025-12-01', ${amount}, '${unit}', ${now}, ${now})`;
	const entry = (user: string, workPackage: string, hours: number) => {
		const start = Date.parse(`${WEEK}T09:00:00Z`);
		return `insert into time_entries (id, organisation_id, user_id, project_id, work_package_id, started_at, spent_on, ended_at, overtime, created_at, updated_at) values ('${randomUUID()}', ${organisation}, ${user}, '${website}', '${workPackage}', ${start}, '${WEEK}', ${start + hours * 3_600_000}, 0, ${now}, ${now})`;
	};
	const teamMember = (user: string) =>
		`insert into team_members (id, organisation_id, team_id, user_id, created_at, updated_at) values ('${randomUUID()}', ${organisation}, '${delivery}', '${user}', ${now}, ${now})`;
	sql(
		[
			`update organisations set work_model = 'client_projects' where slug = '${slug}'`,
			`update memberships set created_at = ${since} where organisation_id = ${organisation}`,
			`insert into clients (id, organisation_id, name, name_key, code, code_key, created_at, updated_at) values ('${acme}', ${organisation}, 'Acme', 'acme', 'ACME', 'acme', ${now}, ${now})`,
			`insert into projects (id, organisation_id, name, name_key, code, code_key, client_id, created_at, updated_at) values ('${website}', ${organisation}, 'Website', 'website', 'ACME-001', 'acme-001', '${acme}', ${now}, ${now})`,
			`insert into projects (id, organisation_id, name, name_key, code, code_key, created_at, updated_at) values ('${intranet}', ${organisation}, 'Intranet', 'intranet', 'INT-001', 'int-001', ${now}, ${now})`,
			pkg(design, "WP1", "Design"),
			pkg(build, "WP2", "Build"),
			...member(grace, GRACE),
			...member(mona, MONA),
			...member(linus, LINUS),
			...Array.from({ length: FILLERS }, (_, n) =>
				member(randomUUID(), `Yara Example ${String(n + 1).padStart(2, "0")}`),
			).flat(),
			`insert into teams (id, organisation_id, name, name_key, created_at, updated_at) values ('${delivery}', ${organisation}, 'Delivery', 'delivery', ${now}, ${now})`,
			teamMember(grace),
			teamMember(mona),
			share(`'${grace}'`, website, build, 300, "days"),
			share(`'${grace}'`, intranet, null, 5000, "percent"),
			share(`'${mona}'`, website, null, 100, "days"),
			share(owner, website, build, 250, "days"),
			share(owner, intranet, null, 750, "hours"),
			entry(owner, build, 3),
			entry(`'${grace}'`, build, 7.5),
		].join("; "),
	);
	return { website };
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

/** A share's days as its row says them. */
function daysOf(startsOn: string, endsOn: string | null = null): string {
	return endsOn === null ? `From ${rangeLabel(startsOn, startsOn)}` : rangeLabel(startsOn, endsOn);
}

/** Presses Tab until `target` has the focus: the way a person without a pointer gets there. */
async function tabTo(page: Page, target: Locator, most = 120) {
	for (let step = 0; step < most; step++) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press("Tab");
	}
	await expect(target).toBeFocused();
}

/** Opens a Select by the keyboard and chooses `option` in it, typed to. */
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

/** The project's time shares on its Team tab. */
const shares = (page: Page) => page.getByRole("list", { name: "Time shares of the project" });

/** Opens the Actions menu of the share whose button starts so and ends with `days`, by the keyboard, and chooses `item`. */
async function act(page: Page, of: string, days: string, item: string) {
	const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	await tabTo(
		page,
		page.getByRole("button", {
			name: new RegExp(`^Actions for ${escaped(of)}'s time share, .*, ${escaped(days)}$`),
		}),
	);
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

/** Types into a field reached by the keyboard. */
async function typeInto(page: Page, field: Locator, text: string) {
	await tabTo(page, field);
	await field.fill(text);
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const scheme of ["light", "dark"] as const) {
		test.describe(`${viewport.width}px wide, ${scheme}`, () => {
			test.use({ viewport, chosenScheme: scheme });

			/** Photographs the page as `what`, `subject` in view, when TS116_SHOTS asks for it. */
			async function shoot(page: Page, what: string, subject?: Locator) {
				if (!SHOTS) return;
				await subject?.evaluate((element) => element.scrollIntoView({ block: "center" }));
				mkdirSync(SHOTS, { recursive: true });
				await page.screenshot({
					path: join(SHOTS, `${what}-${viewport.width}-${scheme}.png`),
					fullPage: !subject,
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
				const texts = dialog.locator("p, label span, legend, h2").filter({ hasText: /\S/ });
				for (const text of await texts.all()) {
					if (!(await text.isVisible())) continue;
					expect(
						await contrast(text),
						`contrast of "${await text.textContent()}" ${state}`,
					).toBeGreaterThanOrEqual(4.5);
				}
			}

			test("time shares on the Team tab, Allocation, the Timesheet's plan and Reports › Planned, by keyboard", async ({
				page,
			}) => {
				const { email } = newPerson();
				await signIn(page, email);
				const { slug } = await createOrganisation(page);
				await setName(page, OWNER);
				await zoneIsTheBrowsers(page, slug);
				const { website } = seedWork(slug, email);
				const main = page.getByRole("main");
				const today = new Date().toISOString().slice(0, 10);
				const [in7, in13, in14, in20] = [7, 13, 14, 20].map((n) => plusDays(today, n));

				// 1. The Team tab: set, refused an overlap, change from a day, end, remove.
				await openShell(page, projectPath(slug, website, "team"));
				await expect(shares(page).getByRole("listitem")).toHaveCount(3);
				await expect(shares(page).getByRole("listitem").filter({ hasText: GRACE })).toContainText(
					"WP2 · Build · 3 days a week",
				);
				await expectNoProblems(page, "on the Team tab with its shares");
				await shoot(page, "team-tab-shares", shares(page));

				await tabTo(page, main.getByRole("button", { name: "Set a time share", exact: true }));
				await page.keyboard.press("Enter");
				const set = page.getByRole("dialog", { name: "Set a time share" });
				await expect(set).toBeVisible();
				const picker = set.getByRole("combobox", { name: "Person" });
				await tabTo(page, picker);
				await page.keyboard.type("Lin");
				await expect(
					page.getByRole("listbox", { name: "Person" }).getByRole("option", { name: LINUS }),
				).toBeVisible();
				await page.keyboard.press("ArrowDown");
				await page.keyboard.press("Enter");
				await expect(picker).toHaveValue(LINUS);
				await choose(
					page,
					set.getByRole("button", { name: /Work package/ }),
					"Work package",
					"WP1 · Design",
				);
				await typeInto(page, set.getByRole("textbox", { name: "Amount" }), "2.5");
				await typeInto(page, set.getByRole("textbox", { name: "First day" }), in7);
				await expectNoProblems(page, "in Set a time share");
				await shoot(page, "set-share-sheet");
				await submit(
					page,
					set,
					"Set time share",
					`${LINUS}: 2.5 days a week from ${dayLabel(in7)}.`,
				);
				await expect(shares(page).getByRole("listitem").filter({ hasText: LINUS })).toContainText(
					`WP1 · Design · 2.5 days a week · ${daysOf(in7)}`,
				);

				// The same line again, from a later day: refused, and why.
				await tabTo(page, main.getByRole("button", { name: "Set a time share", exact: true }));
				await page.keyboard.press("Enter");
				await expect(set).toBeVisible();
				await tabTo(page, picker);
				await page.keyboard.type("Lin");
				await page.keyboard.press("ArrowDown");
				await page.keyboard.press("Enter");
				await expect(picker).toHaveValue(LINUS);
				await choose(
					page,
					set.getByRole("button", { name: /Work package/ }),
					"Work package",
					"WP1 · Design",
				);
				await typeInto(page, set.getByRole("textbox", { name: "Amount" }), "1");
				await typeInto(page, set.getByRole("textbox", { name: "First day" }), in14);
				await tabTo(page, set.getByRole("button", { name: "Set time share", exact: true }));
				await page.keyboard.press("Enter");
				await expect(set).toContainText(OVERLAPS);
				await expectNoProblems(page, "in Set a time share, refused");
				await shoot(page, "set-share-refused");
				await page.keyboard.press("Escape");
				await expect(set).toBeHidden();

				await act(page, LINUS, daysOf(in7), "Change from a day");
				const change = page.getByRole("dialog", { name: `Change ${LINUS}'s time share` });
				await expect(change).toBeVisible();
				await expect(change.getByRole("textbox", { name: "New amount" })).toHaveValue("2.5");
				await typeInto(page, change.getByRole("textbox", { name: "New amount" }), "3");
				await typeInto(page, change.getByRole("textbox", { name: "From" }), in14);
				await expectNoProblems(page, "in Change time share");
				await shoot(page, "change-share-sheet");
				await submit(page, change, "Change time share", `From ${dayLabel(in14)}, 3 days a week.`);
				await expect(shares(page)).toContainText(`2.5 days a week · ${daysOf(in7, in13)}`);
				await expect(shares(page)).toContainText(`3 days a week · ${daysOf(in14)}`);

				await act(page, LINUS, daysOf(in14), "End");
				const end = page.getByRole("dialog", { name: `End ${LINUS}'s time share` });
				await expect(end).toBeVisible();
				await typeInto(page, end.getByRole("textbox", { name: "Last day" }), in20);
				await expectNoProblems(page, "in End time share");
				await shoot(page, "end-share-sheet");
				await submit(page, end, "Save last day", `The time share's last day is ${dayLabel(in20)}.`);
				await expect(shares(page)).toContainText(`3 days a week · ${daysOf(in14, in20)}`);

				await act(page, LINUS, daysOf(in7, in13), "Remove");
				const remove = page.getByRole("dialog", { name: `Remove ${LINUS}'s time share?` });
				await expect(remove).toBeVisible();
				await expectNoProblems(page, "in Remove time share");
				await shoot(page, "remove-share-sheet");
				await submit(page, remove, "Remove", "Time share removed.");
				await expect(shares(page).getByRole("listitem")).toHaveCount(4);
				await expect(shares(page)).not.toContainText(daysOf(in7, in13));

				// From the Team tab to the project's allocation.
				await tabTo(page, main.getByRole("link", { name: "Allocation by week" }));
				await page.keyboard.press("Enter");
				await expect(page).toHaveURL(`${allocationPath(slug)}?project=${website}`);
				await expect(main.getByRole("heading", { level: 1 })).toHaveText("Team");

				// 2. Team › Allocation, the week of `WEEK` and the three after.
				const people = main.getByRole("list", { name: "People by week" });
				const person = (name: string) =>
					people.getByRole("listitem").filter({ hasText: name }).first();
				const firstWeek = (name: string) =>
					main
						.getByRole("list", { name: `${name}'s weeks` })
						.getByRole("listitem")
						.first();
				await openShell(page, `${allocationPath(slug)}?week=${WEEK}`);
				const pages = main.getByRole("navigation", { name: "Pages of people" });
				await expect(pages).toContainText(`1–50 of ${EVERYONE}`);
				await expect(firstWeek(GRACE)).toContainText("Over-allocated by 3:45");
				await expect(firstWeek(GRACE)).toContainText("Planned 41:15 · Tracked 7:30");
				await expect(firstWeek(GRACE)).toContainText(
					"ACME-001 · Website › WP2 Build: 22:30 planned, 7:30 tracked",
				);
				await expect(firstWeek(MONA)).toContainText("Under-allocated: 30:00 free");
				await expect(firstWeek(OWNER)).toContainText("Under-allocated: 11:15 free");
				await expect(firstWeek(LINUS)).toContainText("Under-allocated: nothing planned");
				await expectNoProblems(page, "on Allocation", [EMPTY_INPUT]);
				await shoot(page, "allocation", person(GRACE));

				// Fifty a page: the second has the last three.
				await tabTo(page, pages.getByRole("link", { name: "Next 3" }));
				await page.keyboard.press("Enter");
				await expect(page).toHaveURL(/[?&]page=2(&|$)/);
				await expect(pages).toContainText(`51–53 of ${EVERYONE}`);
				await expect(
					people.getByRole("listitem").filter({ has: page.getByRole("list") }),
				).toHaveCount(3);
				await expectNoProblems(page, "on Allocation's second page", [EMPTY_INPUT]);

				// By team: Grace and Mona.
				await openShell(page, `${allocationPath(slug)}?week=${WEEK}`);
				await choose(page, main.getByRole("button", { name: /Team/ }), "Team", "Delivery");
				await expect(page).toHaveURL(/[?&]team=/);
				await expect(main).toContainText(`2 of ${EVERYONE}`);
				await expect(person(GRACE)).toBeVisible();
				await expect(person(MONA)).toBeVisible();
				await expect(people).not.toContainText(LINUS);
				await expectNoProblems(page, "on Allocation by team", [EMPTY_INPUT]);
				await shoot(page, "allocation-by-team");

				// By client, then by project: those planned on them.
				await choose(page, main.getByRole("button", { name: /Team/ }), "Team", "Every team");
				await choose(page, main.getByRole("button", { name: /Client/ }), "Client", "Acme");
				await expect(page).toHaveURL(/[?&]client=/);
				await expect(person(GRACE)).toBeVisible();
				await expect(person(OWNER)).toBeVisible();
				await expect(people).not.toContainText(LINUS);
				await choose(page, main.getByRole("button", { name: /Client/ }), "Client", "Every client");
				await choose(
					page,
					main.getByRole("button", { name: /Project/ }),
					"Project",
					"INT-001 · Intranet",
				);
				await expect(page).toHaveURL(/[?&]project=/);
				await expect(person(GRACE)).toBeVisible();
				await expect(person(OWNER)).toBeVisible();
				await expect(people).not.toContainText(MONA);
				await expectNoProblems(page, "on Allocation by project", [EMPTY_INPUT]);
				await choose(
					page,
					main.getByRole("button", { name: /Project/ }),
					"Project",
					"Every project",
				);

				// By name.
				const search = main.getByRole("searchbox", { name: "Search people" });
				await tabTo(page, search);
				await page.keyboard.type("Mona");
				await page.keyboard.press("Enter");
				await expect(page).toHaveURL(/[?&]q=Mona(&|$)/);
				await expect(main).toContainText(`1 of ${EVERYONE}`);
				await expect(person(MONA)).toBeVisible();
				await expectNoProblems(page, "on Allocation by name");
				await shoot(page, "allocation-by-name");

				// 3. The Timesheet's week: the plan under WP2's row, and Intranet's below the grid.
				await openShell(page, `${organisationPath(slug)}?view=week&start=${WEEK}`);
				await expect(main).toContainText("WP2: 18:45 planned, 3:00 tracked");
				const below = main.getByRole("list", { name: "Planned this week" });
				await expect(below).toContainText("INT-001 · Intranet: 7:30 planned, 0:00 tracked");
				await tabTo(page, main.getByRole("link", { name: /Next week/ }));
				await expectNoProblems(page, "on the Timesheet's week", [EMPTY_INPUT]);
				await shoot(page, "timesheet-plan", below);

				// 4. Reports › Planned, from Time's tabs.
				await openShell(page, `${destinationPath(slug, "reports")}${WEEK_RANGE}`);
				const tabs = main.getByRole("group", { name: "Report views" });
				await tabTo(page, tabs.getByRole("link", { name: "Planned", exact: true }));
				await page.keyboard.press("Enter");
				await expect(page).toHaveURL(`${destinationPath(slug, "reports")}/planned${WEEK_RANGE}`);
				await expect(tabs.getByRole("link", { name: "Planned", exact: true })).toHaveAttribute(
					"aria-current",
					"page",
				);
				const byPerson = main.getByRole("list", { name: "Planned against tracked by person" });
				await expect(byPerson.getByRole("listitem").filter({ hasText: GRACE })).toContainText(
					"41:15 planned, 7:30 tracked",
				);
				await expect(byPerson.getByRole("listitem").filter({ hasText: OWNER })).toContainText(
					"26:15 planned, 3:00 tracked",
				);
				await expect(
					main.getByRole("list", { name: "Planned against tracked by project" }),
				).toContainText("INT-001 · Intranet");
				await expectNoProblems(page, "on Reports › Planned", [EMPTY_INPUT]);
				await shoot(page, "reports-planned");
			});
		});
	}
}

// The seven report tabs, between the compact window and the expanded one: in
// rows of three, as at 390px, every tab whole and in view.
for (const width of [390, 600, 720, 839]) {
	test(`the seven report tabs wrap into rows of three, ${width}px wide`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await signIn(page, newPerson().email);
		const { slug } = await createOrganisation(page);
		await openShell(page, `${destinationPath(slug, "reports")}/planned${WEEK_RANGE}`);
		const tabs = page.getByRole("main").getByRole("group", { name: "Report views" });
		const links = tabs.getByRole("link");
		await expect(links).toHaveCount(7);
		const row = await tabs.boundingBox();
		if (!row) throw new Error("no row of tabs");
		const tops: number[] = [];
		for (const link of await links.all()) {
			const box = await link.boundingBox();
			if (!box) throw new Error("a tab has no box");
			expect(box.x).toBeGreaterThanOrEqual(row.x - 0.5);
			expect(box.x + box.width).toBeLessThanOrEqual(row.x + row.width + 0.5);
			// The label is whole: nothing of it is cut off.
			expect(await link.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
			tops.push(Math.round(box.y));
		}
		expect(await tabs.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
		const rows = [...new Set(tops)];
		expect(rows).toHaveLength(3);
		expect(rows.map((top) => tops.filter((t) => t === top).length)).toEqual([3, 3, 1]);
		if (SHOTS && width !== 390) {
			mkdirSync(SHOTS, { recursive: true });
			await page.screenshot({ path: join(SHOTS, `report-tabs-${width}.png`) });
		}
	});
}
