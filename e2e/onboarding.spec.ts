import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { invitationsPath, peopleImportPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";

// Company onboarding (TS-108): Invite many on Invitations, and the import of
// people from a CSV with its dry run, Invite, Discard, earlier imports and
// Revert. Each test signs in a new owner who makes an organisation of their
// own, gives it ten seats and a team named Design straight in the database,
// and does every step with the keyboard, scanning each view at both widths
// and in both schemes.
//
// With TS108_SHOTS set to a folder, each view is also photographed there.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS * 2 });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

const SHOTS = process.env.TS108_SHOTS;

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

/** Ten seats on the plan of the organisation `slug`, and a team named Design. */
function seedOrganisation(slug: string) {
	const now = Date.now();
	sql(
		[
			`update organisations set seats = 10 where slug = '${slug}'`,
			`insert into teams (id, organisation_id, name, name_key, created_at, updated_at) values ('${randomUUID()}', (select id from organisations where slug = '${slug}'), 'Design', 'design', ${now}, ${now})`,
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

/** Moves the focus to `control` and presses Enter, as a keyboard would. */
async function press(page: Page, control: Locator) {
	await control.focus();
	await expect(control).toBeFocused();
	await page.keyboard.press("Enter");
}

/** Chooses `option` in the Select labelled `label`, from the keyboard. */
async function choose(page: Page, within: Locator, label: string, option: string) {
	await press(page, within.getByRole("button", { name: new RegExp(label) }));
	const list = page.getByRole("listbox", { name: label });
	await expect(list).toBeVisible();
	const choice = list.getByRole("option", { name: option, exact: true });
	for (let presses = 0; presses < 4; presses++) {
		if (await choice.evaluate((element) => element === document.activeElement)) break;
		await page.keyboard.press("ArrowDown");
	}
	await expect(choice).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(list).toBeHidden();
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

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });
			const at = `${viewport.width}-${colorScheme}`;

			test("Invite many and the people import, by keyboard", async ({ page }) => {
				const { email } = newPerson();
				await signIn(page, email);
				const { slug } = await createOrganisation(page);
				seedOrganisation(slug);
				const main = page.getByRole("main");
				const status = main.getByRole("status").first();
				const tag = randomUUID().slice(0, 8);
				const address = (who: string) => `${who}-${tag}@example.com`;

				// Invite many: the seats left before, then one invitation each,
				// with the role and team, an address listed twice named and not sent.
				await openShell(page, invitationsPath(slug));
				await expect(main).toContainText("9 seats are left on the plan, of 10.");
				await check(page, `invitations-${at}`);

				await press(page, main.getByRole("button", { name: "Invite many" }));
				const sheet = page.getByRole("dialog", { name: "Invite many people" });
				const addresses = sheet.getByRole("textbox", { name: "Email addresses" });
				await expect(addresses).toBeFocused();
				await page.keyboard.type(
					`${address("ada")}\n${address("ada").toUpperCase()}\n${address("bob")}\n${email}`,
				);
				await choose(page, sheet, "Team", "Design");
				await expect(sheet).toContainText("9 seats are left on the plan, of 10.");
				await check(page, `invite-many-sheet-${at}`, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS]);
				await press(page, sheet.getByRole("button", { name: "Send invitations" }));
				await expect(sheet).toBeHidden();
				await expect(status).toContainText("2 invitations are on the way, each into Design.");
				await expect(status).toContainText(
					`${address("ada").toUpperCase()}: It is in the list twice; one invitation is enough.`,
				);
				await expect(status).toContainText(`${email}: They are already a member.`);
				const waiting = main.getByRole("list", { name: "Invitations" });
				await expect(waiting).toContainText(address("ada"));
				await expect(waiting).toContainText(address("bob"));
				await expect(waiting).toContainText("Invited as a member, into Design.");
				await expect(main).toContainText("7 seats are left on the plan, of 10.");
				await check(page, `invite-many-sent-${at}`);

				// The import page, from Invitations' link.
				await press(page, main.getByRole("link", { name: "Import people from a CSV" }));
				await expect(page).toHaveURL(new RegExp(`${peopleImportPath(slug)}$`));
				await expect(main.getByRole("heading", { level: 1, name: "Import people" })).toBeVisible();
				await expect(main).toContainText("No people imported yet.");
				await check(page, `import-empty-${at}`, [EMPTY_INPUT]);

				// A dry run discarded leaves nothing behind.
				await upload(page, "wrong.csv", `Email\n${address("wrong")}\n`);
				await press(page, main.getByRole("button", { name: "Discard" }));
				await expect(main.getByRole("heading", { name: "Choose a file" })).toBeVisible();
				await expect(main).toContainText("No people imported yet.");

				// A dry run: each row's outcome, and nothing sent.
				await upload(
					page,
					"people.csv",
					[
						"Email,Name,Role,Team,Manager,Schedule,Start date,Phone",
						`${address("cy")},Cy Twombly,Finance,Design,${email},Standard,2099-12-01,0123`,
						`${address("di")},Di Lewis,,Design,,,,`,
						`${address("bob")},,,,,,,`,
						`not-an-address,,,,,,,`,
						`${address("ed")},,,,,,2099-12-01,`,
					].join("\n"),
				);
				await expect(main).toContainText("Nothing has been sent yet.");
				await expect(main).toContainText("Not read: Phone.");
				await expect(main).toContainText("2 people to invite, 3 not sent.");
				const notSent = main.getByRole("list", { name: "Rows not sent" });
				await expect(notSent).toContainText("An invitation to them is already waiting.");
				await expect(notSent).toContainText("“not-an-address” is not an email address.");
				await expect(notSent).toContainText(
					"A start date is the day their schedule starts. Name the schedule too.",
				);
				const toInvite = main.getByRole("list", { name: "Rows to invite" });
				await expect(toInvite).toContainText(`Cy Twombly · ${address("cy")}`);
				await expect(toInvite).toContainText(
					`Finance · joins Design · ${email} manages Design · Standard from Tuesday 1 December 2099, or the day they join if later`,
				);
				await expect(toInvite).toContainText("Line 2");
				await check(page, `import-dry-run-${at}`);

				// Invite: the import is recorded, and listed among the earlier ones.
				await press(page, main.getByRole("button", { name: "Invite 2 people" }));
				await expect(main.getByRole("heading", { name: "people.csv: imported" })).toBeVisible();
				await expect(main).toContainText("2 people invited, 3 not sent.");
				const earlier = main.getByRole("list", { name: "Earlier imports" });
				await expect(earlier).toContainText("2 people invited, 3 not sent");
				await check(page, `import-imported-${at}`, [EMPTY_INPUT]);

				// Revert: its invitations still waiting are withdrawn.
				await press(page, earlier.getByRole("button", { name: "Revert people.csv" }));
				const revert = page.getByRole("dialog", { name: "Revert people.csv?" });
				await expect(revert).toBeVisible();
				await check(page, `import-revert-sheet-${at}`, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS]);
				await press(page, revert.getByRole("button", { name: "Revert import" }));
				await expect(revert).toBeHidden();
				await expect(status).toHaveText("Import reverted: 2 invitations withdrawn.");
				await expect(earlier).toContainText("Reverted");
				await expect(main).toContainText(
					"2 people invited, 3 not sent. Reverted: the invitations still waiting were withdrawn.",
				);
				await expect(earlier.getByRole("button", { name: "Revert people.csv" })).toHaveCount(0);
				await check(page, `import-reverted-${at}`, [EMPTY_INPUT]);

				// Invitations keeps the two from Invite many alone.
				await openShell(page, invitationsPath(slug));
				await expect(waiting).toContainText(address("bob"));
				await expect(waiting).not.toContainText(address("cy"));
			});
		});
	}
}
