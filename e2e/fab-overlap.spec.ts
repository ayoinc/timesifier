import type { Page } from "@playwright/test";

import { destinationPath, signInSettingsPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { EMPTY_INPUT, problems } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";

// Under 600px Track time floats above the navigation bar. The page keeps room
// under its last content for it, so scrolled to the end nothing of the page lies
// under the button: not the last row's Edit on Projects and Clients, nor the
// last words and controls of Settings › Sign-in.

test.use({ storageState: SIGNED_OUT, viewport: { width: 390, height: 844 } });
test.describe.configure({ timeout: TIME_WITH_TURNS });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

type Box = { x: number; y: number; width: number; height: number };

function intersects(a: Box, b: Box): boolean {
	return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function create(page: Page, kind: "project" | "client", name: string) {
	await page.getByRole("button", { name: `Create ${kind}` }).click();
	const sheet = page.getByRole("dialog", { name: `Create a ${kind}` });
	await sheet.getByLabel(kind === "project" ? "Project name" : "Client name").fill(name);
	await sheet.getByRole("button", { name: `Create the ${kind}` }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("status")).toContainText(name);
}

/** Scrolls to the end; the main column's content clears the button, and its last control is pressable. */
async function expectClear(page: Page, name: string) {
	const last = page
		.locator(
			"main :is(a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])):visible",
		)
		.last();
	const trackTime = page.getByRole("button", { name: "Track time", exact: true });
	await expect(trackTime).toBeVisible();
	await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
	await expect
		.poll(() =>
			page.evaluate(
				() => Math.ceil(window.scrollY + innerHeight) >= document.documentElement.scrollHeight,
			),
		)
		.toBe(true);
	await page.screenshot({ path: test.info().outputPath(`${name}.png`) });

	const button = await trackTime.boundingBox();
	const lastBox = await last.boundingBox();
	if (!button || !lastBox) throw new Error(`no box on ${name}`);
	expect(intersects(lastBox, button), `${name}: the last control under Track time`).toBe(false);
	// The column's last content of any kind, text included, ends above the button.
	const contentEnd = await page.locator("main > div").evaluate((column) => {
		const range = document.createRange();
		range.selectNodeContents(column);
		return range.getBoundingClientRect().bottom;
	});
	expect(contentEnd, `${name}: the content runs under Track time`).toBeLessThanOrEqual(button.y);

	await last.focus();
	await expect(last).toBeFocused();
	await last.click({ trial: true });
	// The list's search field, empty, has no text to measure.
	expect(await problems(page, [EMPTY_INPUT]), `problems on ${name}`).toEqual([]);
}

for (const colorScheme of ["light", "dark"] as const) {
	test.describe(`at 390px, in the ${colorScheme} scheme`, () => {
		test.use({ chosenScheme: colorScheme });

		test("Track time covers nothing at the end of Projects, Clients and Settings › Sign-in", async ({
			page,
		}) => {
			await signIn(page, newPerson().email);
			const { slug } = await createOrganisation(page);

			await openShell(page, destinationPath(slug, "projects"));
			for (const name of ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"]) {
				await create(page, "project", name);
			}
			await expectClear(page, `projects-${colorScheme}`);

			await openShell(page, destinationPath(slug, "clients"));
			for (const name of ["Acme", "Beacon", "Cobalt", "Dune", "Ember", "Fable"]) {
				await create(page, "client", name);
			}
			await expectClear(page, `clients-${colorScheme}`);

			await openShell(page, signInSettingsPath(slug));
			await expectClear(page, `sign-in-${colorScheme}`);
		});
	});
}
