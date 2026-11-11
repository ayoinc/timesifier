import { randomInt, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Locator, Page } from "@playwright/test";

import { SIGN_IN_CODE_LENGTH } from "../app/auth/code";
import { initialsOf } from "../app/auth/person-name";
import { APP_PATH, NEW_ORGANISATION_PATH } from "../app/shell/destinations";
import { expect, openShell, takenOver } from "./fixtures";
import { openAccount } from "./organisation";

// What the browser tests of signing in and signing out share.

export interface Person {
	/** No page asks it on the way in: a test that needs it sets it on My account (`setName`). */
	name: string;
	email: string;
}

/** Somebody new, with an address no other test uses. */
export function newPerson(): Person {
	return { name: "Ada Lovelace", email: `ada-${randomUUID()}@example.com` };
}

/**
 * Gives every request this context makes to our server a client address of its
 * own, the way Cloudflare names a client in `CF-Connecting-IP`. The sign-in
 * rate limit counts by that address, so one test's attempts never count against
 * another's. The header goes to our origin only; Turnstile's never sees it.
 */
export async function ownAddress(context: BrowserContext, baseURL: string | undefined) {
	if (!baseURL) throw new Error("The tests need a baseURL.");
	// A random address in the block reserved for benchmarking (RFC 2544), which is nobody's.
	const address = `198.${18 + randomInt(2)}.${randomInt(256)}.${randomInt(1, 255)}`;
	await context.route(
		(url) => url.origin === baseURL,
		(route) =>
			route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": address } }),
	);
	return address;
}

// The server under test is `vite preview`, whose EMAIL binding is Wrangler's
// local simulator: it sends nothing and writes each message's text to a file
// under this directory. That is the only place a code can be read. The file
// does not say who the message was for, so only one test at a time may cause a
// message: the one holding the lock sees exactly one new file, and it is its own.
const EMAILS = ".wrangler/tmp/email";
const LOCK = join(EMAILS, "one-message-at-a-time.lock");
/** A lock older than this was left behind by a run that was stopped. */
const STALE_AFTER_MS = 30_000;
/**
 * The time a test of these journeys is given. It asks for a code once or twice,
 * and each time may stand behind the other tests that are asking for theirs.
 */
export const TIME_WITH_TURNS = 90_000;

async function messages(): Promise<string[]> {
	const simulators = await readdir(EMAILS, { withFileTypes: true }).catch(() => []);
	const found: string[] = [];
	for (const simulator of simulators.filter((entry) => entry.isDirectory())) {
		const folder = join(EMAILS, simulator.name, "email-text");
		for (const file of await readdir(folder).catch(() => [])) found.push(join(folder, file));
	}
	return found;
}

async function takeLock() {
	await mkdir(EMAILS, { recursive: true });
	await expect(async () => {
		const age = await stat(LOCK).then(
			(lock) => Date.now() - lock.mtimeMs,
			() => 0,
		);
		if (age > STALE_AFTER_MS) await rm(LOCK, { recursive: true, force: true });
		// Making a directory either succeeds or fails because it is there: no two tests get it.
		await mkdir(LOCK);
	}).toPass({ timeout: 60_000 });
}

/** A run of digits as long as a sign-in code, standing alone. */
const CODE = new RegExp(`\\b\\d{${SIGN_IN_CODE_LENGTH}}\\b`);

/** As many digits as a code has, and not this code. */
export function wrongCode(code: string): string {
	const zeros = "0".repeat(SIGN_IN_CODE_LENGTH);
	return code === zeros ? "1".repeat(SIGN_IN_CODE_LENGTH) : zeros;
}

/**
 * Does what makes the server send one message, and returns what `find` reads
 * in the text of the message it wrote: a sign-in code, an invitation's link.
 * Every test that causes a message goes through here, one at a time.
 */
export async function foundInMessageSentBy(
	send: () => Promise<unknown>,
	find: RegExp,
	what: string,
): Promise<string> {
	await takeLock();
	try {
		const before = new Set(await messages());
		await send();
		let found: string | undefined;
		await expect(async () => {
			const added = (await messages()).filter((file) => !before.has(file));
			expect(added, "messages written since the message was asked for").toHaveLength(1);
			found = (await readFile(added[0] ?? "", "utf8")).match(find)?.[0];
			expect(found, `${what} in the message`).toBeDefined();
		}).toPass({ timeout: 15_000 });
		return found ?? "";
	} finally {
		await rm(LOCK, { recursive: true, force: true });
	}
}

/**
 * Does what makes the server send a sign-in code, and returns the code from
 * the message it wrote.
 */
export function codeSentBy(send: () => Promise<unknown>): Promise<string> {
	return foundInMessageSentBy(send, CODE, "the code");
}

/** Opens the sign-in page and waits until its buttons work. */
export async function openAuthPage(page: Page, path: "/sign-in" | (string & {}) = "/sign-in") {
	await openShell(page, path, "header");
}

/** The label of the one primary action, on each of the sign-in page's two views. */
export const CONTINUE = { name: "Continue", exact: true } as const;

/**
 * Signs in through the one page: an email address, then the emailed code. An
 * address that is new has its account from that moment, with no name. The page
 * has left for where the person was going.
 */
export async function signIn(page: Page, email: string, path = "/sign-in") {
	await openAuthPage(page, path);
	await page.getByLabel("Email").fill(email);
	const code = await codeSentBy(() => page.getByRole("button", CONTINUE).click());

	await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
	await page.getByLabel("Code").fill(code);
	await page.getByRole("button", CONTINUE).click();
	await page.waitForURL((url) => url.pathname !== "/sign-in");
}

/**
 * Gives the signed-in person a name, where a person does: on My account, which
 * is in an organisation. For a person with exactly one; the page is left on My account.
 */
export async function setName(page: Page, name: string) {
	await openAccount(page);
	await page.getByRole("button", { name: /^(Add|Change) name$/ }).click();
	const sheet = page.getByRole("dialog", { name: "Your name" });
	await sheet.getByLabel("Name").fill(name);
	await sheet.getByRole("button", { name: "Save" }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("status")).toHaveText(`Your name is now ${name}.`);
}

/**
 * Where a person who belongs to no organisation arrives after signing in: `/app`
 * sends them to the page that creates their first.
 */
export const ARRIVAL = NEW_ORGANISATION_PATH;

/** The round button with the person's initials at the end of the band (TS-063). */
export function profileButton(page: Page): Locator {
	return page.getByRole("banner").getByRole("button", { name: /^Account menu for / });
}

/** The name of the profile menu and its button: whose it is, then the letters it shows (WCAG 2.5.3). */
export function accountMenuName(email: string, name: string | null = null): string {
	return `Account menu for ${name ?? email}, ${initialsOf(name, email)}`;
}

/** Opens the profile menu from the page that is open, and answers with the menu. */
export async function openProfileMenu(page: Page): Promise<Locator> {
	await profileButton(page).click();
	const menu = page.getByRole("menu");
	await expect(menu).toBeVisible();
	return menu;
}

/** Goes to My account the one way the shell has: Account settings, in the profile menu. */
export async function chooseAccountSettings(page: Page) {
	const menu = await openProfileMenu(page);
	await menu.getByRole("menuitem", { name: "Account settings" }).click();
	await expect(page.getByRole("heading", { level: 1, name: "My account" })).toBeFocused();
}

/**
 * Signs out and arrives at the sign-in page. "Sign out" is in the profile menu
 * of every page under `/app`; on the page that would create a first
 * organisation, which is where `/app` sends a person with none, it is called
 * "Use a different email". "Sign out everywhere" is on My account alone, so a
 * person with no organisation gets one first.
 */
export async function signOut(page: Page, button: "Sign out" | "Sign out everywhere" = "Sign out") {
	if (button === "Sign out everywhere") {
		await openAccount(page);
		await page.getByRole("button", { name: button, exact: true }).click();
	} else {
		await page.goto(APP_PATH);
		await takenOver(page, "header");
		const outside = new URL(page.url()).pathname === NEW_ORGANISATION_PATH;
		const menu = await openProfileMenu(page);
		await menu
			.getByRole("menuitem", { name: outside ? "Use a different email" : "Sign out" })
			.click();
	}
	await expect(page).toHaveURL("/sign-in");
}
