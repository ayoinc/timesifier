import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { contractorsPath } from "../app/contractors/paths";
import { organisationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, setName, signIn } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { problems } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation, openMembers } from "./organisation";
import { createProject } from "./timesheet";

// Contractors (TS-079) in the browser: a person who owns an organisation marks
// themselves a contractor on Team › Members with the keyboard alone, tracks
// time on the Timesheet, and finds it on the Contractors report below Reports,
// with "Missing rate" as nobody has set them a cost rate; the export downloads;
// and no WCAG 2.2 A or AA violation at either window size in either scheme.
// Who may mark and who sees the report, role by role, is tested through the
// Worker (test/pages/contractors.test.ts).
//
// A new person signs in and makes an organisation of their own here, through
// the pages, so nothing here changes what another test looks at.

/** Monday 5 to Sunday 11 October 2026, a week in the past. */
const FIRST = "2026-10-05";
const LAST = "2026-10-11";
const NAME = "Ada Lovelace";

let slug: string;

/** The new person's session, which every test in this file uses. */
const OWN_SESSION = join(tmpdir(), `timesifier-contractors-${randomUUID()}.json`);
test.use({ storageState: OWN_SESSION });

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser, baseURL }) => {
	test.setTimeout(120_000);
	const context = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
	await ownAddress(context, baseURL);
	const page = await context.newPage();
	await signIn(page, newPerson().email);
	({ slug } = await createOrganisation(page));
	await setName(page, NAME);
	await createProject(page, slug, "Site");
	await context.storageState({ path: OWN_SESSION });
	await context.close();
});

const week = () => contractorsPath(slug, `?range=custom&from=${FIRST}&to=${LAST}`);
const contractors = (page: Page) => page.getByRole("list", { name: "Contractors' hours and cost" });

/** Presses Tab until `target` has the focus: the way a person without a pointer gets there. */
async function tabTo(page: Page, target: Locator, most = 60) {
	for (let step = 0; step < most; step++) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press("Tab");
	}
	throw new Error("Tab never reached the control.");
}

test("an owner marks themselves a contractor on Members with the keyboard alone", async ({
	page,
}) => {
	await openMembers(page, slug);
	const actions = page.getByRole("button", { name: `Actions for ${NAME}` });
	await tabTo(page, actions);
	await page.keyboard.press("Enter");
	const item = page.getByRole("menuitem", { name: "Mark as contractor" });
	await expect(item).toBeFocused();
	await page.keyboard.press("Enter");

	await expect(
		page.getByRole("status").filter({ hasText: "Marked as a contractor." }),
	).toBeVisible();
	await expect(page.getByRole("list", { name: "Members" })).toContainText("Owner · Contractor");
	// The menu has gone and the focus is back on what opened it.
	await expect(actions).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("menuitem", { name: "Mark as employee" })).toBeFocused();
	await page.keyboard.press("Escape");
});

test("time tracked on the Timesheet is on the Contractors report, unrounded, with its missing rate", async ({
	page,
}) => {
	await openShell(page, organisationPath(slug));
	await tabTo(page, page.getByRole("button", { name: "Track time" }));
	await page.keyboard.press("Enter");
	const sheet = page.getByRole("dialog", { name: "Track time" });
	await expect(sheet).toBeVisible();
	await tabTo(page, sheet.getByRole("textbox", { name: "Description" }));
	await page.keyboard.type("Survey");
	await page.keyboard.press("Tab");
	await expect(sheet.getByRole("textbox", { name: "Hours" })).toBeFocused();
	await page.keyboard.type("1:30");
	await page.keyboard.press("Enter");
	await expect(sheet).toBeHidden();

	// Moved to a day of a week in the past, so the report's range does not move with the clock.
	const main = page.getByRole("main");
	await tabTo(page, main.getByRole("button", { name: /^Actions for Survey/ }));
	await page.keyboard.press("Enter");
	await page.getByRole("menuitem", { name: "Edit entry" }).press("Enter");
	const editing = page.getByRole("dialog", { name: "Edit entry" });
	// A date or time field's keystrokes depend on how the browser's language
	// draws it, so its value is set as its typing ends. Enter sends.
	await editing.getByLabel("Date").fill("2026-10-07");
	await editing.getByLabel("Start").fill("09:00");
	await editing.getByLabel("End").fill("10:30");
	await editing.getByLabel("End").press("Enter");
	await expect(editing).toBeHidden();

	await openShell(page, week());
	await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
	await expect(
		page.getByRole("group", { name: "Report views" }).getByRole("link", { name: "Contractors" }),
	).toHaveAttribute("aria-current", "page");
	const row = contractors(page).getByRole("listitem");
	await expect(row).toHaveCount(1);
	await expect(row).toContainText(NAME);
	await expect(row).toContainText("1:30 hours · Missing rate for 1:30");
	await expect(row).toContainText("£0.00");
	await expect(page.getByText("Total, 1:30 hours")).toBeVisible();

	// The export holds the same, with the seconds.
	const downloading = page.waitForEvent("download");
	await page.getByRole("link", { name: "Export as CSV" }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe(
		`timesifier-${slug}-contractors-${FIRST}-to-${LAST}.csv`,
	);
	const lines = readFileSync(await download.path())
		.subarray(3)
		.toString("utf8")
		.split("\r\n");
	expect(lines).toEqual([
		"person,left_organisation,rate_missing,seconds,hours,currency,cost",
		`${NAME},no,yes,5400,1.500000,,`,
		"",
	]);
});

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });

			test("Contractors has no accessibility problems, with a contractor and with none", async ({
				page,
			}) => {
				await openShell(page, week());
				await expect(contractors(page)).toContainText(NAME);
				expect(await problems(page), "problems in the report").toEqual([]);

				await openShell(page, contractorsPath(slug, "?range=custom&from=2020-01-06&to=2020-01-12"));
				await expect(page.getByText("No contractor tracked time in this range.")).toBeVisible();
				expect(await problems(page), "problems in an empty report").toEqual([]);

				await openMembers(page, slug);
				await expect(page.getByRole("list", { name: "Members" })).toContainText("Contractor");
				expect(await problems(page), "problems on Members").toEqual([]);

				// Nothing runs off the side of the window.
				const overflow = await page.evaluate(
					() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
				);
				expect(overflow).toBeLessThanOrEqual(0);
			});
		});
	}
}
