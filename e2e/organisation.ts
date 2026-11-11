import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Page } from "@playwright/test";

import {
	APP_PATH,
	accountPath,
	type DestinationId,
	destinationPath,
	invitationsPath,
	membersPath,
	NEW_ORGANISATION_PATH,
	organisationPath,
} from "../app/shell/destinations";
import { expect, openShell, type Refusals } from "./fixtures";

// What the browser tests share about organisations: the one the signed-in
// person of the Chromium project owns, and how any other person gets theirs.

export interface Organisation {
	name: string;
	slug: string;
}

/** The address of an organisation: `/app/<slug>`, and not the page that creates one. */
const ORGANISATION_ADDRESS = /^\/app\/(?!new$)[a-z0-9-]+$/;

/**
 * What the setup project leaves for the other tests: the organisation of the
 * person the Chromium tests start as, and the people in and around it. No test
 * changes any of it; a test that renames, invites, removes or deletes makes an
 * organisation of its own.
 */
export interface HomeOrganisation extends Organisation {
	/** Who created it. The Chromium tests start signed in as them (`SIGNED_IN`). */
	owner: { name: string; email: string };
	/** A person who accepted an invitation to it (`SIGNED_IN_AS_MEMBER`). */
	member: { name: string; email: string };
	/** An organisation the member owns, so that `/app` shows them a choice. */
	membersOwn: Organisation;
	/**
	 * A person with an invitation to it that they have not answered
	 * (`SIGNED_IN_AS_GUEST`). They are in no organisation, so they have no
	 * My account and have given no name.
	 */
	guest: { email: string };
	/** The address of the page of the guest's invitation. */
	guestInvitation: string;
}

/** Where the setup project keeps it. */
const HOME = "test-results/.auth/organisation.json";

/** Called by the setup project, once. */
export function saveHomeOrganisation(organisation: HomeOrganisation) {
	mkdirSync(dirname(HOME), { recursive: true });
	writeFileSync(HOME, JSON.stringify(organisation));
}

let home: HomeOrganisation | undefined;

/**
 * Read when a test first asks, never when a file is loaded: Playwright loads
 * every test file before the setup project has run.
 */
export function homeOrganisation(): HomeOrganisation {
	home ??= JSON.parse(readFileSync(HOME, "utf8")) as HomeOrganisation;
	return home;
}

/** The address of a destination in that organisation. */
export function homePath(id: DestinationId): string {
	return destinationPath(homeOrganisation().slug, id);
}

/** A name no other test, and no earlier run against the same database, has used. */
export function newOrganisationName(): string {
	return `Acme ${randomUUID().slice(0, 8)}`;
}

/** Opens a page under `/app` that is in no organisation, and waits until React has taken it over. */
export async function openOutsideOrganisation(page: Page, path: string) {
	await openShell(page, path, "header");
}

/**
 * Creates an organisation through the page, as the signed-in person, and
 * arrives at its Timesheet.
 */
export async function createOrganisation(
	page: Page,
	name = newOrganisationName(),
): Promise<Organisation> {
	await openOutsideOrganisation(page, NEW_ORGANISATION_PATH);
	await page.getByLabel("Organisation name").fill(name);
	await page.getByRole("button", { name: "Create organisation" }).click();

	// The server makes the address from the name, and the page arrives there
	// once the welcome's mark has come off the address.
	await page.waitForURL(
		({ pathname, search }) => ORGANISATION_ADDRESS.test(pathname) && search === "",
	);
	const slug = new URL(page.url()).pathname.slice(APP_PATH.length + 1);
	expect(page.url()).toContain(organisationPath(slug));
	return { name, slug };
}

/**
 * The slug of the organisation `/app` sends this person to. A person who has
 * none yet creates one first. For a person with at most one organisation.
 */
export async function ownOrganisation(page: Page): Promise<string> {
	await page.goto(APP_PATH);
	const { pathname } = new URL(page.url());
	if (pathname === NEW_ORGANISATION_PATH) return (await createOrganisation(page)).slug;
	return pathname.slice(APP_PATH.length + 1);
}

/** Opens My account in the person's organisation, which is created first if they have none. */
export async function openAccount(page: Page): Promise<string> {
	const slug = await ownOrganisation(page);
	await openShell(page, accountPath(slug));
	return slug;
}

/** Opens the members page of the organisation with this slug. */
export async function openMembers(page: Page, slug: string) {
	await openShell(page, membersPath(slug));
	await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
}

/** Opens the invitations page of the organisation with this slug. */
export async function openInvitations(page: Page, slug: string) {
	await openShell(page, invitationsPath(slug));
	await expect(page.getByRole("heading", { level: 1, name: "Invitations" })).toBeVisible();
}

/** The address of an invitation's page, as its email gives it. */
export const INVITATION_LINK = /\/invitations\/[0-9a-f-]{36}\b/;

/**
 * Fills in the sheet that "Invite a person" opens and sends it. The
 * invitations page is open, and the person on it may invite. Returns when the page has
 * said the invitation is on its way.
 */
export async function invite(page: Page, email: string, role: "Member" | "Admin" = "Member") {
	await page.getByRole("button", { name: "Invite a person" }).click();
	const sheet = page.getByRole("dialog", { name: "Invite a person" });
	await sheet.getByLabel("Email address").fill(email);
	// The radio itself is hidden; its label is what a pointer presses.
	await sheet.getByText(role, { exact: true }).click();
	await sheet.getByRole("button", { name: "Send invitation" }).click();
	await expect(page.getByRole("status").filter({ hasText: email })).toBeVisible();
	await expect(sheet).toBeHidden();
}

/**
 * Names a refusal the test is about to cause on an address it could not know
 * when it was written: one that holds an organisation's slug or an
 * invitation's id. `refusals` is the test's own fixture (./fixtures.ts), which
 * reads this entry when the console reports the refused request.
 */
export function expectRefusal(refusals: Refusals, path: string, ...statuses: number[]) {
	refusals[path] = [...(refusals[path] ?? []), ...statuses];
}
