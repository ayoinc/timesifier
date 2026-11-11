import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Page } from "@playwright/test";

import {
	APP_PATH,
	type DestinationId,
	destinationPath,
	NEW_ORGANISATION_PATH,
	organisationPath,
} from "../app/shell/destinations";
import { expect, openShell } from "./fixtures";

// What the browser tests share about organisations: the one the signed-in
// person of the Chromium project owns, and how any other person gets theirs.

export interface Organisation {
	name: string;
	slug: string;
}

/** The address of an organisation: `/app/<slug>`, and not the page that creates one. */
const ORGANISATION_ADDRESS = /^\/app\/(?!new$)[a-z0-9-]+$/;

/** Where the setup project keeps the organisation of the person every Chromium test starts as. */
const HOME = "test-results/.auth/organisation.json";

/** Called by the setup project, once, when that person has created their organisation. */
export function saveHomeOrganisation(organisation: Organisation) {
	mkdirSync(dirname(HOME), { recursive: true });
	writeFileSync(HOME, JSON.stringify(organisation));
}

let home: Organisation | undefined;

/**
 * The organisation of the person the Chromium tests start as. Read when a test
 * first asks, never when a file is loaded: Playwright loads every test file
 * before the setup project has run.
 */
export function homeOrganisation(): Organisation {
	home ??= JSON.parse(readFileSync(HOME, "utf8")) as Organisation;
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
 * arrives at its Today.
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

/** Opens Settings in the person's organisation, which is created first if they have none. */
export async function openSettings(page: Page): Promise<string> {
	const slug = await ownOrganisation(page);
	await openShell(page, destinationPath(slug, "settings"));
	return slug;
}
