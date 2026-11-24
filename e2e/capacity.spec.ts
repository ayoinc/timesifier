import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { destinationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { EMPTY_INPUT, problems } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";

// Team › This week as a capacity table (TS-125, S2-08): each person's week
// against what it expected of them, with a bar and over or under in words,
// ordered by the Sort field into the address. Each test signs in a new owner
// who makes an organisation of their own and gives it people and time straight
// in the database. Every step is done with the keyboard, and every view is
// scanned, at both widths and in both schemes.
//
// With TS125_SHOTS set to a folder, each view is also photographed there.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS * 2 });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

/** A week long past, the same in every zone. */
const WEEK = "2026-01-05";
const SHOTS = process.env.TS125_SHOTS;

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
 * Gives the organisation `slug` three members since 2025 and their week of
 * `WEEK`, on the default week of 37:30: Grace Hopper logs 7:30 each weekday
 * and 2:00 of overtime; Mona Lisa is away Friday afternoon and logs 7:30
 * Monday to Thursday; Linus Torvalds logs 5:00 Monday to Thursday.
 */
function seedWeek(slug: string) {
	const now = Date.now();
	const since = Date.UTC(2025, 0, 1);
	const organisation = `(select id from organisations where slug = '${slug}')`;
	const project = randomUUID();
	const days = ["05", "06", "07", "08", "09"].map((d) => `2026-01-${d}`);
	const entry = (user: string, day: string, from: number, hours: number, overtime = 0) => {
		const start = Date.parse(`${day}T00:00:00Z`) + from * 3_600_000;
		return `insert into time_entries (id, organisation_id, user_id, project_id, started_at, spent_on, ended_at, overtime, created_at, updated_at) values ('${randomUUID()}', ${organisation}, '${user}', '${project}', ${start}, '${day}', ${start + hours * 3_600_000}, ${overtime}, ${now}, ${now})`;
	};
	const member = (id: string, name: string) => [
		`insert into users (id, name, email, email_verified, created_at, updated_at) values ('${id}', '${name}', '${id}@example.com', 1, ${since}, ${since})`,
		`insert into memberships (id, organisation_id, user_id, role, created_at, updated_at) values ('${randomUUID()}', ${organisation}, '${id}', 'member', ${since}, ${since})`,
	];
	const [grace, mona, linus] = [randomUUID(), randomUUID(), randomUUID()];
	sql(
		[
			`insert into projects (id, organisation_id, name, name_key, created_at, updated_at) values ('${project}', ${organisation}, 'Website', 'website', ${now}, ${now})`,
			...member(grace, "Grace Hopper"),
			...member(mona, "Mona Lisa"),
			...member(linus, "Linus Torvalds"),
			...days.map((day) => entry(grace, day, 9, 7.5)),
			entry(grace, "2026-01-09", 16.5, 2, 1),
			...days.slice(0, 4).map((day) => entry(mona, day, 9, 7.5)),
			...days.slice(0, 4).map((day) => entry(linus, day, 9, 5)),
			`insert into leave_requests (id, organisation_id, user_id, kind_id, starts_on, ends_on, starts_half, ends_half, status, created_at, updated_at) values ('${randomUUID()}', ${organisation}, '${mona}', (select id from leave_kinds where organisation_id = ${organisation} and key = 'annual'), '2026-01-09', '2026-01-09', 1, 0, 'approved', ${now}, ${now})`,
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

/** Opens the Select `button` from the keyboard and chooses `option` with the arrows. */
async function choose(page: Page, button: Locator, option: string) {
	await button.focus();
	await page.keyboard.press("Enter");
	const listbox = page.getByRole("listbox");
	await expect(listbox).toBeVisible();
	const choice = listbox.getByRole("option", { name: option, exact: true });
	for (let presses = 0; presses < 5; presses++) {
		if (await choice.evaluate((element) => element === document.activeElement)) break;
		await page.keyboard.press("ArrowDown");
	}
	await expect(choice).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(listbox).toBeHidden();
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });
			const at = `${viewport.width}-${colorScheme}`;

			test("This week reads as a capacity table, sorted from the keyboard", async ({ page }) => {
				const { email } = newPerson();
				await signIn(page, email);
				const { slug } = await createOrganisation(page);
				seedWeek(slug);
				const team = destinationPath(slug, "team");
				const main = page.getByRole("main");
				const people = main.getByRole("list", { name: "People" });
				const row = (name: string) => people.getByRole("listitem").filter({ hasText: name });

				await openShell(page, `${team}?week=${WEEK}`);
				await expect(row("Grace Hopper")).toContainText("39:30");
				await expect(row("Grace Hopper")).toContainText("7:30 + 2:00 overtime");
				await expect(row("Grace Hopper")).toContainText("2:00 over · 105% of capacity");
				await expect(row("Mona Lisa")).toContainText("33:45 expected · 3:45 leave");
				await expect(row("Mona Lisa")).toContainText("3:45 under · 89% of capacity");
				await expect(row("Linus Torvalds")).toContainText("17:30 under · 53% of capacity");
				await expect(main.getByRole("meter", { name: "Grace Hopper's week" })).toHaveAttribute(
					"aria-valuetext",
					"39:30 of 37:30 expected, 2:00 over",
				);
				await expect(main.getByRole("meter", { name: "Mona Lisa's week" })).toBeVisible();
				await check(page, `S2-08-capacity-by-name-${at}`, [EMPTY_INPUT]);

				// Most of capacity first: Grace, Mona, Linus, then the owner who logged nothing.
				await choose(page, main.getByRole("button", { name: /Sort/ }), "Most of capacity");
				await expect(page).toHaveURL(/[?&]sort=share(&|$)/);
				await expect(people.getByRole("listitem").nth(0)).toContainText("Grace Hopper");
				await expect(people.getByRole("listitem").nth(1)).toContainText("Mona Lisa");
				await expect(people.getByRole("listitem").nth(2)).toContainText("Linus Torvalds");
				await check(page, `S2-08-capacity-by-share-${at}`, [EMPTY_INPUT]);

				// The week before keeps the order, from the keyboard.
				const previous = main.getByRole("link", { name: "Previous week" });
				await expect(previous).toHaveAttribute("href", /sort=share/);
				await previous.focus();
				await page.keyboard.press("Enter");
				await expect(page).toHaveURL(/week=2025-12-29.*sort=share/);
				await expect(main.getByRole("button", { name: /Sort/ })).toContainText("Most of capacity");

				// Back, and most remaining: Grace, 2:00 over, comes last.
				await page.goBack();
				await expect(page).toHaveURL(new RegExp(`week=${WEEK}.*sort=share`));
				// The address changes before the week's people are read again, and the
				// bar sends the week it shows: choose once this week is on the page.
				await expect(row("Grace Hopper")).toContainText("2:00 over · 105% of capacity");
				await choose(page, main.getByRole("button", { name: /Sort/ }), "Most remaining");
				await expect(page).toHaveURL(/[?&]sort=remaining(&|$)/);
				await expect(people.getByRole("listitem").last()).toContainText("Grace Hopper");
				await expect(people.getByRole("listitem").nth(1)).toContainText("Linus Torvalds");
				await expect(main).toContainText("Week's total");
				await check(page, `S2-08-capacity-by-remaining-${at}`, [EMPTY_INPUT]);
			});
		});
	}
}
