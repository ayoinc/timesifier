import type { Browser, Page } from "@playwright/test";

import { ARRIVAL, foundInMessageSentBy, ownAddress, type Person, setName, signIn } from "./auth";
import { SIGNED_IN, SIGNED_IN_AS_GUEST, SIGNED_IN_AS_MEMBER, SIGNED_OUT } from "./auth-state";
import { expect, test as setup } from "./fixtures";
import {
	createOrganisation,
	INVITATION_LINK,
	invite,
	openMembers,
	saveHomeOrganisation,
} from "./organisation";

// Runs once, before the Chromium tests. Everything under /app needs a session,
// and the shell belongs to an organisation, so one person signs in through the
// page here for the first time, creates an organisation and gives their name in
// its Settings. Two more people follow, for the tests of an organisation's
// pages that only look: one accepts an invitation to it, gives their name, and
// creates an organisation of their own; the other leaves theirs unanswered, and
// so has no Settings and no name. The three sessions and what the tests need to
// know about the organisation are saved (./auth-state.ts, ./organisation.ts).
//
// No test may end one of these sessions or change this organisation: a test
// that signs out, renames, invites, removes or deletes makes people and an
// organisation of its own.

const run = crypto.randomUUID().slice(0, 8);
const owner: Person = { name: "Ada Lovelace", email: `ada-${run}@example.com` };
const member: Person = { name: "Grace Hopper", email: `grace-${run}@example.com` };
const guest = { email: `hedy-${run}@example.com` };

/** Somebody with a browser of their own, signed out, at a client address of their own. */
async function newBrowser(browser: Browser, baseURL: string | undefined): Promise<Page> {
	const context = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
	await ownAddress(context, baseURL);
	return context.newPage();
}

/** Signs in for the first time on the way to an invitation, and arrives at its page. */
async function signInFor(page: Page, email: string, invitation: string, organisation: string) {
	await signIn(page, email, `/sign-in?next=${encodeURIComponent(invitation)}`);
	await expect(page).toHaveURL(invitation);
	await expect(
		page.getByRole("heading", { level: 1, name: `Join ${organisation}?` }),
	).toBeVisible();
}

setup(
	"three people sign in around one organisation, and their sessions are kept for the other tests",
	async ({ page, context, browser, baseURL }) => {
		setup.setTimeout(180_000);

		await ownAddress(context, baseURL);
		await signIn(page, owner.email);
		// A person with no organisation is sent to create their first.
		await expect(page).toHaveURL(ARRIVAL);
		const home = await createOrganisation(page);
		await setName(page, owner.name);
		await context.storageState({ path: SIGNED_IN });

		await openMembers(page, home.slug);
		const forMember = await foundInMessageSentBy(
			() => invite(page, member.email),
			INVITATION_LINK,
			"the invitation's link",
		);
		const forGuest = await foundInMessageSentBy(
			() => invite(page, guest.email, "Admin"),
			INVITATION_LINK,
			"the invitation's link",
		);

		const membersPage = await newBrowser(browser, baseURL);
		await signInFor(membersPage, member.email, forMember, home.name);
		await membersPage.getByRole("button", { name: "Join" }).click();
		await expect(membersPage.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
		// While this is their one organisation, its Settings is where `/app` leads.
		await setName(membersPage, member.name);
		const membersOwn = await createOrganisation(membersPage);
		await membersPage.context().storageState({ path: SIGNED_IN_AS_MEMBER });
		await membersPage.context().close();

		const guestsPage = await newBrowser(browser, baseURL);
		await signInFor(guestsPage, guest.email, forGuest, home.name);
		await guestsPage.context().storageState({ path: SIGNED_IN_AS_GUEST });
		await guestsPage.context().close();

		saveHomeOrganisation({
			...home,
			owner,
			member,
			membersOwn,
			guest,
			guestInvitation: forGuest,
		});
	},
);
