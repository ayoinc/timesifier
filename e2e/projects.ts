import type { Browser, Page } from "@playwright/test";

import { destinationPath } from "../app/shell/destinations";
import { ownAddress } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { expect, openShell } from "./fixtures";

/** Somebody with a browser of their own, signed out, at a client address of their own. */
export async function newBrowser(browser: Browser, baseURL: string | undefined): Promise<Page> {
	const context = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
	await ownAddress(context, baseURL);
	return context.newPage();
}

/** Creates a client with a code on Clients. */
export async function createClient(page: Page, slug: string, name: string, code: string) {
	await openShell(page, destinationPath(slug, "clients"));
	await page.getByRole("button", { name: "Create client" }).click();
	const sheet = page.getByRole("dialog", { name: "Create a client" });
	await sheet.getByLabel("Client name").fill(name);
	await sheet.getByLabel("Code", { exact: true }).fill(code);
	await sheet.getByRole("button", { name: "Create the client" }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("status")).toHaveText(`Client created: ${name}.`);
}

/**
 * Creates a project with a code on Projects, for `client` as the Client field
 * names it, or with the field as it opens: no client, which under Both is a
 * work code. Under Internal work the page says the organisation's own term.
 */
export async function createCodedProject(
	page: Page,
	slug: string,
	name: string,
	code: string,
	client?: string,
) {
	await openShell(page, destinationPath(slug, "projects"));
	await page.getByRole("button", { name: /^Create (?:project|work code)$/ }).click();
	const sheet = page.getByRole("dialog", { name: /^Create an? (?:project|work code)$/ });
	await sheet.getByLabel(/^(?:Project|Work code) name/).fill(name);
	await sheet.getByLabel("Code", { exact: true }).fill(code);
	if (client) {
		await sheet.getByRole("button", { name: /Client/ }).click();
		await page
			.getByRole("listbox", { name: "Client" })
			.getByRole("option", { name: client })
			.click();
	}
	await sheet.getByRole("button", { name: /^Create the (?:project|work code)$/ }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("main")).toContainText(`${code} · ${name}`);
}
