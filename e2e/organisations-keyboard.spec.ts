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

/** From a Team page's heading, Tab goes through its four tabs, which sit under it (TS-091, W20). */
async function tabThroughTeamTabs(page: Page) {
	const tabs = page.getByRole("group", { name: "Team pages" });
	for (const tab of ["This week", "Teams", "Members", "Invitations"]) {
		await tabTo(page, tabs.getByRole("link", { name: tab, exact: true }));
	}
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
			const { slug, name, owner, member, guest } = homeOrganisation();
			await openShell(page, homePath("team"));

			// From Team to the members, by the link, with Enter.
			const toMembers = page.getByRole("main").getByRole("link", { name: "Members", exact: true });
			await toMembers.focus();
			await page.keyboard.press("Enter");
			await expect(page).toHaveURL(membersPath(slug));
			// The move puts the focus on the page's heading; Tab goes on from there.
			await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeFocused();

			// The member's actions, after the tabs and the owner's own, which mark
			// them a contractor (TS-079): a menu the arrow keys move through.
			const actions = page.getByRole("button", { name: `Actions for ${member.name}` });
			await tabThroughTeamTabs(page);
			await tabTo(page, page.getByRole("button", { name: `Actions for ${owner.name}` }));
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
			await expect(role.getByRole("radio", { name: /^Finance/ })).toBeChecked();
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
			await tabThroughTeamTabs(page);
			await tabTo(page, invite);
			await page.keyboard.press("Enter");
			const inviting = page.getByRole("dialog", { name: "Invite a person" });
			await expect(inviting.getByLabel("Email address")).toBeFocused();
			// Tab reaches the role, where the arrow keys choose, then the two buttons.
			await page.keyboard.press("Tab");
			await expectRadioFocused(inviting.getByRole("radio", { name: /^Member/ }));
			await page.keyboard.press("ArrowDown");
			await expectRadioFocused(inviting.getByRole("radio", { name: /^Finance/ }));
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

			// Invite many and the import of people come first, then the invitation that is waiting.
			await tabTo(page, page.getByRole("button", { name: "Invite many" }));
			await tabTo(page, page.getByRole("link", { name: "Import people from a CSV" }));
			const cancel = page.getByRole("button", { name: `Cancel the invitation to ${guest.email}` });
			await tabTo(page, cancel);
			await page.keyboard.press("Enter");
			const cancelling = page.getByRole("dialog", { name: "Cancel this invitation?" });
			await expect(cancelling).toBeVisible();
			await tabTo(page, cancelling.getByRole("button", { name: "Keep it" }));
			await page.keyboard.press("Enter");
			await expect(cancelling).toBeHidden();
			await expectFocusShown(cancel);

			// Back to Team by its This week tab, under the heading.
			const back = page.getByRole("main").getByRole("link", { name: "This week" });
			await back.focus();
			await expectFocusShown(back);
			await page.keyboard.press("Enter");
			await expect(page).toHaveURL(homePath("team"));
			await expect(page.getByRole("heading", { level: 1, name: "Team" })).toBeFocused();

			// My account, which the profile menu in the band leads to, does not offer the
			// only owner to leave (TS-091, W26): it says what to do instead, with links to both.
			const profile = page.getByRole("banner").getByRole("button", { name: /^Account menu for / });
			await profile.focus();
			await page.keyboard.press("Enter");
			await expect(page.getByRole("menuitem", { name: "Account settings" })).toBeFocused();
			await page.keyboard.press("Enter");
			await expect(page).toHaveURL(accountPath(slug));
			await expect(page.getByRole("heading", { level: 1, name: "My account" })).toBeFocused();
			await expect(page.getByRole("button", { name: "Leave organisation" })).toHaveCount(0);
			await expect(page.getByText(`You are the only owner of ${name}.`)).toBeVisible();
			const toMembersFromAccount = page
				.getByRole("main")
				.getByRole("link", { name: "Members", exact: true });
			await toMembersFromAccount.focus();
			await expectFocusShown(toMembersFromAccount);
			await page.keyboard.press("Enter");
			await expect(page).toHaveURL(membersPath(slug));
		});
	});
}

test("Escape closes a sheet whose menu is still leaving, and the menu goes with it", async ({
	page,
}) => {
	const { slug, member } = homeOrganisation();
	await openShell(page, membersPath(slug));
	const actions = page.getByRole("button", { name: `Actions for ${member.name}` });
	await actions.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("menuitem", { name: "Change role" })).toBeFocused();
	// The menu has finished arriving, so it leaves by its whole exit: one that
	// turns an arrival around is cut to the part of it that had passed.
	const menu = page.locator(".popover-motion");
	await expect.poll(() => menu.evaluate((popover) => popover.getAnimations().length)).toBe(0);

	// The menu's way out is slowed a thousand times as it starts, so Escape
	// meets it still leaving however long the keys take. Escape is not
	// animated, and the menu must not be left waiting for an exit that Escape
	// cut short (TS-114).
	await page.evaluate(() => {
		new MutationObserver((records) => {
			for (const { target } of records) {
				if (!(target instanceof Element) || !target.matches(".popover-motion[data-exiting]")) {
					continue;
				}
				for (const animation of target.getAnimations()) animation.updatePlaybackRate(0.001);
			}
		}).observe(document.body, {
			subtree: true,
			attributes: true,
			attributeFilter: ["data-exiting"],
		});
	});
	await page.keyboard.press("Enter");
	const role = page.getByRole("dialog", { name: `Change the role of ${member.name}` });
	await expect(role).toBeVisible();
	const leaving = page.locator(".popover-motion[data-exiting]");
	await expect(leaving).toHaveCount(1);
	await expect
		.poll(() => role.evaluate((dialog) => dialog.contains(document.activeElement)))
		.toBe(true);

	await page.keyboard.press("Escape");
	await expect(role).toBeHidden();
	await expect(leaving).toHaveCount(0);
	await expect(page.getByRole("menu")).toHaveCount(0);
	await expectFocusShown(actions);
});

test("creating an organisation: the field, the action and the way out, with the keyboard alone", async ({
	page,
}) => {
	await openOutsideOrganisation(page, "/app/new");

	// The field has the focus when the page arrives, so typing can begin at once.
	await expect(page.getByLabel("Organisation name")).toBeFocused();
	// Then How you work, one stop for the group, at the answer chosen; the arrows choose another (TS-115a).
	const main = page.getByRole("main");
	const model = (name: string) =>
		main
			.getByRole("radiogroup", { name: "How you work" })
			.getByRole("radio", { name: new RegExp(`^${name}`) });
	await page.keyboard.press("Tab");
	await expectRadioFocused(model("Client projects"));
	await expect(model("Client projects")).toBeChecked();
	await page.keyboard.press("ArrowDown");
	await expectRadioFocused(model("Internal work"));
	await expect(model("Internal work")).toBeChecked();
	await page.keyboard.press("ArrowUp");
	await expect(model("Client projects")).toBeChecked();
	// What creating it accepts, each a link, then the action (TS-105).
	await tabTo(page, main.getByRole("link", { name: "terms", exact: true }));
	await tabTo(page, main.getByRole("link", { name: "data processing agreement", exact: true }));
	await tabTo(page, page.getByRole("button", { name: "Create organisation" }));
	// Named for where it goes: the one organisation, or the list of several (W31).
	await tabTo(page, page.getByRole("link", { name: /^Back to / }));
	// The way out is in the profile menu at the end of the band, just before the field.
	await page.getByLabel("Organisation name").focus();
	await page.keyboard.press("Shift+Tab");
	const profile = page.getByRole("banner").getByRole("button", { name: /^Account menu for / });
	await expectFocusShown(profile);
	await page.keyboard.press("ArrowDown");
	await expect(page.getByRole("menuitem", { name: "Use a different email" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expectFocusShown(profile);

	// Enter in the field presses the one primary action; a name of spaces is caught there.
	await page.getByLabel("Organisation name").focus();
	await page.keyboard.type("   ");
	await page.keyboard.press("Enter");
	await expect(page.getByText("Enter a name.")).toBeVisible();
	await expect(page.getByLabel("Organisation name")).toBeFocused();
	await expect(page).toHaveURL("/app/new");
});
