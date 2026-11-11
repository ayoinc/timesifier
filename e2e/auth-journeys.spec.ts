import { randomInt } from "node:crypto";
import type { Page } from "@playwright/test";

import { destinationPath, organisationPath } from "../app/shell/destinations";

import {
	ARRIVAL,
	CONTINUE,
	codeSentBy,
	newPerson,
	openAuthPage,
	ownAddress,
	setName,
	signIn,
	signOut,
	TIME_WITH_TURNS,
} from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation, openAccount } from "./organisation";

// The journeys of card TS-008 as card TS-036 left them, each walked in a
// browser against the production build: one page signs in a person who is new
// and a person coming back, with an emailed code; sign out; end every session.
// The codes are read from the messages the local EMAIL binding writes (./auth.ts).
//
// A person who has just signed in for the first time belongs to no
// organisation, so `/app` sends them to the page that creates one (`ARRIVAL`).
// My account is in an organisation: a journey that needs it creates one first
// (./organisation.ts).

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

/** The sign-in page as the guard sends a person to it from `path`. */
function signInPath(path: string): string {
	return `/sign-in?next=${encodeURIComponent(path)}`;
}

/** Who the server says this browser is signed in as: their address and name, or `null`. */
async function whoIs(page: Page): Promise<{ email: string; name: string } | null> {
	const response = await page.request.get("/api/auth/get-session");
	const session: { user: { email: string; name: string } } | null = await response.json();
	return session && { email: session.user.email, name: session.user.name };
}

test.describe("an address that is new", () => {
	test("is signed in by its first code, with no name asked, and goes straight on to the application", async ({
		page,
	}) => {
		const person = newPerson();

		await signIn(page, person.email);

		// The accepted code is the last step: nothing stands between it and the application.
		await expect(page).toHaveURL(ARRIVAL);
		await expect(
			page.getByRole("heading", { level: 1, name: "Create your organisation" }),
		).toBeVisible();
		expect(await whoIs(page), "the account, signed in, with no name yet").toEqual({
			email: person.email,
			name: "",
		});

		// Until they give a name, people see their address; My account is where they give it.
		await openAccount(page);
		await expect(
			page.getByText(`Not set. People see your address, ${person.email}.`),
		).toBeVisible();
		await setName(page, person.name);
		expect(await whoIs(page)).toEqual(person);
	});

	test("and an address that has an account are told the same, view for view", async ({ page }) => {
		const person = newPerson();

		/** What the page says on each of its two views, on the way in. */
		async function said(): Promise<string[]> {
			const views: string[] = [];
			await openAuthPage(page);
			views.push((await page.getByRole("main").textContent()) ?? "");
			await page.getByLabel("Email").fill(person.email);
			const code = await codeSentBy(() => page.getByRole("button", CONTINUE).click());
			await expect(page.getByLabel("Code")).toBeFocused();
			views.push((await page.getByRole("main").textContent()) ?? "");
			await page.getByLabel("Code").fill(code);
			await page.getByRole("button", CONTINUE).click();
			await expect(page).toHaveURL(ARRIVAL);
			return views;
		}

		const asNew = await said();
		await signOut(page);
		const asReturning = await said();

		expect(asReturning).toEqual(asNew);
		expect(asNew[1]).toContain(person.email);
	});
});

test.describe("signing out and signing in", () => {
	test("sign out ends the session; an email code signs back in", async ({ page }) => {
		const person = newPerson();
		await signIn(page, person.email);
		await expect(page).toHaveURL(ARRIVAL);

		await signOut(page);
		expect(await whoIs(page)).toBeNull();

		await signIn(page, person.email);
		await expect(page).toHaveURL(ARRIVAL);
		expect((await whoIs(page))?.email).toBe(person.email);
	});

	test("an email code signs in, and goes on to the page that was asked for", async ({ page }) => {
		const person = newPerson();
		await signIn(page, person.email);
		const { slug } = await createOrganisation(page);
		await signOut(page);

		// Without a session, a page under /app sends the person to sign in and remembers itself.
		const reports = `${destinationPath(slug, "reports")}?week=46`;
		await page.goto(reports);
		await expect(page).toHaveURL(signInPath(reports));

		await signIn(page, person.email, page.url());
		await expect(page).toHaveURL(reports);
		await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
		expect((await whoIs(page))?.email).toBe(person.email);
	});

	test("the page opens on the email address; the code is asked for once one is sent, and the way back keeps the address", async ({
		page,
	}) => {
		const person = newPerson();
		await openAuthPage(page);
		await expect(page.getByRole("heading", { level: 1, name: "Enter your email" })).toBeVisible();
		await expect(
			page.getByText("We will email you a code. If you are new here, the same code sets you up."),
		).toBeVisible();
		await expect(page).toHaveTitle("Sign in · Timesifier");
		// One field, and no name among them.
		await expect(page.getByRole("textbox")).toHaveCount(1);
		await expect(page.getByLabel("Email")).toBeVisible();
		await expect(page.getByLabel("Code")).toHaveCount(0);
		// One action on the view, and it is the primary one.
		await expect(page.getByRole("main").getByRole("button")).toHaveText(["Continue"]);

		await page.getByLabel("Email").fill(person.email);
		await codeSentBy(() => page.getByRole("button", CONTINUE).click());
		await expect(page.getByLabel("Code")).toBeFocused();
		await expect(page.getByLabel("Email")).toHaveCount(0);
		await expect(page.getByRole("textbox")).toHaveCount(1);
		await expect(
			page.getByText("We send at most five codes an hour to one address."),
		).toBeVisible();
		await expect(page.getByRole("main").getByRole("button")).toHaveText([
			"Continue",
			"Send a new code",
			"Use a different email",
		]);

		await page.getByRole("button", { name: "Use a different email" }).click();
		await expect(page.getByLabel("Email")).toBeFocused();
		await expect(page.getByLabel("Email")).toHaveValue(person.email);
		await expect(page.getByLabel("Code")).toHaveCount(0);
	});

	test("a person who is signed in is sent on from the page, and from where a page for new people once was", async ({
		page,
	}) => {
		await signIn(page, newPerson().email);
		await expect(page).toHaveURL(ARRIVAL);

		// With no organisation, /app sends them to create one.
		await page.goto("/sign-in");
		await expect(page).toHaveURL(ARRIVAL);

		// With one, /app sends them to it.
		const { slug } = await createOrganisation(page);
		const home = organisationPath(slug);
		await page.goto("/sign-in");
		await expect(page).toHaveURL(home);
		const projects = destinationPath(slug, "projects");
		await page.goto(`/sign-up?next=${projects}`);
		await expect(page).toHaveURL(projects);
		// Only a page of our own under /app is ever gone to.
		await page.goto("/sign-in?next=https://example.com/app");
		await expect(page).toHaveURL(home);
		await page.goto("/sign-in?next=//example.com/app");
		await expect(page).toHaveURL(home);
	});

	test("a browser that has signed in before is still sent a code when strangers have used up the address's five in an hour", async ({
		page,
		playwright,
		baseURL,
	}) => {
		const person = newPerson();
		await signIn(page, person.email);
		await signOut(page);

		// Somebody who knows the address and nothing else, asking from a new
		// client address each time. The first sign-in above was the first of the
		// five that everybody else is allowed; these are the rest.
		const stranger = await playwright.request.newContext({ baseURL });
		for (let n = 0; n < 4; n++) {
			await codeSentBy(async () => {
				const asked = await stranger.post("/api/auth/email-otp/send-verification-otp", {
					data: { email: person.email, type: "sign-in" },
					headers: {
						// What a page of ours would send; the server refuses a request without it.
						origin: baseURL ?? "",
						"cf-connecting-ip": `198.18.${randomInt(256)}.${randomInt(1, 255)}`,
						// The token Turnstile's test keys accept.
						"x-captcha-response": "XXXX.DUMMY.TOKEN.XXXX",
					},
				});
				expect(asked.status(), await asked.text()).toBe(200);
			});
		}
		await stranger.dispose();

		// A sixth request from anybody else would be sent nothing. This browser's is
		// sent a code, and the code signs the person in.
		await signIn(page, person.email);
		await expect(page).toHaveURL(ARRIVAL);
	});
});

test.describe("sign out everywhere", () => {
	test("ends the session in a second browser too", async ({ page, browser, baseURL }) => {
		const person = newPerson();
		await signIn(page, person.email);
		await expect(page).toHaveURL(ARRIVAL);
		const { slug } = await createOrganisation(page);
		const home = organisationPath(slug);

		// The same person in another browser, signed in with a code of their own.
		const elsewhere = await browser.newContext({ storageState: SIGNED_OUT, baseURL });
		await ownAddress(elsewhere, baseURL);
		const other = await elsewhere.newPage();
		await signIn(other, person.email);
		await expect(other).toHaveURL(home);
		await openShell(other, home);

		await signOut(page, "Sign out everywhere");
		expect(await whoIs(page)).toBeNull();

		// The other browser still shows the shell. Its next move asks the server,
		// which no longer knows the session.
		await other.getByRole("link", { name: "Reports" }).click();
		await expect(other).toHaveURL(signInPath(destinationPath(slug, "reports")));
		await other.goto(destinationPath(slug, "settings"));
		await expect(other).toHaveURL(signInPath(destinationPath(slug, "settings")));
		await elsewhere.close();
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

		// Sign in for the first time, end every session, sign in again, sign out.
		const person = newPerson();
		await signIn(page, person.email);
		await expect(page).toHaveURL(ARRIVAL);
		// "Sign out everywhere" is on My account, and My account is in an organisation.
		const { slug } = await createOrganisation(page);
		await signOut(page, "Sign out everywhere");

		await signIn(page, person.email);
		await expect(page).toHaveURL(organisationPath(slug));
		await signOut(page);

		// The pages of an organisation ask the server from their loaders and
		// actions: creating the organisation above called nothing from the browser.
		expect([...called].sort()).toEqual([
			"POST /api/auth/email-otp/send-verification-otp",
			"POST /api/auth/revoke-sessions",
			"POST /api/auth/sign-in/email-otp",
			"POST /api/auth/sign-out",
		]);
	});
});
