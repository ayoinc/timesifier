import type { Locator, Page } from "@playwright/test";

import { accountPath, invitationsPath, membersPath } from "../app/shell/destinations";
import { expect, openShell, test } from "./fixtures";
import { homeOrganisation, homePath, openOutsideOrganisation } from "./organisation";

// Design rule 15: everything works by keyboard, with a visible focus indicator.
// The members and invitations are walked here with the keyboard alone, from Team: no
// pointer touches the page after it has loaded. Every sheet is opened and
// given up, so the organisation is left as it was; the journeys
// (./organisations-journeys.spec.ts) send an invitation with the keyboard.

/** The element holds the keyboard focus and shows it. */
async function expectFocusShown(element: Locator) {
	await expect(element).toBeFocused();
	const outline = await element.evaluate((focused) => {
		const { outlineStyle, outlineWidth } = getComputedStyle(focused);
		return { outlineStyle, width: Number.parseFloat(outlineWidth) };
	});
	expect(outline.outlineStyle).toBe("solid");
	expect(outline.width).toBeGreaterThan(0);
}

async function tabTo(page: Page, element: Locator) {
	await page.keyboard.press("Tab");
	await expectFocusShown(element);
}

/** The radio is focused, and the ring around it shows so. */
async function expectRadioFocused(radio: Locator) {
	await expect(radio).toBeFocused();
	await expect(radio.locator("xpath=..")).toHaveAttribute("data-focus-visible", "true");
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	test.describe(`in a window ${viewport.width}px wide`, () => {
		test.use({ viewport });

		test("the members and invitations: every control, the menu and every sheet, with the keyboard alone", async ({
			page,
		}) => {
			const { slug, name, member, guest } = homeOrganisation();
			await openShell(page, homePath("team"));

			// From Team to the members, by the link, with Enter.
			const toMembers = page.getByRole("main").getByRole("link", { name: "Members", exact: true });
			await toMembers.focus();
			await page.keyboard.press("Enter");
			await expect(page).toHaveURL(membersPath(slug));
			// The move puts the focus on the page's heading; Tab goes on from there.
			await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeFocused();

			// The member's actions: a menu the arrow keys move through.
			const actions = page.getByRole("button", { name: `Actions for ${member.name}` });
			await tabTo(page, actions);
			await page.keyboard.press("Enter");
			const changeRole = page.getByRole("menuitem", { name: "Change role" });
			const removeItem = page.getByRole("menuitem", { name: "Remove from organisation" });
			await expect(changeRole).toBeFocused();
			await page.keyboard.press("ArrowDown");
			await expect(removeItem).toBeFocused();
			await page.keyboard.press("Escape");
			await expect(page.getByRole("menu")).toBeHidden();
			await expectFocusShown(actions);

			// Change role: the sheet opens on the role they hold.
			await page.keyboard.press("Enter");
			await expect(changeRole).toBeFocused();
			await page.keyboard.press("Enter");
			const role = page.getByRole("dialog", { name: `Change the role of ${member.name}` });
			await expect(role).toBeVisible();
			await page.keyboard.press("Tab");
			await expectRadioFocused(role.getByRole("radio", { name: /^Member/ }));
			await page.keyboard.press("ArrowUp");
			await expect(role.getByRole("radio", { name: /^Admin/ })).toBeChecked();
			await page.keyboard.press("Escape");
			await expect(role).toBeHidden();
			await expectFocusShown(actions);

			// Remove: asked first, and Cancel is a key press away.
			await page.keyboard.press("Enter");
			await page.keyboard.press("ArrowDown");
			await page.keyboard.press("Enter");
			const remove = page.getByRole("dialog", { name: `Remove ${member.name}?` });
			await expect(remove).toBeVisible();
			await tabTo(page, remove.getByRole("button", { name: "Cancel" }));
			await page.keyboard.press("Enter");
			await expect(remove).toBeHidden();
			await expectFocusShown(actions);

			// On to the invitations, by the link under the members.
			// The tab above the heading has the same name; this is the last of the two.
			const toInvitations = page
				.getByRole("main")
				.getByRole("link", { name: "Invitations" })
				.last();
			await tabTo(page, toInvitations);
			await page.keyboard.press("Enter");
			await expect(page).toHaveURL(invitationsPath(slug));
			await expect(page.getByRole("heading", { level: 1, name: "Invitations" })).toBeFocused();

			// Invite: Enter opens the sheet with the focus in its field.
			const invite = page.getByRole("button", { name: "Invite a person" });
			await tabTo(page, invite);
			await page.keyboard.press("Enter");
			const inviting = page.getByRole("dialog", { name: "Invite a person" });
			await expect(inviting.getByLabel("Email address")).toBeFocused();
			// Tab reaches the role, where the arrow keys choose, then the two buttons.
			await page.keyboard.press("Tab");
			await expectRadioFocused(inviting.getByRole("radio", { name: /^Member/ }));
			await page.keyboard.press("ArrowDown");
			await expectRadioFocused(inviting.getByRole("radio", { name: /^Admin/ }));
			await expect(inviting.getByRole("radio", { name: /^Admin/ })).toBeChecked();
			await tabTo(page, inviting.getByRole("button", { name: "Cancel" }));
			await tabTo(page, inviting.getByRole("button", { name: "Send invitation" }));
			// The focus stays inside the sheet.
			await page.keyboard.press("Tab");
			await expect(inviting.getByLabel("Email address")).toBeFocused();
			// Escape gives the task up and gives the focus back.
			await page.keyboard.press("Escape");
			await expect(inviting).toBeHidden();
			await expectFocusShown(invite);

			// The invitation that is waiting.
			const cancel = page.getByRole("button", { name: `Cancel the invitation to ${guest.email}` });
			await tabTo(page, cancel);
			await page.keyboard.press("Enter");
			const cancelling = page.getByRole("dialog", { name: "Cancel this invitation?" });
			await expect(cancelling).toBeVisible();
			await tabTo(page, cancelling.getByRole("button", { name: "Keep it" }));
			await page.keyboard.press("Enter");
			await expect(cancelling).toBeHidden();
			await expectFocusShown(cancel);

			// Back to Team by its This week tab, above the heading.
			const back = page.getByRole("main").getByRole("link", { name: "This week" });
			await back.focus();
			await expectFocusShown(back);
			await page.keyboard.press("Enter");
			await expect(page).toHaveURL(homePath("team"));
			await expect(page.getByRole("heading", { level: 1, name: "Team" })).toBeFocused();

			// Leaving is on My account, which the band leads to.
			const toAccount = page.getByRole("banner").getByRole("link", { name: "My account" });
			await toAccount.focus();
			await page.keyboard.press("Enter");
			await expect(page).toHaveURL(accountPath(slug));
			await expect(page.getByRole("heading", { level: 1, name: "My account" })).toBeFocused();
			const leave = page.getByRole("button", { name: "Leave organisation" });
			await leave.focus();
			await expectFocusShown(leave);
			await page.keyboard.press("Enter");
			const leaving = page.getByRole("dialog", { name: `Leave ${name}?` });
			await expect(leaving).toBeVisible();
			await tabTo(page, leaving.getByRole("button", { name: "Cancel" }));
			await tabTo(page, leaving.getByRole("button", { name: "Leave", exact: true }));
			await page.keyboard.press("Escape");
			await expect(leaving).toBeHidden();
			await expectFocusShown(leave);
		});
	});
}

test("creating an organisation: the field, the action and the way out, with the keyboard alone", async ({
	page,
}) => {
	await openOutsideOrganisation(page, "/app/new");

	// The field has the focus when the page arrives, so typing can begin at once.
	await expect(page.getByLabel("Organisation name")).toBeFocused();
	await tabTo(page, page.getByRole("button", { name: "Create organisation" }));
	await tabTo(page, page.getByRole("link", { name: "Back to your organisations" }));
	await tabTo(page, page.getByRole("button", { name: "Use a different email" }));

	// Enter in the field presses the one primary action; a name of spaces is caught there.
	await page.getByLabel("Organisation name").focus();
	await page.keyboard.type("   ");
	await page.keyboard.press("Enter");
	await expect(page.getByText("Enter a name.")).toBeVisible();
	await expect(page.getByLabel("Organisation name")).toBeFocused();
	await expect(page).toHaveURL("/app/new");
});
