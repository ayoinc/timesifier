import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { setupImportPath } from "../app/setup-import/paths";
import { destinationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";

// The set-up import (TS-115d): from Projects' link to the page, a dry run
// discarded, a dry run with each row's outcome, the import, the earlier
// imports, and the revert. Each test signs in a new owner who makes an
// organisation of their own through the pages, so nothing is written to the
// database from outside, and does every step with the keyboard, scanning each
// view at both widths and in both schemes.
//
// With TS115D_SHOTS set to a folder, each view is also photographed there.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS * 2 });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

const SHOTS = process.env.TS115D_SHOTS;

/** Scans the page, and photographs it first when shots are asked for. */
async function check(page: Page, shot: string, unmeasurable: string[] = []) {
	const found = await problems(page, unmeasurable);
	if (SHOTS) {
		mkdirSync(SHOTS, { recursive: true });
		await page.screenshot({ path: join(SHOTS, `${shot}.png`), fullPage: true });
	}
	expect(found, `problems in ${shot}`).toEqual([]);
}

/** Moves the focus to `control` and presses Enter, as a keyboard would. */
async function press(page: Page, control: Locator) {
	await control.focus();
	await expect(control).toBeFocused();
	await page.keyboard.press("Enter");
}

/** Puts a CSV in the file field and asks for its dry run. */
async function upload(page: Page, name: string, text: string) {
	const main = page.getByRole("main");
	await main.getByLabel("CSV file").setInputFiles({
		name,
		mimeType: "text/csv",
		buffer: Buffer.from(text),
	});
	await press(page, main.getByRole("button", { name: "Upload for a dry run" }));
	await expect(main.getByRole("heading", { name: `Dry run of ${name}` })).toBeVisible();
}

const HEADER = "Kind,Project code,Code,Name,Starts,Ends,Budget,Email,Role,Notes";

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });
			const at = `${viewport.width}-${colorScheme}`;

			test("setting up projects, work packages and a team from a CSV, by keyboard", async ({
				page,
			}) => {
				const { email } = newPerson();
				await signIn(page, email);
				const { slug } = await createOrganisation(page);
				const main = page.getByRole("main");
				const status = main.getByRole("status").first();

				// Projects links to it, for its owner.
				await openShell(page, destinationPath(slug, "projects"));
				await press(
					page,
					main.getByRole("link", { name: "Set up projects, work packages and teams from a CSV" }),
				);
				await expect(page).toHaveURL(new RegExp(`${setupImportPath(slug)}$`));
				await expect(
					main.getByRole("heading", { level: 1, name: "Set up from a CSV" }),
				).toBeVisible();
				await expect(main).toContainText("Nothing set up from a file yet.");
				await check(page, `setup-empty-${at}`, [EMPTY_INPUT]);

				// A dry run discarded leaves nothing behind.
				await upload(page, "wrong.csv", `${HEADER}\nProject,WEB-1,,Website,,,,,,\n`);
				await press(page, main.getByRole("button", { name: "Discard" }));
				await expect(main.getByRole("heading", { name: "Choose a file" })).toBeVisible();
				await expect(main).toContainText("Nothing set up from a file yet.");

				// A dry run: each row's outcome, its order no matter, and nothing added.
				await upload(
					page,
					"setup.csv",
					[
						HEADER,
						`Work package,web-1,WP1,Discovery,2027-01-04,2027-01-29,40h,,,first`,
						`Assignment,WEB-1,,,2027-01-04,,,${email},Delivery manager,`,
						`Project,WEB-1,,"Website, rebuilt",2027-01-04,2027-06-30,,,,`,
						`Project,APP-1,,Mobile app,,,,,,`,
						`Work package,APP-1,WP1,Build,,,120h,,,`,
						`Assignment,APP-1,,,2027-01-04,,,nobody@example.com,,`,
						`Project,web-1,,Again,,,,,,`,
					].join("\n"),
				);
				await expect(main).toContainText("Nothing has been added yet.");
				await expect(main).toContainText("Not read: Notes.");
				await expect(main).toContainText(
					"2 projects, 2 work packages and 1 assignment to add; 2 rows not added.",
				);
				const notAdded = main.getByRole("list", { name: "Rows not added" });
				await expect(notAdded).toContainText(
					"Nobody in this organisation or invited to it has the address nobody@example.com. Invite them first.",
				);
				await expect(notAdded).toContainText("The same project code is on line 4.");
				await expect(main.getByRole("list", { name: "Projects to add" })).toContainText(
					"WEB-1 · Website, rebuilt",
				);
				const packages = main.getByRole("list", { name: "Work packages to add" });
				await expect(packages).toContainText("WP1 Discovery");
				await expect(packages).toContainText("in WEB-1 (line 4) · 40 hours budget");
				await expect(main.getByRole("list", { name: "Assignments to add" })).toContainText(
					"Delivery manager on WEB-1 (line 4) · from Monday 4 January 2027",
				);
				await check(page, `setup-dry-run-${at}`);

				// Import: recorded, and listed among the earlier ones.
				await press(page, main.getByRole("button", { name: "Import", exact: true }));
				await expect(main.getByRole("heading", { name: "setup.csv: imported" })).toBeVisible();
				await expect(main).toContainText("5 rows added, 2 not added.");
				await expect(main).toContainText("1 assignment is on teams now; 0 still wait");
				const earlier = main.getByRole("list", { name: "Earlier imports" });
				await expect(earlier).toContainText("5 rows added, 2 not added");
				await check(page, `setup-imported-${at}`, [EMPTY_INPUT]);

				// Projects lists what it added.
				await openShell(page, destinationPath(slug, "projects"));
				await expect(main).toContainText("Website, rebuilt");
				await expect(main).toContainText("Mobile app");
				await check(page, `setup-projects-${at}`, [EMPTY_INPUT]);

				// Revert: what it added is taken away, and the sheet says what cannot be.
				await openShell(page, setupImportPath(slug));
				await press(page, earlier.getByRole("button", { name: "Revert setup.csv" }));
				const revert = page.getByRole("dialog", { name: "Revert setup.csv?" });
				await expect(revert).toBeVisible();
				await expect(revert).toContainText("It cannot be reverted once time has been tracked");
				await check(page, `setup-revert-sheet-${at}`, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS]);
				await press(page, revert.getByRole("button", { name: "Revert import" }));
				await expect(revert).toBeHidden();
				await expect(status).toHaveText(
					"Import reverted: 2 projects, 2 work packages and 1 assignment taken away.",
				);
				await expect(earlier).toContainText("Reverted");
				await expect(earlier.getByRole("button", { name: "Revert setup.csv" })).toHaveCount(0);
				await check(page, `setup-reverted-${at}`, [EMPTY_INPUT]);

				await openShell(page, destinationPath(slug, "projects"));
				await expect(main).not.toContainText("Website, rebuilt");
			});
		});
	}
}
