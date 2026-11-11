import { newPerson, ownAddress, signUp } from "./auth";
import { SIGNED_IN } from "./auth-state";
import { expect, test as setup } from "./fixtures";

// Runs once, before the Chromium tests. Everything under /app needs a session,
// so one person signs up through the page here and their session is saved; the
// tests of the shell start with it (playwright.config.ts). No test may end this
// session: a test that signs out makes a person of its own.

setup(
	"a person signs up, and the session is kept for the other tests",
	async ({ page, context, baseURL }) => {
		await ownAddress(context, baseURL);
		await signUp(page, newPerson());
		await page.getByRole("button", { name: "Not now" }).click();
		await expect(page).toHaveURL("/app");

		await context.storageState({ path: SIGNED_IN });
	},
);
