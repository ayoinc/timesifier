import type { Page } from "@playwright/test";

import { destinationPath } from "../app/shell/destinations";
import { expect, openShell } from "./fixtures";

/**
 * Creates an active project in the organisation with this slug through the
 * Projects page (TS-011a), as the signed-in person, who may create one.
 */
export async function createProject(page: Page, slug: string, name: string) {
	await openShell(page, destinationPath(slug, "projects"));
	await page.getByRole("button", { name: "Create project" }).click();
	const sheet = page.getByRole("dialog", { name: "Create a project" });
	await sheet.getByLabel("Project name").fill(name);
	await sheet.getByRole("button", { name: "Create the project" }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("main")).toContainText(name);
}
