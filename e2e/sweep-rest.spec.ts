import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { destinationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { contrast, EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";

// The rest of Harvest sweep 2 (TS-122): a budget's progress on Projects
// (S2-07), duplicating a project (S2-06), pinning projects and people (S2-09)
// and Approvals' empty week naming who has not submitted (S2-12). Each test
// signs in a new owner who makes an organisation of their own, and gives it
// projects, people and time straight in the database. Every step is done with
// the keyboard, and every view is scanned, at both widths and in both schemes.
//
// With TS122_SHOTS set to a folder, each view is also photographed there.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS * 2 });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

/** A week long past: it has closed, so who has not submitted it is known. */
const WEEK = "2026-01-05";
const SHOTS = process.env.TS122_SHOTS;

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
 * Gives the organisation `slug` three projects, Atlas with a budget of 10:00
 * that warns at 60% and 7:00 of the owner's time on it, Website and Payroll;
 * and three members since 2025 who have not submitted the week of `WEEK`.
 */
function seedOrganisation(slug: string, email: string) {
	const now = Date.now();
	const since = Date.UTC(2025, 0, 1);
	const organisation = `(select id from organisations where slug = '${slug}')`;
	const atlas = randomUUID();
	const project = (id: string, name: string, budget = "") =>
		`insert into projects (id, organisation_id, name, name_key, ${budget ? "budget_kind, budget_amount, budget_alert_percent, " : ""}created_at, updated_at) values ('${id}', ${organisation}, '${name}', '${name.toLowerCase()}', ${budget}${now}, ${now})`;
	const started = now - 8 * 3_600_000;
	const member = (name: string) => {
		const id = randomUUID();
		return [
			`insert into users (id, name, email, email_verified, created_at, updated_at) values ('${id}', '${name}', '${id}@example.com', 1, ${since}, ${since})`,
			`insert into memberships (id, organisation_id, user_id, role, created_at, updated_at) values ('${randomUUID()}', ${organisation}, '${id}', 'member', ${since}, ${since})`,
		];
	};
	sql(
		[
			project(atlas, "Atlas", "'total_hours', 600, 60, "),
			project(randomUUID(), "Website"),
			project(randomUUID(), "Payroll"),
			`insert into time_entries (id, organisation_id, user_id, project_id, description, started_at, spent_on, ended_at, created_at, updated_at) values ('${randomUUID()}', ${organisation}, (select id from users where email = '${email}'), '${atlas}', 'Drawings', ${started}, '${new Date(started).toLocaleDateString("en-CA")}', ${started + 7 * 3_600_000}, ${now}, ${now})`,
			...member("Grace Hopper"),
			...member("Linus Torvalds"),
			...member("Mona Lisa"),
		].join("; "),
	);
}

/** Scans the page, and photographs it first when shots are asked for. */
async function check(page: Page, shot: string, unmeasurable: string[] = []) {
	const found = await problems(page, unmeasurable);
	if (SHOTS) {
		mkdirSync(SHOTS, { recursive: true });
		await page.screenshot({ path: join(SHOTS, `${shot}.png`), fullPage: true });
	}
	expect(found, `problems in ${shot}`).toEqual([]);
}

/** Opens the row's Actions menu from the keyboard and chooses `item`. */
async function chooseFromActions(page: Page, actions: Locator, item: string) {
	await actions.focus();
	await page.keyboard.press("Enter");
	const menu = page.getByRole("menu");
	await expect(menu).toBeVisible();
	const choice = menu.getByRole("menuitem", { name: item, exact: true });
	for (let presses = 0; presses < 4; presses++) {
		if (await choice.evaluate((element) => element === document.activeElement)) break;
		await page.keyboard.press("ArrowDown");
	}
	await expect(choice).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(menu).toBeHidden();
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });
			const at = `${viewport.width}-${colorScheme}`;

			test("budgets, duplicate, pins and the empty week, by keyboard", async ({ page }) => {
				const { email } = newPerson();
				await signIn(page, email);
				const { slug } = await createOrganisation(page);
				seedOrganisation(slug, email);
				const projects = destinationPath(slug, "projects");
				const main = page.getByRole("main");
				const status = main.getByRole("status").first();

				// S2-07: the budget's progress, in words past its alert.
				await openShell(page, projects);
				await expect(main.getByRole("list", { name: "Active projects" })).toContainText(
					"70% of 10:00 · 3:00 left · past the 60% alert",
				);
				await expect(main.getByRole("meter", { name: "Budget of Atlas spent" })).toBeVisible();
				await check(page, `S2-07-projects-budget-${at}`, [EMPTY_INPUT]);

				// S2-09: Website pinned from its Actions; it heads the list, and its
				// Actions keeps the focus once it has moved.
				const websiteActions = main.getByRole("button", { name: "Actions for Website" });
				await chooseFromActions(page, websiteActions, "Pin");
				await expect(status).toHaveText("Project pinned to the top.");
				const pinned = main.getByRole("list", { name: "Active projects: Pinned" });
				await expect(pinned).toContainText("Website");
				await expect(main.getByRole("heading", { level: 2 }).first()).toHaveText("Pinned");
				await expect(websiteActions).toBeFocused();
				await check(page, `S2-09-projects-pinned-${at}`, [EMPTY_INPUT]);

				// S2-06: Atlas duplicated from its Actions.
				await chooseFromActions(
					page,
					main.getByRole("button", { name: "Actions for Atlas" }),
					"Duplicate",
				);
				const sheet = page.getByRole("dialog", { name: "Duplicate Atlas" });
				await expect(sheet.getByRole("textbox", { name: "Project name" })).toHaveValue(
					"Atlas (copy)",
				);
				// The sheet lies over the page: its own text is measured apart.
				await check(page, `S2-06-duplicate-sheet-${at}`, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS]);
				expect(await contrast(sheet.getByText("The copy has the client"))).toBeGreaterThanOrEqual(
					4.5,
				);
				await sheet.getByRole("button", { name: "Duplicate project" }).focus();
				await page.keyboard.press("Enter");
				await expect(sheet).toBeHidden();
				await expect(status).toHaveText("Project duplicated: Atlas (copy).");
				await expect(main.getByRole("link", { name: "Atlas (copy)" })).toBeVisible();
				await check(page, `S2-06-duplicated-${at}`, [EMPTY_INPUT]);

				// S2-09: the pinned project first in Track time's picker.
				await openShell(page, projects);
				// The navigation's at 1280px; a floating button at 390px.
				const trackTime = page.getByRole("button", { name: "Track time", exact: true }).first();
				await trackTime.focus();
				await page.keyboard.press("Enter");
				const track = page.getByRole("dialog", { name: "Track time" });
				const picker = track.getByRole("combobox", { name: "Project" });
				await expect(picker).toBeFocused();
				await page.keyboard.press("ArrowDown");
				const listbox = page.getByRole("listbox");
				await expect(listbox.locator("header").first()).toHaveText("Pinned");
				await expect(listbox.getByRole("group").first()).toContainText("Website");
				await check(page, `S2-09-track-time-picker-${at}`, [
					UNDER_AN_OVERLAY,
					OVER_SEVERAL_ELEMENTS,
					EMPTY_INPUT,
				]);
				expect(await contrast(listbox.locator("header").first())).toBeGreaterThanOrEqual(4.5);
				await page.keyboard.press("Escape");
				await page.keyboard.press("Escape");
				await expect(track).toBeHidden();

				// S2-09: Mona pinned to the top of Team's This week.
				await openShell(page, destinationPath(slug, "team"));
				const people = main.getByRole("list", { name: "People" });
				await expect(people.getByRole("listitem").first()).not.toContainText("Mona Lisa");
				const monaActions = main.getByRole("button", { name: "Actions for Mona Lisa" });
				await chooseFromActions(page, monaActions, "Pin");
				await expect(status).toHaveText("Pinned to the top of This week.");
				await expect(people.getByRole("listitem").first()).toContainText("Mona Lisa");
				await expect(people.getByRole("listitem").first()).toContainText("Pinned");
				await expect(monaActions).toBeFocused();
				await check(page, `S2-09-team-pinned-${at}`, [EMPTY_INPUT]);

				// S2-12: the closed week's empty Pending names who has not submitted.
				const approvals = destinationPath(slug, "approvals");
				await openShell(page, `${approvals}?week=${WEEK}&status=pending`);
				await expect(main).toContainText(
					"Nothing is waiting for you this week. 3 people have not submitted: Grace Hopper, Linus Torvalds and Mona Lisa.",
				);
				await check(page, `S2-12-approvals-empty-week-${at}`);
				await main.getByRole("link", { name: "Show them" }).focus();
				await page.keyboard.press("Enter");
				await expect(page).toHaveURL(new RegExp(`week=${WEEK}&status=not-submitted`));
				await expect(main).toContainText("Not submitted (3)");
				await check(page, `S2-12-approvals-not-submitted-${at}`);
			});
		});
	}
}
