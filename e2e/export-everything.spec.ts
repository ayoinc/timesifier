import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { everythingDownloadPath, everythingExportPath } from "../app/exports/paths";
import { destinationPath } from "../app/shell/destinations";
import {
	foundInMessageSentBy,
	newPerson,
	ownAddress,
	signIn,
	signOut,
	TIME_WITH_TURNS,
} from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";

// The export of everything (TS-126, decision 71). An owner asks for it, sees
// it being made, then ready, is emailed and finds the notice in the bell
// (TS-126b), downloads it, and sees it expire; an admin of the
// same organisation is never shown it. The job's later steps are run by the
// Worker's own scheduled handler, as the every-minute and hourly triggers run
// it, through Miniflare's trigger endpoint. Every step is done with the
// keyboard, and every view is scanned, at both widths and in both schemes.
//
// With TS126_SHOTS set to a folder, each view is also photographed there.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS * 3 });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

const SHOTS = process.env.TS126_SHOTS;

/** The triggers, as wrangler.jsonc and workers/scheduled.ts name them; that module runs only in the Worker. */
const EVERY_MINUTE = "* * * * *";
const HOURLY = "0 * * * *";

/**
 * Expenses with a receipt named: more than one step's 400 reads and writes
 * (EXPORT_LIMITS.stepCalls), so the step the request runs leaves the export
 * being made, and the trigger's next step finishes it. Their receipts are not
 * in R2; the export looks each one up all the same.
 */
const EXPENSES_WITH_RECEIPTS = 450;

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

/** The first row's first value of `query`. */
function value(query: string): unknown {
	const [result] = JSON.parse(sql(query)) as { results: Record<string, unknown>[] }[];
	const row = result?.results[0];
	return row ? Object.values(row)[0] : undefined;
}

/**
 * Gives the organisation `slug` a project and the expenses above, all the
 * owner's, in its starter category Travel, and an admin, `admin`, who has an
 * account and has never signed in.
 */
function seedOrganisation(slug: string, owner: string, admin: string) {
	const now = Date.now();
	const organisation = `(select id from organisations where slug = '${slug}')`;
	const ownerId = `(select id from users where email = '${owner}')`;
	const category = `(select id from expense_categories where organisation_id = ${organisation} and name_key = 'travel')`;
	const project = randomUUID();
	const adminId = randomUUID();
	sql(
		[
			`insert into projects (id, organisation_id, name, name_key, created_at, updated_at) values ('${project}', ${organisation}, 'Atlas', 'atlas', ${now}, ${now})`,
			`insert into expenses (id, organisation_id, user_id, project_id, category_id, spent_on, amount_minor, currency, receipt_key, receipt_name, receipt_type, created_at, updated_at) with recursive n(i) as (select 1 union all select i + 1 from n where i < ${EXPENSES_WITH_RECEIPTS}) select lower(hex(randomblob(16))), ${organisation}, ${ownerId}, '${project}', ${category}, '2026-11-20', 1200, 'GBP', 'receipt', 'train.pdf', 'application/pdf', ${now}, ${now} from n`,
			`insert into users (id, name, email, email_verified, created_at, updated_at) values ('${adminId}', 'Grace Hopper', '${admin}', 1, ${now}, ${now})`,
			`insert into memberships (id, organisation_id, user_id, role, created_at, updated_at) values ('${randomUUID()}', ${organisation}, '${adminId}', 'admin', ${now}, ${now})`,
		].join("; "),
	);
}

/** Runs the Worker's scheduled handler for `cron`, as the trigger would, and waits for it to end. */
async function runTrigger(page: Page, cron: string) {
	const ran = await page.request.get(`/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(cron)}`);
	expect(ran.status(), `the ${cron} trigger`).toBe(200);
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

/** Moves the focus to `control` and presses Enter on it. */
async function pressEnterOn(page: Page, control: Locator) {
	await control.focus();
	await expect(control).toBeFocused();
	await page.keyboard.press("Enter");
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });
			const at = `${viewport.width}-${colorScheme}`;

			test("an owner exports everything, downloads it and sees it expire; an admin never sees it", async ({
				page,
			}) => {
				const owner = newPerson();
				const admin = `grace-${randomUUID()}@example.com`;
				await signIn(page, owner.email);
				const { name, slug } = await createOrganisation(page);
				seedOrganisation(slug, owner.email, admin);
				const main = page.getByRole("main");
				const exportPage = everythingExportPath(slug);
				const download = everythingDownloadPath(slug);
				const organisationId = `(select id from organisations where slug = '${slug}')`;

				// Workspace settings leads an owner to it.
				await openShell(page, destinationPath(slug, "settings"));
				await pressEnterOn(page, main.getByRole("link", { name: "Export everything" }));
				await expect(page).toHaveURL(new RegExp(`${exportPage}$`));
				await expect(main.getByRole("heading", { level: 1 })).toHaveText("Export everything");
				await expect(main.getByRole("heading", { name: "No export to download" })).toBeVisible();
				await check(page, `TS-126-none-${at}`);

				// Asked for: the sheet says what happens, and the page that it is being made.
				await pressEnterOn(page, main.getByRole("button", { name: "Export everything" }));
				const sheet = page.getByRole("dialog", { name: "Export everything?" });
				await expect(sheet).toBeVisible();
				await check(page, `TS-126-sheet-${at}`, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS]);
				await pressEnterOn(page, sheet.getByRole("button", { name: "Make the export" }));
				await expect(sheet).toBeHidden();
				await expect(main.getByRole("status")).toHaveText(
					"Your export is being made. We'll tell you in the bell and by email when it's ready.",
				);
				await expect(main.getByRole("heading", { name: "Being made" })).toBeVisible();
				await expect(main.getByRole("button", { name: /Export/ })).toHaveCount(0);
				await check(page, `TS-126-running-${at}`);

				// The request's own step has stopped at its budget, and let go of the row.
				await expect
					.poll(
						() =>
							value(
								`select json_extract(progress, '$.step') || ':' || coalesce(lease_until, 'free') from organisation_exports where organisation_id = ${organisationId}`,
							),
						{ timeout: 30_000 },
					)
					.toBe("1:free");

				// The every-minute trigger's step finishes it, and its next run, whose
				// notification emails go before the exports, emails the owner the notice.
				const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				await foundInMessageSentBy(
					async () => {
						await runTrigger(page, EVERY_MINUTE);
						await runTrigger(page, EVERY_MINUTE);
					},
					new RegExp(`“${escaped}”: Your export of everything is ready to download, as one ZIP`),
					"the export's notice",
				);
				// The page, asking again while it is being made, shows it ready.
				await expect(main.getByRole("heading", { name: "Ready to download" })).toBeVisible({
					timeout: 15_000,
				});
				await expect(main.getByRole("status")).toHaveText("Your export is ready to download.");
				await expect(main).toContainText("It is kept until");
				await check(page, `TS-126-ready-${at}`);

				// The bell holds the notice, unread; opened with the keyboard, its item leads to this page.
				await openShell(page, exportPage);
				const band = page.getByRole("banner");
				const bell = band.getByRole("button", { name: "1 unread notification" });
				await expect(bell).toBeVisible();
				await pressEnterOn(page, bell);
				const list = page.getByRole("dialog", { name: "Notifications" });
				const item = list.getByRole("link", {
					name: /^Unread: Your export of everything is ready to download, as one ZIP\. It is kept until /,
				});
				await expect(item).toBeVisible();
				await expect(
					band.getByRole("button", { name: "Notifications", exact: true }),
				).toBeVisible();
				// The item's words lie over the list and the page behind it, which axe cannot measure.
				await check(page, `TS-126-bell-${at}`, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS]);
				await pressEnterOn(page, item);
				await expect(list).toBeHidden();
				await expect(page).toHaveURL(new RegExp(`${exportPage}$`));
				await expect(main.getByRole("heading", { name: "Ready to download" })).toBeVisible();

				// Downloaded from the keyboard: one ZIP, named for the organisation and the day.
				const downloaded = page.waitForEvent("download");
				await pressEnterOn(page, main.getByRole("link", { name: "Download the ZIP" }));
				const file = await downloaded;
				expect(file.suggestedFilename()).toMatch(/-everything-exported-\d{4}-\d{2}-\d{2}\.zip$/);
				const bytes = await readFile(await file.path());
				expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
				expect(bytes.includes("manifest.json")).toBe(true);
				expect(bytes.includes("tables/expenses.csv")).toBe(true);

				// Its 7 days end: the page says so, and the download is gone.
				sql(
					`update organisation_exports set expires_at = ${Date.now() - 1000} where organisation_id = ${organisationId}`,
				);
				await openShell(page, exportPage);
				await expect(main.getByRole("heading", { name: "Expired" })).toBeVisible();
				await expect(main).toContainText("so it can no longer be downloaded");
				await expect(main.getByRole("link", { name: "Download the ZIP" })).toHaveCount(0);
				expect((await page.request.get(download)).status()).toBe(404);
				await check(page, `TS-126-expired-${at}`);

				// The hourly trigger deletes it.
				await runTrigger(page, HOURLY);
				expect(
					value(
						`select count(*) from organisation_exports where organisation_id = ${organisationId}`,
					),
				).toBe(0);
				await openShell(page, exportPage);
				await expect(main.getByRole("heading", { name: "No export to download" })).toBeVisible();

				// An admin of the organisation: Workspace settings has no way there,
				// and the page and the file are the organisation's 404.
				await signOut(page);
				await signIn(page, admin);
				await openShell(page, destinationPath(slug, "settings"));
				await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
				await expect(main.getByRole("link", { name: "Export everything" })).toHaveCount(0);
				await check(page, `TS-126-admin-settings-${at}`);
				expect((await page.request.get(exportPage)).status()).toBe(404);
				expect((await page.request.get(download)).status()).toBe(404);
			});
		});
	}
}
