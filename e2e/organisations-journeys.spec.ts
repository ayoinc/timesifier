import { randomUUID } from "node:crypto";

import {
	accountPath,
	destinationPath,
	destinations,
	invitationsPath,
	membersPath,
	organisationPath,
} from "../app/shell/destinations";
import {
	ARRIVAL,
	accountMenuName,
	chooseAccountSettings,
	foundInMessageSentBy,
	newPerson,
	ownAddress,
	type Person,
	profileButton,
	setName,
	signIn,
	TIME_WITH_TURNS,
} from "./auth";
import { SIGNED_IN_AS_MEMBER, SIGNED_OUT } from "./auth-state";
import { destinationLinks, expect, openShell, test } from "./fixtures";
import {
	createOrganisation,
	expectRefusal,
	homeOrganisation,
	homePath,
	INVITATION_LINK,
	openInvitations,
	openMembers,
	openOutsideOrganisation,
} from "./organisation";

// The journeys of card TS-009, each walked in a browser against the production
// build: create the first organisation, rename it, invite a second person, who
// joins from the link in their email in a browser of their own; roles, removal,
// the last owner, deletion; and what a person sees of an organisation that is
// not theirs. The people here are new, and so are their organisations: the
// organisation the shell's tests run in is never changed.

const NOT_FOUND = "There is no page at this address, or it is not yours to open.";

test.describe("a person who has just signed in for the first time", () => {
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

			test("creates their first organisation and lands on its Timesheet, with the navigation in it", async ({
				page,
				refusals,
			}) => {
				const person = newPerson();
				await signIn(page, person.email);

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
				await expect(profileButton(page)).toHaveAccessibleName(accountMenuName(person.email));

				const { name, slug } = await createOrganisation(page);

				// Its Timesheet, with the moment marked.
				await expect(page.getByRole("heading", { level: 1, name: "Timesheet" })).toBeVisible();
				await expect(page.getByText(`${name} is ready`)).toBeVisible();
				await expect(page.getByText("You are its owner.")).toBeVisible();

				// Every destination, for its owner, each at its address in this
				// organisation: under 600px those the bar has no room for are in More.
				const links = page
					.getByRole("navigation", { name: "Main" })
					.locator("ul")
					.first()
					.getByRole("link", { includeHidden: true });
				// A link with a bar label holds both words; its label alone is what is read out.
				await expect(links).toHaveText(
					destinations.map(({ label, barLabel }) => `${barLabel ?? ""}${label}`),
				);
				for (const { id, label } of destinations) {
					await expect(links.filter({ hasText: label })).toHaveAttribute(
						"href",
						destinationPath(slug, id),
					);
				}
				await expect(links.filter({ hasText: "Timesheet" })).toHaveAttribute(
					"aria-current",
					"page",
				);

				// A move stays inside the organisation, and the welcome was for the moment alone.
				await links.filter({ hasText: "Projects" }).click();
				await expect(page).toHaveURL(destinationPath(slug, "projects"));
				await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeFocused();
				await links.filter({ hasText: "Timesheet" }).click();
				await expect(page).toHaveURL(organisationPath(slug));
				await expect(page.getByText(`${name} is ready`)).toHaveCount(0);

				// From now on /app is this organisation.
				await page.goto("/app");
				await expect(page).toHaveURL(organisationPath(slug));

				// Another organisation's address is the 404 page, and says nothing of it.
				for (const id of ["timesheet", "settings"] as const) {
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

		await signIn(page, ada.email);
		const { name: firstName, slug } = await createOrganisation(page);
		// Nobody asked her name on the way in. She gives it where a person does.
		await setName(page, ada.name);
		const settings = destinationPath(slug, "settings");
		const members = membersPath(slug);
		const invitations = invitationsPath(slug);
		const account = accountPath(slug);

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

		// The members of a new organisation, under Team: the one member, and where inviting is.
		await page.getByRole("navigation").getByRole("link", { name: "Team" }).click();
		await page.getByRole("main").getByRole("link", { name: "Members", exact: true }).click();
		await expect(page).toHaveURL(members);
		await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeFocused();
		const listed = page.getByRole("list", { name: "Members" }).getByRole("listitem");
		await expect(listed).toHaveCount(1);
		await expect(listed).toContainText([`${ada.name} (you)`]);
		await expect(page.getByText("You are the only one here.")).toBeVisible();
		await page
			.getByRole("group", { name: "Team pages" })
			.getByRole("link", { name: "Invitations" })
			.click();
		await expect(page).toHaveURL(invitations);
		await expect(page.getByRole("heading", { level: 1, name: "Invitations" })).toBeFocused();
		await expect(page.getByText("No invitation is waiting.")).toBeVisible();

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
		await expect(page.getByText("No invitation is waiting.")).toHaveCount(0);

		// Bob opens the link from his email in a browser of his own. He has no
		// session and no account, so he is sent to the one page that signs
		// anybody in; the invitation is where he arrives.
		const bobs = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
		await ownAddress(bobs, baseURL);
		const other = await bobs.newPage();
		await other.goto(link);
		await expect(other).toHaveURL(`/sign-in?next=${encodeURIComponent(link)}`);
		await signIn(other, bob.email, other.url());
		await expect(other).toHaveURL(link);
		await expect(other.getByRole("heading", { level: 1, name: `Join ${name}?` })).toBeVisible();
		await expect(
			other.getByText(`${ada.name} (${ada.email}) invited you to join ${name} as a member.`),
		).toBeVisible();
		// One primary action, and Decline beside it.
		await expect(other.getByRole("main").getByRole("button")).toHaveText(["Join", "Decline"]);
		await other.getByRole("button", { name: "Join" }).click();
		await expect(other).toHaveURL(organisationPath(slug));
		await expect(other.getByRole("heading", { level: 1, name: "Timesheet" })).toBeVisible();

		// The link works once.
		const used = await other.goto(link);
		expect(used?.status()).toBe(410);
		await expect(
			other.getByRole("heading", { level: 1, name: "This invitation is no longer valid" }),
		).toBeVisible();
		await expect(other.getByText(name)).toHaveCount(0);
		await other.getByRole("link", { name: "Go to Timesifier" }).click();
		await expect(other).toHaveURL(organisationPath(slug));

		// Until he gives a name, the others see his address. He gives one on My account.
		await setName(other, bob.name);

		// Bob, a member, is shown Timesheet, Time off, Expenses, Projects and
		// Reports. Team and Workspace settings are not his to open: their addresses are the 404 page.
		await openShell(other, organisationPath(slug));
		await expect(destinationLinks(other)).toHaveText([
			"Timesheet",
			"Time off",
			"Expenses",
			"Projects",
			"Reports",
		]);
		for (const address of [members, invitations, settings]) {
			expect((await other.goto(address))?.status(), address).toBe(404);
			await expect(other.getByText(NOT_FOUND)).toBeVisible();
		}
		// Leaving is his, on My account.
		await openShell(other, account);
		await expect(other.getByText(`You are a member of ${name}.`)).toBeVisible();
		await expect(other.getByRole("button", { name: "Leave organisation" })).toBeVisible();

		// Ada sees Bob listed, and the invitation is no longer waiting.
		await openMembers(page, slug);
		const bobsRow = listed.filter({ hasText: bob.email });
		await expect(listed).toHaveCount(2);
		await expect(bobsRow).toContainText(bob.name);
		await expect(bobsRow).toContainText("Member");
		await openInvitations(page, slug);
		await expect(page.getByText("No invitation is waiting.")).toBeVisible();
		await openMembers(page, slug);

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
		// Which Bob's own pages now show him, with what an admin may do.
		await openMembers(other, slug);
		await expect(other.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
		await openInvitations(other, slug);
		await expect(other.getByRole("button", { name: "Invite a person" })).toBeVisible();

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
		for (const address of [members, settings, account, organisationPath(slug)]) {
			const response = await other.goto(address);
			expect(response?.status(), address).toBe(404);
			await expect(other.getByText(NOT_FOUND)).toBeVisible();
		}
		await bobs.close();

		// The last owner is not offered to leave, and is told what to do instead (TS-091, W26).
		await chooseAccountSettings(page);
		await expect(page).toHaveURL(account);
		await expect(page.getByRole("button", { name: "Leave organisation" })).toHaveCount(0);
		await expect(
			page.getByText(
				`You are the only owner of ${name}. Make someone else an owner on Members, or delete the organisation in Workspace settings.`,
			),
		).toBeVisible();

		// Deleting is behind its own control in Workspace settings, and asks for the name:
		// the confirmation waits until it is typed exactly (W27).
		await page
			.getByRole("main")
			.getByRole("link", { name: "Workspace settings", exact: true })
			.click();
		await expect(page).toHaveURL(settings);
		await page.getByRole("button", { name: "Delete organisation" }).click();
		const deleting = page.getByRole("dialog", { name: `Delete ${name}?` });
		const confirm = deleting.getByRole("button", { name: "Delete organisation" });
		await expect(confirm).toBeDisabled();
		await deleting.getByLabel("Organisation name").fill(firstName);
		await expect(confirm).toBeDisabled();
		await deleting.getByLabel("Organisation name").fill(`${name} `);
		await expect(confirm).toBeDisabled();
		await deleting.getByLabel("Organisation name").fill(name);
		await expect(confirm).toBeEnabled();
		await confirm.click();

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
		await signIn(page, newPerson().email);
		const { slug } = await createOrganisation(page);
		await openInvitations(page, slug);
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
		await signIn(other, bob.email, `/sign-in?next=${encodeURIComponent(link)}`);
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
		await openInvitations(page, slug);
		await expect(page.getByText("No invitation is waiting.")).toBeVisible();
		await openMembers(page, slug);
		await expect(page.getByRole("list", { name: "Members" }).getByRole("listitem")).toHaveCount(1);
	});

	test("an invitation is cancelled, and its link is then no longer valid to the person it was for", async ({
		page,
		browser,
		baseURL,
	}) => {
		test.setTimeout(2 * TIME_WITH_TURNS);
		const bob: Person = { name: "Bob Babbage", email: `bob-${randomUUID()}@example.com` };
		await signIn(page, newPerson().email);
		const { slug } = await createOrganisation(page);
		await openInvitations(page, slug);
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
		await expect(page.getByRole("heading", { level: 1, name: "Invitations" })).toBeFocused();

		const bobs = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
		await ownAddress(bobs, baseURL);
		const other = await bobs.newPage();
		await signIn(other, bob.email, `/sign-in?next=${encodeURIComponent(link)}`);
		await expect(other).toHaveURL(link);
		await expect(
			other.getByRole("heading", { level: 1, name: "This invitation is no longer valid" }),
		).toBeVisible();
		// Nothing to press in the page itself. Under it: whose session this is, and the way back.
		await expect(other.getByRole("main").getByRole("button")).toHaveCount(0);
		await expect(other.getByText(`Signed in as ${bob.email}`)).toBeVisible();
		await expect(other.getByRole("button")).toHaveText(["Use a different email"]);
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
		await expect(page.getByRole("heading", { level: 1, name: "Timesheet" })).toBeFocused();

		// My account says whose organisation it is, and leads back to the choice.
		await chooseAccountSettings(page);
		await expect(page.getByText(`You are an owner of ${home.membersOwn.name}.`)).toBeVisible();
		await page.getByRole("link", { name: "Switch organisation" }).click();
		await expect(page).toHaveURL("/app");
		await page.getByRole("link", { name: home.name, exact: true }).click();
		await expect(page).toHaveURL(organisationPath(home.slug));
		await chooseAccountSettings(page);
		await expect(page.getByText(`You are a member of ${home.name}.`)).toBeVisible();
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
