import { randomInt, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";

import { SIGN_IN_CODE_LENGTH } from "../app/auth/code";
import { APP_PATH, NEW_ORGANISATION_PATH } from "../app/shell/destinations";
import { expect, openShell } from "./fixtures";
import { openOutsideOrganisation, openSettings } from "./organisation";

// What the browser tests of sign-up, sign-in and sign-out share.

export interface Person {
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

/** Opens the sign-in or the sign-up page and waits until its buttons work. */
export async function openAuthPage(page: Page, path: "/sign-in" | "/sign-up" | (string & {})) {
	await openShell(page, path, "main");
}

/**
 * Signs up through the page: name, email, the emailed code. The account exists,
 * the person is signed in, and the page has left for where they were going.
 */
export async function signUp(page: Page, person: Person, path = "/sign-up") {
	await openAuthPage(page, path);
	await page.getByLabel("Name").fill(person.name);
	await page.getByLabel("Email").fill(person.email);
	const code = await codeSentBy(() => page.getByRole("button", { name: "Continue" }).click());

	await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
	await page.getByLabel("Code").fill(code);
	await page.getByRole("button", { name: "Create account" }).click();
	await page.waitForURL((url) => url.pathname !== "/sign-up");
}

/** Signs in through the page with an emailed code, and arrives where the page sends the person. */
export async function signInWithCode(page: Page, email: string, path = "/sign-in") {
	await openAuthPage(page, path);
	await page.getByLabel("Email").fill(email);
	const code = await codeSentBy(() => page.getByRole("button", { name: "Continue" }).click());

	await page.getByLabel("Code").fill(code);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/**
 * Where a person who belongs to no organisation arrives after signing in: `/app`
 * sends them to the page that creates their first.
 */
export const ARRIVAL = NEW_ORGANISATION_PATH;

/**
 * Signs out and arrives at the sign-in page. A person with an organisation
 * signs out from its Settings; a person with none, from the page that would
 * create one, which is where `/app` sends them. "Sign out everywhere" is in
 * Settings alone, so a person with no organisation gets one first.
 */
export async function signOut(page: Page, button: "Sign out" | "Sign out everywhere" = "Sign out") {
	await page.goto(APP_PATH);
	if (button === "Sign out" && new URL(page.url()).pathname === NEW_ORGANISATION_PATH) {
		await openOutsideOrganisation(page, NEW_ORGANISATION_PATH);
	} else {
		await openSettings(page);
	}
	await page.getByRole("button", { name: button, exact: true }).click();
	await expect(page).toHaveURL("/sign-in");
}
