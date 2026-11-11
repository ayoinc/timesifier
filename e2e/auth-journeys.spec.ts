import type { Page } from "@playwright/test";

import {
	addAuthenticator,
	newPerson,
	openAuthPage,
	ownAddress,
	signInWithCode,
	signOut,
	signUp,
	TIME_WITH_TURNS,
} from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { expect, openShell, test } from "./fixtures";

// The journeys of card TS-008, each walked in a browser against the production
// build: sign up with an email code, make a passkey, sign out, sign in with the
// passkey, sign in with a code, end every session, remove a passkey. Passkeys
// are made and used by a virtual authenticator in Chromium; the codes are read
// from the messages the local EMAIL binding writes (./auth.ts).

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

/** Who the server says this browser is signed in as: their address and name, or `null`. */
async function whoIs(page: Page): Promise<{ email: string; name: string } | null> {
	const response = await page.request.get("/api/auth/get-session");
	const session: { user: { email: string; name: string } } | null = await response.json();
	return session && { email: session.user.email, name: session.user.name };
}

test.describe("signing up", () => {
	test("with an email code makes the account, and a passkey is made straight after", async ({
		page,
	}) => {
		const person = newPerson();
		const authenticator = await addAuthenticator(page);

		await signUp(page, person);
		expect(await whoIs(page), "the account, signed in, with the name that was typed").toEqual(
			person,
		);
		expect(await authenticator.passkeys()).toBe(0);

		// One primary action, and a way past it.
		await expect(page.getByRole("button", { name: "Not now" })).toBeVisible();
		await page.getByRole("button", { name: "Create a passkey" }).click();
		await expect(
			page.getByRole("heading", { level: 1, name: "Your passkey is ready" }),
		).toBeVisible();
		expect(await authenticator.passkeys(), "passkeys on the authenticator").toBe(1);

		await page.getByRole("button", { name: "Open Timesifier" }).click();
		await expect(page).toHaveURL("/app");
		await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();

		await openShell(page, "/app/settings");
		await expect(page.getByRole("listitem").filter({ hasText: "Added" })).toHaveCount(1);
		await expect(page.getByText(person.email)).toBeVisible();
	});

	test("without a passkey goes on to the application, and Settings lists none", async ({
		page,
	}) => {
		await signUp(page, newPerson());
		await page.getByRole("button", { name: "Not now" }).click();
		await expect(page).toHaveURL("/app");

		await openShell(page, "/app/settings");
		await expect(page.getByText("You have no passkeys yet.")).toBeVisible();
	});

	test("says the same for an address that already has an account", async ({ page }) => {
		const person = newPerson();
		await signUp(page, person);
		await page.getByRole("button", { name: "Not now" }).click();
		await signOut(page);

		// The second time round every step reads as the first did.
		await signUp(page, person);
	});
});

test.describe("signing out and signing in", () => {
	test("sign out ends the session; the passkey alone signs back in", async ({ page }) => {
		const person = newPerson();
		await addAuthenticator(page);
		await signUp(page, person);
		await page.getByRole("button", { name: "Create a passkey" }).click();
		await page.getByRole("button", { name: "Open Timesifier" }).click();
		await expect(page).toHaveURL("/app");

		await signOut(page);
		expect(await whoIs(page)).toBeNull();

		// No address typed and no code sent: the passkey says who this is.
		await openAuthPage(page, "/sign-in");
		await expect(page.getByLabel("Email")).toHaveCount(0);
		await page.getByRole("button", { name: "Sign in with a passkey" }).click();
		await expect(page).toHaveURL("/app");
		expect((await whoIs(page))?.email).toBe(person.email);
	});

	test("an email code signs in, and goes on to the page that was asked for", async ({ page }) => {
		const person = newPerson();
		await signUp(page, person);
		await page.getByRole("button", { name: "Not now" }).click();
		await signOut(page);

		// Without a session, a page under /app sends the person to sign in and remembers itself.
		await page.goto("/app/reports?week=46");
		await expect(page).toHaveURL("/sign-in?next=%2Fapp%2Freports%3Fweek%3D46");

		await signInWithCode(page, person.email, page.url());
		await expect(page).toHaveURL("/app/reports?week=46");
		await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
		expect((await whoIs(page))?.email).toBe(person.email);
	});

	test("the email field offers the passkey through the browser's autofill", async ({ page }) => {
		const person = newPerson();
		await addAuthenticator(page);
		await signUp(page, person);
		await page.getByRole("button", { name: "Create a passkey" }).click();
		await page.getByRole("button", { name: "Open Timesifier" }).click();
		await signOut(page);

		// The authenticator answers the request the field makes, as a person
		// choosing the passkey in the field's autofill would.
		await openAuthPage(page, "/sign-in");
		await page.getByRole("button", { name: "Use an email code instead" }).click();
		await expect(page).toHaveURL("/app");
		expect((await whoIs(page))?.email).toBe(person.email);
	});

	test("the email-code path is not on the page until it is asked for, and leads back", async ({
		page,
	}) => {
		// An authenticator with no passkey: the field's autofill has nothing to offer.
		await addAuthenticator(page);
		await openAuthPage(page, "/sign-in");
		await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
		await expect(page.getByLabel("Email")).toHaveCount(0);
		await expect(page.getByLabel("Code")).toHaveCount(0);

		await page.getByRole("button", { name: "Use an email code instead" }).click();
		await expect(page.getByLabel("Email")).toBeFocused();
		await expect(page.getByLabel("Email")).toHaveAttribute("autocomplete", "username webauthn");
		await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toHaveCount(0);

		await page.getByRole("button", { name: "Use a passkey instead" }).click();
		await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
		await expect(page.getByLabel("Email")).toHaveCount(0);
	});

	test("a person who is signed in is sent on from both pages", async ({ page }) => {
		await signUp(page, newPerson());
		await page.getByRole("button", { name: "Not now" }).click();
		await expect(page).toHaveURL("/app");

		await page.goto("/sign-in");
		await expect(page).toHaveURL("/app");
		await page.goto("/sign-up?next=/app/projects");
		await expect(page).toHaveURL("/app/projects");
		// Only a page of our own under /app is ever gone to.
		await page.goto("/sign-in?next=https://example.com/app");
		await expect(page).toHaveURL("/app");
		await page.goto("/sign-in?next=//example.com/app");
		await expect(page).toHaveURL("/app");
	});
});

test.describe("sign out everywhere", () => {
	test("ends the session in a second browser too", async ({ page, browser, baseURL }) => {
		const person = newPerson();
		await signUp(page, person);
		await page.getByRole("button", { name: "Not now" }).click();
		await expect(page).toHaveURL("/app");

		// The same person in another browser, signed in with a code of their own.
		const elsewhere = await browser.newContext({ storageState: SIGNED_OUT, baseURL });
		await ownAddress(elsewhere, baseURL);
		const other = await elsewhere.newPage();
		await signInWithCode(other, person.email);
		await expect(other).toHaveURL("/app");
		await openShell(other, "/app");

		await signOut(page, "Sign out everywhere");
		expect(await whoIs(page)).toBeNull();

		// The other browser still shows the shell. Its next move asks the server,
		// which no longer knows the session.
		await other.getByRole("link", { name: "Reports" }).click();
		await expect(other).toHaveURL("/sign-in?next=%2Fapp%2Freports");
		await other.goto("/app/settings");
		await expect(other).toHaveURL("/sign-in?next=%2Fapp%2Fsettings");
		await elsewhere.close();
	});
});

test.describe("passkeys in Settings", () => {
	test("one is added, then removed, and no longer signs in", async ({ page }) => {
		const person = newPerson();
		const authenticator = await addAuthenticator(page);
		await signUp(page, person);
		await page.getByRole("button", { name: "Not now" }).click();
		await expect(page).toHaveURL("/app");

		await openShell(page, "/app/settings");
		const passkeys = page.getByRole("listitem").filter({ hasText: "Added" });
		await expect(passkeys).toHaveCount(0);

		await page.getByRole("button", { name: "Add a passkey" }).click();
		await expect(passkeys).toHaveCount(1);
		await expect(page.getByRole("status").filter({ hasText: "Passkey added" })).toBeVisible();
		expect(await authenticator.passkeys()).toBe(1);

		// Removing asks first, and Cancel leaves the passkey alone.
		await page.getByRole("button", { name: /^Remove the passkey added/ }).click();
		const dialog = page.getByRole("alertdialog", { name: "Remove this passkey?" });
		await expect(dialog).toContainText("You can still sign in with an email code.");
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(dialog).toHaveCount(0);
		await expect(passkeys).toHaveCount(1);

		await page.getByRole("button", { name: /^Remove the passkey added/ }).click();
		await dialog.getByRole("button", { name: "Remove" }).click();
		await expect(passkeys).toHaveCount(0);
		await expect(page.getByText("You have no passkeys yet.")).toBeVisible();
		await expect(page.getByRole("status").filter({ hasText: "Passkey removed" })).toBeVisible();

		expect(await authenticator.passkeys(), "the device still holds its copy").toBe(1);
	});
});

test.describe("a removed passkey", () => {
	// The device still offers it; the server no longer knows it.
	test.use({ refusals: { "/api/auth/passkey/verify-authentication": [401] } });

	test("is refused", async ({ page }) => {
		const person = newPerson();
		await addAuthenticator(page);
		await signUp(page, person);
		await page.getByRole("button", { name: "Create a passkey" }).click();
		await page.getByRole("button", { name: "Open Timesifier" }).click();

		await openShell(page, "/app/settings");
		await page.getByRole("button", { name: /^Remove the passkey added/ }).click();
		await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
		await expect(page.getByText("You have no passkeys yet.")).toBeVisible();
		await signOut(page);

		await openAuthPage(page, "/sign-in");
		await page.getByRole("button", { name: "Sign in with a passkey" }).click();
		await expect(page.getByRole("alert")).toHaveText(
			"We could not sign you in with that passkey. Try again, or use an email code instead.",
		);
		await expect(page).toHaveURL("/sign-in");
		expect(await whoIs(page)).toBeNull();
	});
});

test.describe("what the pages ask of the server", () => {
	test("every journey together calls these endpoints under /api/auth and no other", async ({
		page,
	}) => {
		const called = new Set<string>();
		page.on("request", (request) => {
			const { pathname } = new URL(request.url());
			if (pathname.startsWith("/api/auth/")) called.add(`${request.method()} ${pathname}`);
		});

		// Sign up, make a passkey, end every session, sign in with the passkey,
		// remove it, sign out, sign in with a code.
		const person = newPerson();
		const authenticator = await addAuthenticator(page);
		await signUp(page, person);
		await page.getByRole("button", { name: "Create a passkey" }).click();
		await page.getByRole("button", { name: "Open Timesifier" }).click();
		await expect(page).toHaveURL("/app");
		await signOut(page, "Sign out everywhere");

		await openAuthPage(page, "/sign-in");
		await page.getByRole("button", { name: "Sign in with a passkey" }).click();
		await expect(page).toHaveURL("/app");
		await openShell(page, "/app/settings");
		await page.getByRole("button", { name: /^Remove the passkey added/ }).click();
		await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
		await expect(page.getByText("You have no passkeys yet.")).toBeVisible();
		await signOut(page);

		// The device still holds the passkey the server has forgotten; nobody chooses it.
		await authenticator.setPresent(false);
		await signInWithCode(page, person.email);
		await expect(page).toHaveURL("/app");

		// Settings reads the list of passkeys on the server, from its loader:
		// GET /api/auth/passkey/list-user-passkeys never leaves the Worker.
		expect([...called].sort()).toEqual([
			"GET /api/auth/passkey/generate-authenticate-options",
			"GET /api/auth/passkey/generate-register-options",
			"POST /api/auth/email-otp/send-verification-otp",
			"POST /api/auth/passkey/delete-passkey",
			"POST /api/auth/passkey/verify-authentication",
			"POST /api/auth/passkey/verify-registration",
			"POST /api/auth/revoke-sessions",
			"POST /api/auth/sign-in/email-otp",
			"POST /api/auth/sign-out",
		]);
	});
});
