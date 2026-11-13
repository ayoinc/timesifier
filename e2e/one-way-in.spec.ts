import type { Page } from "@playwright/test";

import { membersPath, organisationPath } from "../app/shell/destinations";
import {
	ARRIVAL,
	accountMenuName,
	CONTINUE,
	codeSentBy,
	foundInMessageSentBy,
	newPerson,
	openAuthPage,
	openProfileMenu,
	ownAddress,
	profileButton,
	signIn,
	signOut,
	TIME_WITH_TURNS,
} from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { expect, openShell, takenOver, test } from "./fixtures";
import {
	createOrganisation,
	INVITATION_LINK,
	invite,
	openAccount,
	openInvitations,
	openOutsideOrganisation,
} from "./organisation";

// Card TS-036, one way in: the home page's one action and its quiet "Sign in"
// lead to one page, which signs in a person who is new and a person coming back
// alike. Each journey is walked from the home page, in a browser, against the
// production build.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

const COMPACT = { width: 390, height: 844 };
const WIDE = { width: 1280, height: 800 };

/**
 * The sign-in page was loaded whole: it is the document the browser asked the
 * server for, not a page script drew over another document. Only its own
 * response carries the policy that lets Turnstile's script and frame in, so a
 * page reached any other way could not send a code; the shared fixture fails a
 * test on the violation, and the check below says why before it happens.
 */
async function expectLoadedWhole(page: Page) {
	await expect(page).toHaveURL(/\/sign-in(\?|$)/);
	const document = await page.evaluate(() => {
		const [navigation] = performance.getEntriesByType("navigation");
		return new URL(navigation?.name ?? "about:blank").pathname;
	});
	expect(document, "the document the browser loaded").toBe("/sign-in");
}

/** The two views of the page, from the address to the place the person was going. */
async function enterAddressAndCode(page: Page, email: string) {
	await expect(page.getByRole("heading", { level: 1, name: "Enter your email" })).toBeVisible();
	await takenOver(page, "header");
	await page.getByLabel("Email").fill(email);
	const code = await codeSentBy(() => page.getByRole("button", CONTINUE).click());
	await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
	await page.getByLabel("Code").fill(code);
	await page.getByRole("button", CONTINUE).click();
}

for (const viewport of [COMPACT, WIDE]) {
	test.describe(`in a window ${viewport.width}px wide`, () => {
		test.use({ viewport });

		test("a new address: the home page, its one action, an address, a code, an organisation, Timesheet", async ({
			page,
		}) => {
			const person = newPerson();
			await page.goto("/");
			await page.getByRole("main").getByRole("link", { name: "Start tracking" }).first().click();
			await expectLoadedWhole(page);
			await expect(page).toHaveURL("/sign-in");

			await enterAddressAndCode(page, person.email);

			// No name was asked, and nothing stands between the code and the application.
			await expect(page).toHaveURL(ARRIVAL);
			await expect(
				page.getByRole("heading", { level: 1, name: "Create your organisation" }),
			).toBeVisible();
			await expect(profileButton(page)).toHaveAccessibleName(accountMenuName(person.email));

			const { name } = await createOrganisation(page);
			await expect(page.getByRole("heading", { level: 1, name: "Timesheet" })).toBeVisible();
			await expect(page.getByText(`${name} is ready`)).toBeVisible();
		});

		test("a returning address with an organisation: the home page, Sign in, an address, a code, Timesheet", async ({
			page,
		}) => {
			const person = newPerson();
			await signIn(page, person.email);
			const { slug } = await createOrganisation(page);
			await signOut(page);

			await page.goto("/");
			// The quiet link in the band at the top, there at every width.
			await page.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
			await expectLoadedWhole(page);

			await enterAddressAndCode(page, person.email);

			await expect(page).toHaveURL(organisationPath(slug));
			await expect(page.getByRole("heading", { level: 1, name: "Timesheet" })).toBeVisible();
		});

		test("the sign-in page stands in the frame of the public pages: their band, their foot, and no way in on the way in", async ({
			page,
		}) => {
			await page.goto("/");
			const home = {
				band: await page.getByRole("banner").boundingBox(),
				colour: await page
					.getByRole("banner")
					.evaluate((band) => getComputedStyle(band).backgroundColor),
				name: await page
					.getByRole("banner")
					.getByRole("link", { name: "Timesifier" })
					.boundingBox(),
				heading: await page
					.getByRole("heading", { level: 1 })
					.evaluate((heading) => getComputedStyle(heading).fontFamily),
				column: await page.getByRole("contentinfo").boundingBox(),
			};

			await page.goto("/sign-in");
			const band = page.getByRole("banner");
			// The same band: its height, its colour, and the name where it was.
			expect(await band.boundingBox()).toEqual(home.band);
			expect(await band.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
				home.colour,
			);
			expect(await band.getByRole("link", { name: "Timesifier" }).boundingBox()).toEqual(home.name);
			// The band holds the name and nothing else: this page is the way in.
			await expect(band.getByRole("link")).toHaveText(["Timesifier"]);
			await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);
			await expect(page.getByRole("link", { name: "Start tracking" })).toHaveCount(0);

			// The heading in the public pages' face, and the action their size.
			expect(
				await page
					.getByRole("heading", { level: 1 })
					.evaluate((heading) => getComputedStyle(heading).fontFamily),
			).toBe(home.heading);
			expect((await page.getByRole("button", CONTINUE).boundingBox())?.height).toBe(48);

			// The foot: the lockup and the two notices, in the public pages' column.
			const foot = page.getByRole("contentinfo");
			await expect(foot.getByRole("link")).toHaveText(["Privacy notice", "Terms"]);
			const column = await foot.boundingBox();
			expect(column?.x).toBe(home.column?.x);
			expect(column?.width).toBe(home.column?.width);

			// The name leads home, and home is loaded whole.
			await band.getByRole("link", { name: "Timesifier" }).click();
			await expect(page).toHaveURL("/");
			expect(
				await page.evaluate(
					() => new URL(performance.getEntriesByType("navigation")[0]?.name ?? "").pathname,
				),
			).toBe("/");
		});
	});
}

test("an invited new address, signed out: the link, an address, a code, the invitation, Join, the organisation", async ({
	page,
	browser,
	baseURL,
}) => {
	test.setTimeout(2 * TIME_WITH_TURNS);
	const invited = newPerson();
	await signIn(page, newPerson().email);
	const { name, slug } = await createOrganisation(page);
	await openInvitations(page, slug);
	const link = await foundInMessageSentBy(
		() => invite(page, invited.email),
		INVITATION_LINK,
		"the invitation's link",
	);

	const theirs = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
	await ownAddress(theirs, baseURL);
	const other = await theirs.newPage();
	await other.goto(link);
	await expect(other).toHaveURL(`/sign-in?next=${encodeURIComponent(link)}`);
	await expectLoadedWhole(other);

	await enterAddressAndCode(other, invited.email);

	await expect(other).toHaveURL(link);
	await expect(other.getByRole("heading", { level: 1, name: `Join ${name}?` })).toBeVisible();
	await other.getByRole("button", { name: "Join" }).click();
	await expect(other).toHaveURL(organisationPath(slug));
	await expect(other.getByRole("heading", { level: 1, name: "Timesheet" })).toBeVisible();
	await theirs.close();
});

test.describe("a code that was asked for", () => {
	const KEPT = "timesifier.sign-in-code";

	/**
	 * What the pages keep in the browser besides cookies. React Router keeps how
	 * far each page was scrolled, under a key of its own, from the moment a page
	 * is left: that is no part of signing in and is left out here.
	 */
	const stored = (page: Page) =>
		page.evaluate(() => ({
			session: Object.keys(sessionStorage).filter((key) => key !== "react-router-scroll-positions"),
			local: Object.keys(localStorage),
		}));

	/** Makes the code this tab is waiting for one that was asked for `ago` milliseconds ago. */
	const askedAgo = (page: Page, ago: number) =>
		page.evaluate(
			([key, age]) => {
				const kept = JSON.parse(sessionStorage.getItem(key) ?? "{}");
				sessionStorage.setItem(key, JSON.stringify({ ...kept, askedAt: Date.now() - age }));
			},
			[KEPT, ago] as const,
		);

	test.describe("in a window 390px wide", () => {
		test.use({ viewport: COMPACT });

		test("survives a reload: the code view is there with the address, nothing is asked again, and the code signs in", async ({
			page,
		}) => {
			const person = newPerson();
			await openAuthPage(page);
			await page.getByLabel("Email").fill(person.email);
			const code = await codeSentBy(() => page.getByRole("button", CONTINUE).click());
			await expect(page.getByLabel("Code")).toBeFocused();

			const asked: string[] = [];
			page.on("request", (request) => {
				if (request.url().includes("/api/auth/")) asked.push(request.url());
			});
			await page.reload();

			await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
			await expect(page.getByRole("main")).toContainText(person.email);
			await expect(page.getByLabel("Email")).toHaveCount(0);
			expect(asked, "requests to the server for a code").toEqual([]);

			await takenOver(page, "header");
			await page.getByLabel("Code").fill(code);
			await page.getByRole("button", CONTINUE).click();
			await expect(page).toHaveURL(ARRIVAL);
			// Signed in: the browser keeps nothing of the code.
			expect(await stored(page)).toEqual({ session: [], local: [] });
		});
	});

	test("survives leaving for another page and coming back, where the person was going included", async ({
		page,
	}) => {
		const person = newPerson();
		await signIn(page, person.email);
		const { slug } = await createOrganisation(page);
		await signOut(page);

		const members = membersPath(slug);
		await page.goto(members);
		await takenOver(page, "header");
		await page.getByLabel("Email").fill(person.email);
		const code = await codeSentBy(() => page.getByRole("button", CONTINUE).click());
		await expect(page.getByLabel("Code")).toBeFocused();

		// To the notice in the foot, and back with the browser's own button.
		await page.getByRole("contentinfo").getByRole("link", { name: "Privacy notice" }).click();
		await expect(page).toHaveURL("/privacy");
		await page.goBack();

		await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
		await takenOver(page, "header");
		await page.getByLabel("Code").fill(code);
		await page.getByRole("button", CONTINUE).click();
		await expect(page).toHaveURL(members);
	});

	test("is all the page keeps in the browser, and only in the tab that asked", async ({
		page,
		context,
	}) => {
		const person = newPerson();
		await openAuthPage(page);
		expect(await stored(page)).toEqual({ session: [], local: [] });

		await page.getByLabel("Email").fill(person.email);
		await codeSentBy(() => page.getByRole("button", CONTINUE).click());
		await expect(page.getByLabel("Code")).toBeFocused();
		expect(await stored(page)).toEqual({ session: [KEPT], local: [] });
		const kept = await page.evaluate(
			(key) => JSON.parse(sessionStorage.getItem(key) ?? "{}"),
			KEPT,
		);
		// The address, the time and the newsletter's box (TS-099), and no code.
		expect(Object.keys(kept).sort()).toEqual(["askedAt", "email", "newsletter"]);
		expect(kept.newsletter).toBe(false);
		expect(kept.email).toBe(person.email);

		// Another tab of the same browser starts from the address.
		const another = await context.newPage();
		await openAuthPage(another);
		await expect(another.getByLabel("Email")).toBeVisible();
		await expect(another.getByLabel("Email")).toHaveValue("");
		await another.close();
	});

	test("is forgotten when the person asks to use a different email", async ({ page }) => {
		await openAuthPage(page);
		await page.getByLabel("Email").fill(newPerson().email);
		await codeSentBy(() => page.getByRole("button", CONTINUE).click());
		await expect(page.getByLabel("Code")).toBeFocused();

		await page.getByRole("button", { name: "Use a different email" }).click();
		await expect(page.getByLabel("Email")).toBeFocused();
		expect(await stored(page)).toEqual({ session: [], local: [] });

		await page.reload();
		await expect(page.getByRole("heading", { level: 1, name: "Enter your email" })).toBeVisible();
	});

	test("is forgotten after the five minutes it works for", async ({ page }) => {
		const FIVE_MINUTES = 5 * 60 * 1000;
		await openAuthPage(page);
		await page.getByLabel("Email").fill(newPerson().email);
		await codeSentBy(() => page.getByRole("button", CONTINUE).click());
		await expect(page.getByLabel("Code")).toBeFocused();

		// Two seconds short of it, a reload still finds the code view…
		await askedAgo(page, FIVE_MINUTES - 2000);
		await page.reload();
		await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();

		// …and when the time has passed, the open page lets go of the address.
		await expect.poll(() => stored(page)).toEqual({ session: [], local: [] });
		await page.reload();
		await expect(page.getByRole("heading", { level: 1, name: "Enter your email" })).toBeVisible();
		await expect(page.getByLabel("Email")).toHaveValue("");
	});

	test("is not taken up again by a page opened after its five minutes", async ({ page }) => {
		await openAuthPage(page);
		await page.getByLabel("Email").fill(newPerson().email);
		await codeSentBy(() => page.getByRole("button", CONTINUE).click());
		await expect(page.getByLabel("Code")).toBeFocused();

		await askedAgo(page, 5 * 60 * 1000 + 1);
		await page.reload();
		await expect(page.getByRole("heading", { level: 1, name: "Enter your email" })).toBeVisible();
		expect(await stored(page)).toEqual({ session: [], local: [] });
	});
});

test.describe("whose account this is", () => {
	test("the page a new account lands on says who is signed in, and the way back signs out and returns to sign in", async ({
		page,
	}) => {
		// A person with two addresses signs in with the one they did not mean to:
		// the account made is new and empty, and not the one they have.
		const meant = newPerson();
		const slip = meant.email.replace("@", "+other@");
		await signIn(page, slip);
		await expect(page).toHaveURL(ARRIVAL);
		await openOutsideOrganisation(page, ARRIVAL);

		// The profile menu is named after the account, and says its address above its items.
		await expect(profileButton(page)).toHaveAccessibleName(accountMenuName(slip));
		const menu = await openProfileMenu(page);
		await expect(page.getByText(slip, { exact: true })).toBeVisible();
		await menu.getByRole("menuitem", { name: "Use a different email" }).click();

		await expectLoadedWhole(page);
		await expect(page).toHaveURL("/sign-in");
		await expect(page.getByLabel("Email")).toHaveValue("");
		const session = await page.request.get("/api/auth/get-session");
		expect(await session.json()).toBeNull();

		// And the address that was meant goes in by the same page.
		await enterAddressAndCode(page, meant.email);
		await expect(page).toHaveURL(ARRIVAL);
		await expect(profileButton(page)).toHaveAccessibleName(accountMenuName(meant.email));
	});

	test("an invitation that is not this account's says who is signed in, and the way back keeps the invitation", async ({
		page,
		browser,
		baseURL,
	}) => {
		test.setTimeout(2 * TIME_WITH_TURNS);
		const invited = newPerson();
		await signIn(page, newPerson().email);
		const { name, slug } = await createOrganisation(page);
		await openInvitations(page, slug);
		const link = await foundInMessageSentBy(
			() => invite(page, invited.email),
			INVITATION_LINK,
			"the invitation's link",
		);

		// They open the link and sign in with another address of theirs.
		const theirs = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
		await ownAddress(theirs, baseURL);
		const other = await theirs.newPage();
		const slip = invited.email.replace("@", "+other@");
		await signIn(other, slip, `/sign-in?next=${encodeURIComponent(link)}`);

		await expect(other).toHaveURL(link);
		await expect(
			other.getByRole("heading", { level: 1, name: "This invitation is no longer valid" }),
		).toBeVisible();
		await expect(other.getByText(name)).toHaveCount(0);
		await expect(other.getByText(`Signed in as ${slip}`)).toBeVisible();
		await takenOver(other, "header");
		await other.getByRole("button", { name: "Use a different email" }).click();

		// Signed out, on the sign-in page, with the invitation kept for afterwards.
		await expectLoadedWhole(other);
		await expect(other).toHaveURL(`/sign-in?next=${encodeURIComponent(link)}`);
		await enterAddressAndCode(other, invited.email);
		await expect(other).toHaveURL(link);
		await expect(other.getByRole("heading", { level: 1, name: `Join ${name}?` })).toBeVisible();
		await theirs.close();
	});
});

test.describe("every way to the sign-in page is a whole page load", () => {
	for (const path of ["/", "/privacy", "/terms"]) {
		test(`Sign in, in the band of ${path}, and Continue then sends a code`, async ({ page }) => {
			await page.goto(path);
			await page.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
			await expectLoadedWhole(page);

			// What only a page with Turnstile's policy can do.
			await takenOver(page, "header");
			await page.getByLabel("Email").fill(newPerson().email);
			await codeSentBy(() => page.getByRole("button", CONTINUE).click());
			await expect(page.getByLabel("Code")).toBeFocused();
		});
	}

	test("the guard, the shell after its session has ended, Sign out everywhere on My account and Sign out in the profile menu, and the address a page for new people once had", async ({
		page,
		browser,
		baseURL,
	}) => {
		test.setTimeout(2 * TIME_WITH_TURNS);
		const person = newPerson();
		await signIn(page, person.email);
		const { slug } = await createOrganisation(page);
		const home = organisationPath(slug);

		// A second browser of theirs, left open in the shell.
		const elsewhere = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
		await ownAddress(elsewhere, baseURL);
		const other = await elsewhere.newPage();
		await signIn(other, person.email);
		await openShell(other, home);

		// "Sign out everywhere", from My account.
		await openAccount(page);
		await page.getByRole("button", { name: "Sign out everywhere" }).click();
		await expectLoadedWhole(page);

		// The shell elsewhere: its next move is script's, and the answer is a whole page.
		await other.getByRole("link", { name: "Reports" }).click();
		await expectLoadedWhole(other);
		await elsewhere.close();

		// The guard, for a document asked for without a session.
		await page.goto(home);
		await expectLoadedWhole(page);
		await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent(home)}`);

		// The address that used to make an account.
		await page.goto(`/sign-up?next=${home}&from=an-old-link`);
		await expectLoadedWhole(page);
		await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent(home)}`);

		// "Sign out", from the profile menu. And after each of them the page can still send a code.
		await enterAddressAndCode(page, person.email);
		await expect(page).toHaveURL(home);
		await openShell(page, home);
		await (await openProfileMenu(page)).getByRole("menuitem", { name: "Sign out" }).click();
		await expectLoadedWhole(page);
		await enterAddressAndCode(page, person.email);
		await expect(page).toHaveURL(home);
	});
});
