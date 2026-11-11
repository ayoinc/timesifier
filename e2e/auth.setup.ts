import { ARRIVAL, newPerson, ownAddress, signUp } from "./auth";
import { SIGNED_IN } from "./auth-state";
import { expect, test as setup } from "./fixtures";
import { createOrganisation, saveHomeOrganisation } from "./organisation";

// Runs once, before the Chromium tests. Everything under /app needs a session,
// and the shell belongs to an organisation, so one person signs up through the
// page here and creates an organisation; their session and the organisation's
// address are saved, and the tests of the shell start with both
// (playwright.config.ts, ./organisation.ts). No test may end this session or
// change this organisation: a test that signs out, renames, invites or deletes
// makes a person and an organisation of its own.

setup(
	"a person signs up and creates an organisation, and both are kept for the other tests",
	async ({ page, context, baseURL }) => {
		await ownAddress(context, baseURL);
		await signUp(page, newPerson());
		await page.getByRole("button", { name: "Not now" }).click();
		// A person with no organisation is sent to create their first.
		await expect(page).toHaveURL(ARRIVAL);

		saveHomeOrganisation(await createOrganisation(page));
		await context.storageState({ path: SIGNED_IN });
	},
);
