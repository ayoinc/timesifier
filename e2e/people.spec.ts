import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";

import { destinationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { contrast, EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";

// Team and Approvals (TS-038, TS-045, TS-047), in an organisation of the
// test's own so nothing here changes what the other tests see: a new person
// signs in and creates it, and a second new person, written straight to the
// database, joins it with a submitted week.
// Each view is scanned at both window sizes, and the work is done with the
// keyboard alone.

/** A week long past, so it has closed wherever the browser is. */
const WEEK = "2026-01-05";

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

/** The member every test's organisation gets. */
const member = { name: "Grace Hopper" };

/** A new person joins `slug` as a member and submits the week of `WEEK` there, with a day of time. */
function memberSubmitsWeek(slug: string) {
	const now = Date.now();
	const userId = randomUUID();
	const user = `'${userId}'`;
	const organisation = `(select id from organisations where slug = '${slug}')`;
	const project = randomUUID();
	sql(
		[
			`insert into users (id, name, email, email_verified, created_at, updated_at) values (${user}, '${member.name}', 'grace-${userId}@example.com', 1, ${now}, ${now})`,
			`insert into memberships (id, organisation_id, user_id, role, created_at, updated_at) values ('${randomUUID()}', ${organisation}, ${user}, 'member', ${now}, ${now})`,
			`insert into projects (id, organisation_id, name, name_key, created_at, updated_at) values ('${project}', ${organisation}, 'Website', 'website', ${now}, ${now})`,
			`insert into time_entries (id, organisation_id, user_id, project_id, description, started_at, ended_at, created_at, updated_at) values ('${randomUUID()}', ${organisation}, ${user}, '${project}', 'Copy', ${Date.parse("2026-01-06T10:00:00Z")}, ${Date.parse("2026-01-06T17:30:00Z")}, ${now}, ${now})`,
			`insert into periods (id, organisation_id, user_id, starts_on, ends_on, status, submitted_at, created_at, updated_at) values ('${randomUUID()}', ${organisation}, ${user}, '${WEEK}', '2026-01-11', 'submitted', ${now}, ${now}, ${now})`,
		].join("; "),
	);
}

/** A new person signs in and creates an organisation, which a member joins with a submitted week. */
async function ownOrganisationWithAWeek(page: Page): Promise<string> {
	await signIn(page, newPerson().email);
	const { slug } = await createOrganisation(page);
	memberSubmitsWeek(slug);
	return slug;
}

async function expectNoProblems(page: Page, heading: string, unmeasurable: string[] = []) {
	await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
	expect(await problems(page, unmeasurable), `problems in "${heading}"`).toEqual([]);
}

async function expectNoProblemsInSheet(page: Page, name: string, text: string) {
	const sheet = page.getByRole("dialog", { name });
	await expect(sheet).toBeVisible();
	expect(
		await problems(page, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS, EMPTY_INPUT]),
		`problems with "${name}" open`,
	).toEqual([]);
	expect(await contrast(sheet.getByText(text))).toBeGreaterThanOrEqual(4.5);
}

/**
 * Puts the focus on `name`'s control, as Tab would, and shows it has it: the
 * page's own order is walked by the keyboard specs of the shell.
 */
async function focusOn(page: Page, role: "button" | "link", name: string) {
	const target = page.getByRole("main").getByRole(role, { name, exact: true });
	await target.focus();
	await expect(target).toBeFocused();
}

/**
 * Chooses `option` in the Select labelled `label` with the keyboard: the
 * focus on its button, Enter opens the list, typing moves to the option and
 * Enter takes it.
 */
async function choose(page: Page, label: string, option: string) {
	const field = page.getByRole("main").getByRole("button", { name: new RegExp(` ${label}$`) });
	await field.focus();
	await expect(field).toBeFocused();
	await page.keyboard.press("Enter");
	const listbox = page.getByRole("listbox", { name: label });
	await expect(listbox).toBeVisible();
	await page.keyboard.type(option.slice(0, 3));
	await expect(listbox.getByRole("option", { name: option })).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(listbox).toBeHidden();
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	test.describe(`in a window ${viewport.width}px wide`, () => {
		test.use({ viewport, storageState: SIGNED_OUT });
		test.beforeEach(async ({ context, baseURL }) => {
			await ownAddress(context, baseURL);
		});
		// Each test seeds its organisation through wrangler, which takes seconds.
		test.setTimeout(120_000);

		test("Team: this week, one person's week, and the teams, with the keyboard", async ({
			page,
		}) => {
			const slug = await ownOrganisationWithAWeek(page);
			const team = destinationPath(slug, "team");

			await openShell(page, `${team}?week=${WEEK}`);
			// The filter field is empty: its text's contrast is measured once it has some.
			await expectNoProblems(page, "Team", [EMPTY_INPUT]);
			await expect(page.getByText("5 to 11 January 2026").first()).toBeVisible();
			// The week's total stands above the people.
			await expect(page.getByText(/^Week's total\s*7:30$/)).toBeVisible();

			// A filter by name, kept in the address, narrows the people and the total.
			const filter = page.getByRole("searchbox", { name: "Filter by name" });
			await filter.focus();
			await page.keyboard.type("nobody");
			await page.keyboard.press("Enter");
			await expect(page).toHaveURL(`${team}?week=${WEEK}&q=nobody`);
			await expect(page.getByText("Nobody's name or address holds “nobody”.")).toBeVisible();
			await expectNoProblems(page, "Team");
			await focusOn(page, "link", "Show everyone");
			await page.keyboard.press("Enter");
			await expect(page).toHaveURL(`${team}?week=${WEEK}`);
			await filter.focus();
			await page.keyboard.type("grace");
			await page.keyboard.press("Enter");
			await expect(page).toHaveURL(`${team}?week=${WEEK}&q=grace`);
			await expect(page.getByText(/^Total for “grace”\s*7:30$/)).toBeVisible();
			await expectNoProblems(page, "Team");

			// Opening a person shows their week, to read.
			await focusOn(page, "link", member.name);
			await page.keyboard.press("Enter");
			await expect(page.getByRole("heading", { level: 1, name: member.name })).toBeVisible();
			await expect(page.getByText("Tuesday 6 January")).toBeVisible();
			await expectNoProblems(page, member.name);

			// The teams: make one, put the member in it as its manager.
			await openShell(page, `${team}?show=teams`);
			await expectNoProblems(page, "Teams");
			await focusOn(page, "button", "New team");
			await page.keyboard.press("Enter");
			await expectNoProblemsInSheet(page, "New team", "Name");
			await page.keyboard.type("Design");
			await page.keyboard.press("Enter");
			await expect(page.getByRole("status")).toHaveText("Team Design created.");

			await focusOn(page, "button", "Add a person to Design");
			await page.keyboard.press("Enter");
			await expectNoProblemsInSheet(page, "Add a person to Design", "Manages this team");
			const dialog = page.getByRole("dialog", { name: "Add a person to Design" });
			await dialog.getByRole("button", { name: /Person/ }).focus();
			await page.keyboard.press("Enter");
			await page.getByRole("option", { name: member.name }).press("Enter");
			await dialog.getByRole("checkbox", { name: "Manages this team" }).press("Space");
			await dialog.getByRole("button", { name: "Add", exact: true }).press("Enter");
			await expect(page.getByRole("status")).toHaveText("Added to the team as its manager.");
			await expect(page.getByText("Manager", { exact: true })).toBeVisible();
			await expectNoProblems(page, "Teams");
		});

		test("Approvals: pending, approve with the keyboard, then each status and grouping", async ({
			page,
		}) => {
			const slug = await ownOrganisationWithAWeek(page);

			await openShell(page, `${destinationPath(slug, "approvals")}?week=${WEEK}`);
			// The link counts what waits.
			await expect(
				page.getByRole("navigation").getByRole("link", { name: "Approvals 1 pending" }),
			).toBeVisible();
			await expectNoProblems(page, "Approvals");
			await expect(page.getByText("5 to 11 January 2026").first()).toBeVisible();

			await focusOn(page, "button", `Return ${member.name}'s timesheet`);
			await page.keyboard.press("Enter");
			await expectNoProblemsInSheet(page, `Return ${member.name}'s timesheet`, "They read this");
			await page.keyboard.press("Escape");

			await focusOn(page, "button", `Approve ${member.name}'s timesheet`);
			await page.keyboard.press("Enter");
			await expectNoProblemsInSheet(
				page,
				`Approve ${member.name}'s timesheet?`,
				"Its entries stay locked",
			);
			await page
				.getByRole("dialog")
				.getByRole("button", { name: "Approve", exact: true })
				.press("Enter");
			await expect(page.getByRole("status")).toHaveText("Timesheet approved.");
			await expect(
				page.getByRole("navigation").getByRole("link", { name: "Approvals", exact: true }),
			).toBeVisible();

			// The status and the grouping are chosen with the keyboard, and kept in the address.
			await choose(page, "Status", "Approved (1)");
			await focusOn(page, "button", "Show");
			await page.keyboard.press("Enter");
			await expect(page).toHaveURL(
				`${destinationPath(slug, "approvals")}?week=${WEEK}&status=approved&group=person`,
			);
			await expect(page.getByText(/^Total\s*7:30$/)).toBeVisible();
			await expectNoProblems(page, "Approvals");

			// The owner reopens it with a reason.
			await focusOn(page, "button", `Reopen ${member.name}'s timesheet`);
			await page.keyboard.press("Enter");
			await expectNoProblemsInSheet(
				page,
				`Reopen ${member.name}'s timesheet`,
				"It goes back to them",
			);
			await page.keyboard.type("Wrong project on Tuesday.");
			await page.keyboard.press("Enter");
			await expect(page.getByRole("status")).toHaveText(
				"Timesheet reopened. It is back with them to change.",
			);

			await choose(page, "Status", "Returned (1)");
			await choose(page, "Group by", "Project");
			await focusOn(page, "button", "Show");
			await page.keyboard.press("Enter");
			await expect(page).toHaveURL(
				`${destinationPath(slug, "approvals")}?week=${WEEK}&status=returned&group=project`,
			);
			await expect(page.getByRole("list", { name: "Returned, by project" })).toContainText(
				"Website",
			);
			await expect(page.getByText(/^Total\s*7:30$/)).toBeVisible();
			await expectNoProblems(page, "Approvals");

			// An address of the tabs Approvals had opens on its status.
			await openShell(page, `${destinationPath(slug, "approvals")}?week=${WEEK}&tab=not-submitted`);
			await expect(page).toHaveURL(
				`${destinationPath(slug, "approvals")}?week=${WEEK}&status=not-submitted`,
			);
			await expectNoProblems(page, "Approvals");
		});
	});
}
