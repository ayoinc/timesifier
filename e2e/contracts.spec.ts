import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { destinationPath, organisationPath, schedulesPath } from "../app/shell/destinations";
import {
	foundInMessageSentBy,
	newPerson,
	ownAddress,
	setName,
	signIn,
	TIME_WITH_TURNS,
} from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation, INVITATION_LINK, openInvitations } from "./organisation";
import { mondayOf } from "./timesheet";

// Contracts in a browser (TS-098a). An owner adds a part-time schedule, Three
// days (Monday to Wednesday, 09:00 to 14:00), invites Grace, who joins from
// her email in a browser of her own; the owner opens Grace on Team, her
// Contract tab, and gives her a permanent contract on Three days through its
// sheet. Team then says the schedule is from her contract, and Grace's own
// week shows its hours. Then axe at 390px and 1280px in both schemes on
// Contract and its Give, Change and End sheets. What each role may read and
// do is tested through the Worker (test/pages/contracts.test.ts,
// test/pages/finance.test.ts).
//
// With TS098A_SHOTS set to a folder, each view the axe test scans is also
// photographed there.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS * 3 });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

const SHOTS = process.env.TS098A_SHOTS;

const main = (page: Page) => page.getByRole("main");

/** Adds Three days, Monday to Wednesday 09:00 to 14:00 with no break: 15 hours a week. */
async function addThreeDays(page: Page, slug: string) {
	await openShell(page, schedulesPath(slug));
	await page.getByRole("button", { name: "New schedule" }).click();
	const sheet = page.getByRole("dialog", { name: "New schedule" });
	await sheet.getByLabel("Name").fill("Three days");
	for (const day of ["Monday", "Tuesday", "Wednesday"]) {
		const fields = sheet.getByRole("group", { name: day, exact: true });
		await fields.getByLabel("Start").fill("09:00");
		await fields.getByLabel("Finish").fill("14:00");
		await fields.getByLabel("Break (minutes)").fill("0");
	}
	// A new schedule works Monday to Friday; Three days does not work Thursday or Friday.
	for (const day of ["Thursday", "Friday"]) {
		await sheet.getByText(`${day} worked`).click();
		await expect(sheet.getByRole("checkbox", { name: `${day} worked` })).not.toBeChecked();
	}
	await sheet.getByRole("button", { name: "Save" }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("list", { name: "Schedules" })).toContainText(
		"Monday to Wednesday, 09:00–14:00 · 15:00 a week",
	);
}

/** Chooses `option` in the sheet's select labelled `label`. */
async function choose(page: Page, sheet: Locator, label: string, option: string) {
	await sheet.getByRole("button", { name: new RegExp(label) }).click();
	const options = page.getByRole("listbox", { name: label });
	await expect(options).toBeVisible();
	await options.getByRole("option", { name: option, exact: true }).click();
	await expect(options).toBeHidden();
}

/** Fills in the Give sheet, open on the page, for a permanent contract on Three days at £18,000 a year, and sends it. */
async function giveOnThreeDays(page: Page, sheet: Locator) {
	await sheet.getByLabel("Job title").fill("Designer");
	await choose(page, sheet, "Work schedule", "Three days");
	await sheet.getByRole("textbox", { name: /^Pay, in / }).fill("18000");
	await sheet.getByRole("button", { name: "Give contract" }).click();
	await expect(sheet).toBeHidden();
	await expect(main(page).getByRole("status").first()).toContainText("The contract is given, from");
	await expect(main(page)).toContainText("Permanent, part time, from");
	await expect(main(page)).toContainText("Works 15:00 a week on Three days.");
	await expect(main(page)).toContainText("Paid £18,000.00 a year.");
}

test("an owner gives a part-timer a contract and her week shows its hours", async ({
	page,
	browser,
	baseURL,
}) => {
	const owner = newPerson();
	const grace = { name: "Grace Hopper", email: `grace-${randomUUID()}@example.com` };
	await signIn(page, owner.email);
	const { slug, name: organisationName } = await createOrganisation(page);
	await setName(page, "Ada Lovelace");
	await addThreeDays(page, slug);

	// Grace is invited as a member, and joins from the link in her email.
	await openInvitations(page, slug);
	await page.getByRole("button", { name: "Invite a person" }).click();
	const inviting = page.getByRole("dialog", { name: "Invite a person" });
	await inviting.getByLabel("Email address").fill(grace.email);
	await inviting.getByText("Member", { exact: true }).click();
	const link = await foundInMessageSentBy(
		() => inviting.getByRole("button", { name: "Send invitation" }).click(),
		INVITATION_LINK,
		"the invitation's link",
	);
	await expect(inviting).toBeHidden();
	const hers = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
	await ownAddress(hers, baseURL);
	const herPage = await hers.newPage();
	await signIn(herPage, grace.email, `/sign-in?next=${encodeURIComponent(link)}`);
	await expect(herPage).toHaveURL(link);
	await expect(
		herPage.getByRole("heading", { level: 1, name: `Join ${organisationName}?` }),
	).toBeVisible();
	await herPage.getByRole("button", { name: "Join" }).click();
	await expect(herPage).toHaveURL(organisationPath(slug));
	await setName(herPage, grace.name);

	// The owner opens Grace on Team, then her Contract tab: she has none.
	await openShell(page, destinationPath(slug, "team"));
	await page.getByRole("list", { name: "People" }).getByRole("link", { name: grace.name }).click();
	await expect(page.getByRole("heading", { level: 1, name: grace.name })).toBeVisible();
	const tabs = page.getByRole("group", { name: "Their pages" });
	await tabs.getByRole("link", { name: "Contract" }).click();
	await expect(tabs.getByRole("link", { name: "Contract" })).toHaveAttribute(
		"aria-current",
		"page",
	);
	await expect(main(page)).toContainText("They have no contract here.");

	// She is given a permanent contract on Three days, from today.
	await main(page).getByRole("button", { name: "Give a contract" }).click();
	const give = page.getByRole("dialog", { name: `Give ${grace.name} a contract` });
	await expect(give.getByLabel("First day")).not.toHaveValue("");
	await giveOnThreeDays(page, give);
	await expect(main(page)).toContainText("Designer.");

	// Team's Week tab says where her hours come from now.
	await tabs.getByRole("link", { name: "Week" }).click();
	await expect(main(page)).toContainText(
		"Work schedule: Three days, Monday to Wednesday, 09:00–14:00 · 15:00 a week. From their contract.",
	);

	// Her own week, the next, shows the contract's hours on its days and none on Thursday.
	const today = await herPage.evaluate(() => new Date().toISOString().slice(0, 10));
	const next = new Date(`${mondayOf(today)}T00:00:00Z`);
	next.setUTCDate(next.getUTCDate() + 7);
	await openShell(
		herPage,
		`${organisationPath(slug)}?view=week&start=${next.toISOString().slice(0, 10)}`,
	);
	await expect(
		herPage.getByRole("columnheader").filter({ hasText: "09:00–14:00" }).first(),
	).toBeVisible();
	await openShell(herPage, `${organisationPath(slug)}/account`);
	await expect(main(herPage)).toContainText("From your contract");
	await expect(main(herPage)).toContainText("Paid £18,000.00 a year.");
	await hers.close();
});

/** Scans the page, and photographs it first when shots are asked for. */
async function check(page: Page, shot: string, unmeasurable: string[] = []) {
	const found = await problems(page, unmeasurable);
	if (SHOTS) {
		mkdirSync(SHOTS, { recursive: true });
		await page.screenshot({ path: join(SHOTS, `${shot}.png`), fullPage: true });
	}
	expect(found, `problems in ${shot}`).toEqual([]);
}

const IN_A_SHEET = [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS, EMPTY_INPUT];

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });

			test("axe finds nothing on Contract and its Give, Change and End sheets", async ({
				page,
			}) => {
				const at = `${viewport.width}-${colorScheme}`;
				// The sole owner, who changes their own contract, as the page says.
				await signIn(page, newPerson().email);
				const { slug } = await createOrganisation(page);
				await setName(page, "Ada Lovelace");
				await addThreeDays(page, slug);
				await openShell(page, destinationPath(slug, "team"));
				await page
					.getByRole("list", { name: "People" })
					.getByRole("link", { name: "Ada Lovelace" })
					.click();
				const tabs = page.getByRole("group", { name: "Their pages" });
				await tabs.getByRole("link", { name: "Contract" }).click();
				await expect(main(page)).toContainText("You have no contract here.");
				await check(page, `contract-none-${at}`);

				await main(page).getByRole("button", { name: "Give a contract" }).click();
				const give = page.getByRole("dialog", { name: "Give Ada Lovelace a contract" });
				await expect(give).toBeVisible();
				await check(page, `contract-give-${at}`, IN_A_SHEET);
				await giveOnThreeDays(page, give);
				await expect(main(page)).toContainText("Nobody else here can change your contract");
				await check(page, `contract-${at}`);

				await main(page).getByRole("button", { name: "Change contract" }).click();
				const change = page.getByRole("dialog", { name: "Change Ada Lovelace's contract" });
				await expect(change.getByLabel("Job title")).toHaveValue("Designer");
				await check(page, `contract-change-${at}`, IN_A_SHEET);
				await page.keyboard.press("Escape");
				await expect(change).toBeHidden();

				await main(page).getByRole("button", { name: "End contract" }).click();
				const end = page.getByRole("dialog", { name: "End Ada Lovelace's contract" });
				await expect(end.getByLabel("Last day")).toBeVisible();
				await check(page, `contract-end-${at}`, IN_A_SHEET);
				await page.keyboard.press("Escape");
				await expect(end).toBeHidden();
			});
		});
	}
}
