import type { Locator, Page } from "@playwright/test";

import { accountPath, membersPath } from "../app/shell/destinations";
import { SIGNED_IN_AS_GUEST, SIGNED_IN_AS_MEMBER } from "./auth-state";
import { contrast, EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { movement, watchForMovement } from "./motion";
import {
	homeOrganisation,
	homePath,
	openInvitations,
	openMembers,
	openOutsideOrganisation,
} from "./organisation";

// Every view card TS-009 adds, at both window sizes and in both schemes: no
// WCAG 2.2 A or AA violation, and every text's contrast measured (rules 14 and
// 16). Then rule 9: with reduced motion requested, nothing on these pages moves
// or changes size.
//
// The views are looked at and nothing is sent: the people are the three the
// setup project made around one organisation (./auth.setup.ts).

/** An invitation nobody was sent. Its page is the one every invalid invitation gets. */
const NO_INVITATION = "/invitations/00000000-0000-7000-8000-000000000000";

/** Scans the view on screen, once it is the one with this heading. */
async function expectNoProblems(page: Page, heading: string, unmeasurable: string[] = []) {
	await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
	expect(await problems(page, unmeasurable), `problems in "${heading}"`).toEqual([]);
}

/**
 * Scans the page with a sheet open over it. A sheet's lines of text lie over
 * different parts of the page, which axe cannot measure through, so the
 * contrast of the sheet's own text is measured here.
 */
async function expectNoProblemsInSheet(page: Page, sheet: Locator, text: Locator) {
	await expect(sheet).toBeVisible();
	expect(
		await problems(page, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS, EMPTY_INPUT]),
		"problems with the sheet open",
	).toEqual([]);
	expect(await contrast(text), "contrast of the sheet's text").toBeGreaterThanOrEqual(4.5);
	await page.keyboard.press("Escape");
	await expect(sheet).toBeHidden();
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });

			test.describe("for an owner", () => {
				test("creating an organisation, and the welcome to a first one", async ({ page }) => {
					await openOutsideOrganisation(page, "/app/new");
					expect(await page.evaluate(() => getComputedStyle(document.body).colorScheme)).toContain(
						colorScheme,
					);
					await expectNoProblems(page, "Create an organisation", [EMPTY_INPUT]);
					// The field's own message, when what was typed is no name.
					await page.getByLabel("Organisation name").fill("   ");
					await page.getByRole("button", { name: "Create organisation" }).click();
					await expect(page.getByText("Enter a name.")).toBeVisible();
					await expectNoProblems(page, "Create an organisation");

					await openShell(page, `${homePath("timesheet")}?welcome=1`);
					await expect(page.getByText(`${homeOrganisation().name} is ready`)).toBeVisible();
					await expectNoProblems(page, "Timesheet");
				});

				test("Workspace settings, My account, and each of their sheets", async ({ page }) => {
					const { name, slug } = homeOrganisation();
					await openShell(page, homePath("settings"));
					await expectNoProblems(page, "Workspace settings");

					await page.getByRole("button", { name: "Rename" }).click();
					const rename = page.getByRole("dialog", { name: "Rename the organisation" });
					await expectNoProblemsInSheet(
						page,
						rename,
						rename.getByText("Everyone in the organisation"),
					);

					await page.getByRole("button", { name: "Delete organisation" }).click();
					const deleting = page.getByRole("dialog", { name: `Delete ${name}?` });
					await deleting.getByLabel("Organisation name").fill("another name");
					await deleting.getByRole("button", { name: "Delete organisation" }).click();
					const refused = deleting.getByText("Type the name exactly as it is shown.");
					await expect(refused).toBeVisible();
					expect(await contrast(refused), "contrast of the field's error").toBeGreaterThanOrEqual(
						4.5,
					);
					await expectNoProblemsInSheet(
						page,
						deleting,
						deleting.getByText("This removes the organisation"),
					);

					await openShell(page, accountPath(slug));
					await expectNoProblems(page, "My account");
					await page.getByRole("button", { name: "Change name" }).click();
					const own = page.getByRole("dialog", { name: "Your name" });
					await expectNoProblemsInSheet(page, own, own.getByText("Shown to the people"));

					await page.getByRole("button", { name: "Leave organisation" }).click();
					const leave = page.getByRole("dialog", { name: `Leave ${name}?` });
					await expectNoProblemsInSheet(page, leave, leave.getByText("You will no longer"));
				});

				test("the members and invitations pages, the menu and each of their sheets", async ({
					page,
				}) => {
					const { slug, member, guest } = homeOrganisation();
					await openShell(page, homePath("team"));
					await expectNoProblems(page, "Team");
					await openMembers(page, slug);
					await expectNoProblems(page, "Members");

					const actions = page.getByRole("button", { name: `Actions for ${member.name}` });
					await actions.click();
					await expect(page.getByRole("menu")).toBeVisible();
					expect(await problems(page, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS])).toEqual([]);
					expect(
						await contrast(page.getByRole("menuitem", { name: "Change role" })),
						"contrast of a menu item",
					).toBeGreaterThanOrEqual(4.5);
					await page.getByRole("menuitem", { name: "Change role" }).click();
					const role = page.getByRole("dialog", { name: `Change the role of ${member.name}` });
					await expectNoProblemsInSheet(page, role, role.getByText("Admins can rename"));

					await actions.click();
					await page.getByRole("menuitem", { name: "Remove from organisation" }).click();
					const remove = page.getByRole("dialog", { name: `Remove ${member.name}?` });
					await expectNoProblemsInSheet(page, remove, remove.getByText("They stop being a member"));

					await openInvitations(page, slug);
					await expectNoProblems(page, "Invitations");
					await page.getByRole("button", { name: "Invite a person" }).click();
					const inviting = page.getByRole("dialog", { name: "Invite a person" });
					await expectNoProblemsInSheet(page, inviting, inviting.getByText("They get an email"));

					await page
						.getByRole("button", { name: `Cancel the invitation to ${guest.email}` })
						.click();
					const cancel = page.getByRole("dialog", { name: "Cancel this invitation?" });
					await expectNoProblemsInSheet(page, cancel, cancel.getByText("stops working"));
				});

				test("the destinations still to be built, each with its empty sheet", async ({ page }) => {
					for (const [id, heading] of [
						["approvals", "Approvals"],
						["reports", "Reports"],
					] as const) {
						await openShell(page, homePath(id));
						await expectNoProblems(page, heading);
					}
				});
			});

			test.describe("for a member who belongs to two organisations", () => {
				test.use({ storageState: SIGNED_IN_AS_MEMBER });

				test("the choice of organisation, and the pages a member is shown", async ({ page }) => {
					const { slug } = homeOrganisation();
					await openOutsideOrganisation(page, "/app");
					await expectNoProblems(page, "Your organisations");

					await openShell(page, homePath("timesheet"));
					await expectNoProblems(page, "Timesheet");

					await openShell(page, accountPath(slug));
					await expectNoProblems(page, "My account");
				});
			});

			test.describe("for a person with an invitation", () => {
				test.use({ storageState: SIGNED_IN_AS_GUEST, refusals: { [NO_INVITATION]: [410] } });

				test("the invitation, and the page of one that is no longer valid", async ({ page }) => {
					const { name, guestInvitation } = homeOrganisation();
					await openShell(page, guestInvitation, "header");
					await expectNoProblems(page, `Join ${name}?`);

					const gone = await page.goto(NO_INVITATION);
					expect(gone?.status()).toBe(410);
					await expectNoProblems(page, "This invitation is no longer valid");
				});
			});
		});
	}
}

/**
 * Every change of view these pages make without sending anything: the welcome
 * arriving, a move to Workspace settings, to Team and on to the members, the menu, and a sheet
 * opening and closing on each page.
 */
async function walkTheViews(page: Page) {
	const { slug, name, member } = homeOrganisation();
	await openShell(page, `${homePath("timesheet")}?welcome=1`);
	await expect(page.getByText(`${name} is ready`)).toBeVisible();

	await page.getByRole("navigation").getByRole("link", { name: "Workspace settings" }).click();
	await expect(page.getByRole("heading", { level: 1, name: "Workspace settings" })).toBeFocused();
	await page.getByRole("button", { name: "Rename" }).click();
	const rename = page.getByRole("dialog", { name: "Rename the organisation" });
	await expect(rename.getByLabel("Organisation name")).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(rename).toBeHidden();

	await page.getByRole("navigation").getByRole("link", { name: "Team" }).click();
	await expect(page.getByRole("heading", { level: 1, name: "Team" })).toBeFocused();
	await page.getByRole("main").getByRole("link", { name: "Members", exact: true }).click();
	await expect(page).toHaveURL(membersPath(slug));
	await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeFocused();
	await page.getByRole("button", { name: `Actions for ${member.name}` }).click();
	await page.getByRole("menuitem", { name: "Change role" }).click();
	const role = page.getByRole("dialog", { name: `Change the role of ${member.name}` });
	await expect(role).toBeVisible();
	await role.getByText("Admin", { exact: true }).click();
	await role.getByRole("button", { name: "Cancel" }).click();
	await expect(role).toBeHidden();
	// Until the sheet has gone from the page, it is still leaving.
	await expect(page.getByRole("dialog")).toHaveCount(0);
}

test.describe("with reduced motion requested", () => {
	test.use({ reducedMotion: "reduce" });

	test("nothing on an organisation's pages moves or changes size", async ({ page }) => {
		await watchForMovement(page);
		await walkTheViews(page);
		expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
			true,
		);
		expect(await movement(page)).toEqual([]);
	});
});

test.describe("with motion allowed", () => {
	test.use({ reducedMotion: "no-preference" });

	// The same views and the same watcher. This is what shows the test above can fail.
	test("the watcher sees the welcome, the pages and the sheets move", async ({ page }) => {
		await watchForMovement(page);
		await walkTheViews(page);

		const seen = await movement(page);
		for (const moved of [
			/^transition of scale on <span>/, // the mark of the moment grows in
			/^animation of translate on <html>/, // a destination arrives from the side it lies on
			/^transition of translate on <div/, // a sheet slides up, and back down
		]) {
			expect(seen).toContainEqual(expect.stringMatching(moved));
		}
	});
});
