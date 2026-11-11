import { randomUUID } from "node:crypto";

import {
	destinationPath,
	destinations,
	membersPath,
	organisationPath,
} from "../app/shell/destinations";
import {
	ARRIVAL,
	foundInMessageSentBy,
	newPerson,
	ownAddress,
	type Person,
	signUp,
	TIME_WITH_TURNS,
} from "./auth";
import { SIGNED_IN_AS_MEMBER, SIGNED_OUT } from "./auth-state";
import { expect, openShell, test } from "./fixtures";
import {
	createOrganisation,
	expectRefusal,
	homeOrganisation,
	homePath,
	INVITATION_LINK,
	openMembers,
	openOutsideOrganisation,
} from "./organisation";

// The journeys of card TS-009, each walked in a browser against the production
// build: create the first organisation, rename it, invite a second person, who
// joins from the link in their email in a browser of their own; roles, removal,
// the last owner, deletion; and what a person sees of an organisation that is
// not theirs. The people here are new, and so are their organisations: the
// organisation the shell's tests run in is never changed.

const NOT_FOUND = "The requested page could not be found.";

test.describe("a person who has just signed up", () => {
	test.use({ storageState: SIGNED_OUT });
	test.describe.configure({ timeout: TIME_WITH_TURNS });

	test.beforeEach(async ({ context, baseURL }) => {
		await ownAddress(context, baseURL);
	});

	for (const viewport of [
		{ width: 390, height: 844 },
		{ width: 1280, height: 800 },
	]) {
		test.describe(`in a window ${viewport.width}px wide`, () => {
			test.use({ viewport });

			test("creates their first organisation and lands on its Today, with the navigation in it", async ({
				page,
				refusals,
			}) => {
				const person = newPerson();
				await signUp(page, person);
				await page.getByRole("button", { name: "Not now" }).click();

				// No organisation yet: one field, one primary action, and no navigation.
				await expect(page).toHaveURL(ARRIVAL);
				await expect(
					page.getByRole("heading", { level: 1, name: "Create your organisation" }),
				).toBeVisible();
				await expect(page.getByRole("navigation")).toHaveCount(0);
				await expect(page.getByRole("textbox")).toHaveCount(1);
				await expect(page.getByRole("main").getByRole("button")).toHaveText([
					"Create organisation",
				]);
				await expect(page.getByText(`Signed in as ${person.email}`)).toBeVisible();

				const { name, slug } = await createOrganisation(page);

				// Its Today, with the moment marked.
				await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
				await expect(page.getByText(`${name} is ready`)).toBeVisible();
				await expect(page.getByText("You are its owner.")).toBeVisible();

				// The four destinations, each at its address in this organisation.
				const links = page.getByRole("navigation", { name: "Main" }).getByRole("link");
				await expect(links).toHaveText(destinations.map(({ label }) => label));
				for (const { id, label } of destinations) {
					await expect(links.filter({ hasText: label })).toHaveAttribute(
						"href",
						destinationPath(slug, id),
					);
				}
				await expect(links.filter({ hasText: "Today" })).toHaveAttribute("aria-current", "page");

				// A move stays inside the organisation, and the welcome was for the moment alone.
				await links.filter({ hasText: "Reports" }).click();
				await expect(page).toHaveURL(destinationPath(slug, "reports"));
				await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeFocused();
				await links.filter({ hasText: "Today" }).click();
				await expect(page).toHaveURL(organisationPath(slug));
				await expect(page.getByText(`${name} is ready`)).toHaveCount(0);

				// From now on /app is this organisation.
				await page.goto("/app");
				await expect(page).toHaveURL(organisationPath(slug));

				// Another organisation's address is the 404 page, and says nothing of it.
				for (const id of ["today", "settings"] as const) {
					expectRefusal(refusals, homePath(id), 404);
					const response = await page.goto(homePath(id));
					expect(response?.status()).toBe(404);
					await expect(page.getByText(NOT_FOUND)).toBeVisible();
					await expect(page.getByText(homeOrganisation().name)).toHaveCount(0);
					await expect(page.getByRole("navigation")).toHaveCount(0);
				}
				expectRefusal(refusals, membersPath(homeOrganisation().slug), 404);
				expect((await page.goto(membersPath(homeOrganisation().slug)))?.status()).toBe(404);
				// The same page as for an organisation that does not exist.
				const nobodys = organisationPath(`nobody-${randomUUID().slice(0, 8)}`);
				expectRefusal(refusals, nobodys, 404);
				expect((await page.goto(nobodys))?.status()).toBe(404);
				await expect(page.getByText(NOT_FOUND)).toBeVisible();
			});
		});
	}

	test("an organisation's life: renamed, a second person invited and joined, roles, removal, the last owner, deletion", async ({
		page,
		browser,
		baseURL,
		refusals,
	}) => {
		test.setTimeout(3 * TIME_WITH_TURNS);
		const ada = newPerson();
		const bob: Person = { name: "Bob Babbage", email: `bob-${randomUUID()}@example.com` };

		await signUp(page, ada);
		await page.getByRole("button", { name: "Not now" }).click();
		const { name: firstName, slug } = await createOrganisation(page);
		const settings = destinationPath(slug, "settings");
		const members = membersPath(slug);

		// Rename it, in a sheet. Its address stays.
		await openShell(page, settings);
		await page.getByRole("button", { name: "Rename" }).click();
		const rename = page.getByRole("dialog", { name: "Rename the organisation" });
		await expect(rename.getByLabel("Organisation name")).toHaveValue(firstName);
		const name = `${firstName} Ltd`;
		await rename.getByLabel("Organisation name").fill(name);
		await rename.getByRole("button", { name: "Save" }).click();
		await expect(rename).toBeHidden();
		await expect(page.getByRole("status")).toHaveText(`The organisation is now called ${name}.`);
		await expect(page.getByText(`Shared by everyone in ${name}.`)).toBeVisible();
		await expect(page).toHaveURL(settings);

		// The members page of a new organisation: the one member, and what inviting does.
		await page.getByRole("link", { name: "Members and invitations" }).click();
		await expect(page).toHaveURL(members);
		await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeFocused();
		const listed = page.getByRole("list", { name: "Members" }).getByRole("listitem");
		await expect(listed).toHaveCount(1);
		await expect(listed).toContainText([`${ada.name} (you)`]);
		await expect(page.getByText("You are the only one here.")).toBeVisible();

		// Invite Bob, with the keyboard alone: Enter opens the sheet, and Enter in its field sends it.
		const inviteButton = page.getByRole("button", { name: "Invite a person" });
		await inviteButton.focus();
		await page.keyboard.press("Enter");
		const inviting = page.getByRole("dialog", { name: "Invite a person" });
		await expect(inviting.getByLabel("Email address")).toBeFocused();
		await page.keyboard.type(bob.email);
		const link = await foundInMessageSentBy(
			() => page.keyboard.press("Enter"),
			INVITATION_LINK,
			"the invitation's link",
		);
		await expect(inviting).toBeHidden();
		await expect(inviteButton).toBeFocused();
		await expect(page.getByRole("status")).toContainText(
			`An invitation is on its way to ${bob.email}.`,
		);
		const waiting = page.getByRole("list", { name: "Invitations" }).getByRole("listitem");
		await expect(waiting).toHaveCount(1);
		await expect(waiting).toContainText([bob.email]);
		await expect(waiting).toContainText(["Invited as a member."]);
		await expect(page.getByText("You are the only one here.")).toHaveCount(0);

		// Bob opens the link from his email in a browser of his own. He has no
		// session, so he is sent to sign in, and from there to make an account;
		// the invitation is where he arrives.
		const bobs = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
		await ownAddress(bobs, baseURL);
		const other = await bobs.newPage();
		await other.goto(link);
		await expect(other).toHaveURL(`/sign-in?next=${encodeURIComponent(link)}`);
		await other.getByRole("link", { name: "Create an account" }).click();
		await expect(other).toHaveURL(`/sign-up?next=${encodeURIComponent(link)}`);
		await signUp(other, bob, other.url());
		await other.getByRole("button", { name: "Not now" }).click();
		await expect(other).toHaveURL(link);
		await expect(other.getByRole("heading", { level: 1, name: `Join ${name}?` })).toBeVisible();
		await expect(
			other.getByText(`${ada.name} (${ada.email}) invited you to join ${name} as a member.`),
		).toBeVisible();
		// One primary action, and Decline beside it.
		await expect(other.getByRole("main").getByRole("button")).toHaveText(["Join", "Decline"]);
		await other.getByRole("button", { name: "Join" }).click();
		await expect(other).toHaveURL(organisationPath(slug));
		await expect(other.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();

		// The link works once.
		const used = await other.goto(link);
		expect(used?.status()).toBe(410);
		await expect(
			other.getByRole("heading", { level: 1, name: "This invitation is no longer valid" }),
		).toBeVisible();
		await expect(other.getByText(name)).toHaveCount(0);
		await other.getByRole("link", { name: "Go to Timesifier" }).click();
		await expect(other).toHaveURL(organisationPath(slug));

		// Bob, a member, sees who is in the organisation and none of the owner's controls.
		await openMembers(other, slug);
		const bobSees = other.getByRole("list", { name: "Members" }).getByRole("listitem");
		await expect(bobSees).toHaveCount(2);
		await expect(bobSees.filter({ hasText: bob.email })).toContainText(`${bob.name} (you)`);
		await expect(bobSees.filter({ hasText: bob.email })).toContainText("Member");
		await expect(bobSees.filter({ hasText: ada.email })).toContainText("Owner");
		await expect(other.getByRole("button", { name: "Invite a person" })).toHaveCount(0);
		await expect(other.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
		await expect(other.getByRole("heading", { name: "Invitations" })).toHaveCount(0);
		await expect(other.getByRole("main").getByRole("button")).toHaveText(["Leave organisation"]);
		await openShell(other, settings);
		await expect(other.getByText(`Shared by everyone in ${name}. You are a member.`)).toBeVisible();
		await expect(other.getByRole("button", { name: "Rename" })).toHaveCount(0);
		await expect(other.getByRole("button", { name: "Delete organisation" })).toHaveCount(0);

		// Ada sees Bob listed, and the invitation is no longer waiting.
		await openMembers(page, slug);
		const bobsRow = listed.filter({ hasText: bob.email });
		await expect(listed).toHaveCount(2);
		await expect(bobsRow).toContainText(bob.name);
		await expect(bobsRow).toContainText("Member");
		await expect(page.getByRole("heading", { name: "Invitations" })).toHaveCount(0);

		// She makes him an admin.
		await page.getByRole("button", { name: `Actions for ${bob.name}` }).click();
		await page.getByRole("menuitem", { name: "Change role" }).click();
		const role = page.getByRole("dialog", { name: `Change the role of ${bob.name}` });
		await expect(role.getByRole("radio", { name: /^Member/ })).toBeChecked();
		await role.getByText("Admin", { exact: true }).click();
		await role.getByRole("button", { name: "Save" }).click();
		await expect(role).toBeHidden();
		await expect(page.getByRole("status")).toHaveText("Role changed. They are now an admin.");
		await expect(bobsRow).toContainText("Admin");
		// Which Bob's own page now shows him, with what an admin may do.
		await openMembers(other, slug);
		await expect(other.getByRole("button", { name: "Invite a person" })).toBeVisible();
		await expect(other.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);

		// She removes him, and the organisation is the 404 page to him.
		await page.getByRole("button", { name: `Actions for ${bob.name}` }).click();
		await page.getByRole("menuitem", { name: "Remove from organisation" }).click();
		const remove = page.getByRole("dialog", { name: `Remove ${bob.name}?` });
		await remove.getByRole("button", { name: "Remove" }).click();
		await expect(remove).toBeHidden();
		await expect(page.getByRole("status")).toContainText("Member removed.");
		await expect(listed).toHaveCount(1);
		// The control that opened the sheet has gone with him: the focus is on the heading.
		await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeFocused();
		for (const address of [members, settings, organisationPath(slug)]) {
			const response = await other.goto(address);
			expect(response?.status(), address).toBe(404);
			await expect(other.getByText(NOT_FOUND)).toBeVisible();
		}
		await bobs.close();

		// The last owner cannot leave, and is told why.
		expectRefusal(refusals, `${members}.data`, 400);
		await page.getByRole("button", { name: "Leave organisation" }).click();
		const leave = page.getByRole("dialog", { name: `Leave ${name}?` });
		await leave.getByRole("button", { name: "Leave", exact: true }).click();
		await expect(leave.getByRole("alert")).toHaveText(
			"You are the only owner of this organisation. Make another member an owner before you leave.",
		);
		await expect(leave).toBeVisible();
		await leave.getByRole("button", { name: "Cancel" }).click();
		await expect(leave).toBeHidden();
		await expect(listed).toHaveCount(1);

		// Deleting is behind its own control in Settings, and asks for the name.
		await page.getByRole("main").getByRole("link", { name: "Settings" }).click();
		await expect(page).toHaveURL(settings);
		await page.getByRole("button", { name: "Delete organisation" }).click();
		const deleting = page.getByRole("dialog", { name: `Delete ${name}?` });
		await deleting.getByLabel("Organisation name").fill(firstName);
		await deleting.getByRole("button", { name: "Delete organisation" }).click();
		await expect(deleting.getByText("Type the name exactly as it is shown.")).toBeVisible();
		await expect(page).toHaveURL(settings);
		await deleting.getByLabel("Organisation name").fill(name);
		await deleting.getByRole("button", { name: "Delete organisation" }).click();

		// With no organisation left, she is where a new person starts.
		await expect(page).toHaveURL(ARRIVAL);
		await expect(
			page.getByRole("heading", { level: 1, name: "Create your organisation" }),
		).toBeVisible();
		expectRefusal(refusals, organisationPath(slug), 404);
		expect((await page.goto(organisationPath(slug)))?.status()).toBe(404);
	});

	test("an invitation is declined, and the same link is then no longer valid", async ({
		page,
		browser,
		baseURL,
	}) => {
		test.setTimeout(2 * TIME_WITH_TURNS);
		const bob: Person = { name: "Bob Babbage", email: `bob-${randomUUID()}@example.com` };
		await signUp(page, newPerson());
		await page.getByRole("button", { name: "Not now" }).click();
		const { slug } = await createOrganisation(page);
		await openMembers(page, slug);
		await page.getByRole("button", { name: "Invite a person" }).click();
		const inviting = page.getByRole("dialog", { name: "Invite a person" });
		await inviting.getByLabel("Email address").fill(bob.email);
		await inviting.getByText("Admin", { exact: true }).click();
		const link = await foundInMessageSentBy(
			() => inviting.getByRole("button", { name: "Send invitation" }).click(),
			INVITATION_LINK,
			"the invitation's link",
		);
		await expect(page.getByText("Invited as an admin.")).toBeVisible();

		const bobs = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
		await ownAddress(bobs, baseURL);
		const other = await bobs.newPage();
		await signUp(other, bob, `/sign-up?next=${encodeURIComponent(link)}`);
		await other.getByRole("button", { name: "Not now" }).click();
		await expect(other.getByText("as an admin.")).toBeVisible();
		await other.getByRole("button", { name: "Decline" }).click();

		// Bob belongs to nothing, so /app sends him to create an organisation.
		await expect(other).toHaveURL(ARRIVAL);
		expect((await other.goto(link))?.status()).toBe(410);
		await expect(
			other.getByRole("heading", { level: 1, name: "This invitation is no longer valid" }),
		).toBeVisible();
		expect((await other.goto(organisationPath(slug)))?.status()).toBe(404);
		await bobs.close();

		// Ada cancels nothing: the invitation is simply no longer waiting.
		await openMembers(page, slug);
		await expect(page.getByRole("heading", { name: "Invitations" })).toHaveCount(0);
		await expect(page.getByRole("list", { name: "Members" }).getByRole("listitem")).toHaveCount(1);
	});

	test("an invitation is cancelled, and its link is then no longer valid to the person it was for", async ({
		page,
		browser,
		baseURL,
	}) => {
		test.setTimeout(2 * TIME_WITH_TURNS);
		const bob: Person = { name: "Bob Babbage", email: `bob-${randomUUID()}@example.com` };
		await signUp(page, newPerson());
		await page.getByRole("button", { name: "Not now" }).click();
		const { slug } = await createOrganisation(page);
		await openMembers(page, slug);
		await page.getByRole("button", { name: "Invite a person" }).click();
		const inviting = page.getByRole("dialog", { name: "Invite a person" });
		await inviting.getByLabel("Email address").fill(bob.email);
		const link = await foundInMessageSentBy(
			() => inviting.getByRole("button", { name: "Send invitation" }).click(),
			INVITATION_LINK,
			"the invitation's link",
		);

		// Cancelling asks first, and "Keep it" leaves the invitation alone.
		const cancel = page.getByRole("button", { name: `Cancel the invitation to ${bob.email}` });
		const asking = page.getByRole("dialog", { name: "Cancel this invitation?" });
		await cancel.click();
		await expect(asking).toContainText(bob.email);
		await asking.getByRole("button", { name: "Keep it" }).click();
		await expect(asking).toBeHidden();
		await expect(cancel).toBeVisible();
		await cancel.click();
		await asking.getByRole("button", { name: "Cancel invitation" }).click();
		await expect(asking).toBeHidden();
		await expect(page.getByRole("status")).toContainText("Invitation cancelled.");
		await expect(cancel).toHaveCount(0);
		await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeFocused();

		const bobs = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
		await ownAddress(bobs, baseURL);
		const other = await bobs.newPage();
		await signUp(other, bob, `/sign-up?next=${encodeURIComponent(link)}`);
		await other.getByRole("button", { name: "Not now" }).click();
		await expect(other).toHaveURL(link);
		await expect(
			other.getByRole("heading", { level: 1, name: "This invitation is no longer valid" }),
		).toBeVisible();
		await expect(other.getByRole("button")).toHaveCount(0);
		await bobs.close();
	});
});

test.describe("a person who belongs to two organisations", () => {
	test.use({ storageState: SIGNED_IN_AS_MEMBER });

	test("is shown both at /app, opens one, and can come back to choose the other", async ({
		page,
	}) => {
		const home = homeOrganisation();
		await openOutsideOrganisation(page, "/app");

		await expect(page.getByRole("heading", { level: 1, name: "Your organisations" })).toBeVisible();
		const choices = page.getByRole("main").getByRole("list").getByRole("link");
		await expect(choices).toHaveText([home.name, home.membersOwn.name]);
		await expect(page.getByRole("link", { name: "Create an organisation" })).toHaveAttribute(
			"href",
			"/app/new",
		);
		await expect(page.getByRole("navigation")).toHaveCount(0);

		await choices.filter({ hasText: home.membersOwn.name }).click();
		await expect(page).toHaveURL(organisationPath(home.membersOwn.slug));
		await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeFocused();

		// Settings says whose it is, and leads back to the choice.
		await page.getByRole("navigation").getByRole("link", { name: "Settings" }).click();
		await expect(
			page.getByText(`Shared by everyone in ${home.membersOwn.name}. You are an owner.`),
		).toBeVisible();
		await page.getByRole("link", { name: "Switch organisation" }).click();
		await expect(page).toHaveURL("/app");
		await page.getByRole("link", { name: home.name, exact: true }).click();
		await expect(page).toHaveURL(organisationPath(home.slug));
		await page.getByRole("navigation").getByRole("link", { name: "Settings" }).click();
		await expect(
			page.getByText(`Shared by everyone in ${home.name}. You are a member.`),
		).toBeVisible();
	});

	test("creating another organisation is not the first: no welcome, and a way back", async ({
		page,
	}) => {
		await openOutsideOrganisation(page, "/app/new");
		await expect(
			page.getByRole("heading", { level: 1, name: "Create an organisation" }),
		).toBeVisible();
		await page.getByRole("link", { name: "Back to your organisations" }).click();
		await expect(page).toHaveURL("/app");
	});
});

test.describe("a name a person could not mean", () => {
	test("is caught in the field before anything is sent", async ({ page }) => {
		await openOutsideOrganisation(page, "/app/new");
		await page.getByLabel("Organisation name").fill("   ");
		await page.getByRole("button", { name: "Create organisation" }).click();

		await expect(page.getByText("Enter a name.")).toBeVisible();
		await expect(page).toHaveURL("/app/new");
	});
});
