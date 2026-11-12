import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { destinationPath, organisationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, setName, signIn } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { problems } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";
import { createProject } from "./timesheet";

// The lock date, the timesheet deadline and the Activity log in the browser
// (TS-065, TS-072): a new owner tracks an hour on a past day on the Timesheet,
// opens Workspace settings › Timesheet locking with the keyboard alone and
// locks that day with a reason. The Day view of that day says it is on or
// before the lock date, with the reason, and offers no Track time. The owner
// sets a weekly deadline with auto-lock, then finds "Changed the lock date" on
// the Activity log, narrows it to the lock date and deadline, downloads it as
// CSV, and opens an entry's History from the Day view of a day still open.
// No WCAG 2.2 A or AA violation at either window size in either scheme. What
// each role may do is tested through the Worker (test/pages/lock-date.test.ts,
// test/pages/activity.test.ts).
//
// A new person signs in and makes an organisation of their own here, through
// the pages, so nothing here changes what another test looks at.

/** Wednesday 7 October 2026: the day tracked on and then locked. */
const LOCKED_DAY = "2026-10-07";
/** Sunday 11 October 2026: the lock date. */
const LOCK_DATE = "2026-10-11";
/** Wednesday 21 October 2026: a past day after the lock date, still open. */
const OPEN_DAY = "2026-10-21";
const REASON = "Q3 books closed";
const NAME = "Ada Lovelace";

let slug: string;

/** The Day view of `day`, as `dayPath` in app/timesheet/views.ts writes it. */
const dayPath = (day: string) => `${organisationPath(slug)}?day=${day}`;

/** The new person's session, which every test in this file uses. */
const OWN_SESSION = join(tmpdir(), `timesifier-governance-${randomUUID()}.json`);
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

/** Presses Tab until `target` has the focus: the way a person without a pointer gets there. */
async function tabTo(page: Page, target: Locator, most = 80) {
	for (let step = 0; step < most; step++) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press("Tab");
	}
	throw new Error("Tab never reached the control.");
}

/** Tracks `hours` on `day` from the Day view of that day, with a description. */
async function trackOn(page: Page, day: string, description: string, hours: string) {
	await openShell(page, dayPath(day));
	await page.getByRole("button", { name: "Track time" }).click();
	const sheet = page.getByRole("dialog", { name: "Track time" });
	await sheet.getByRole("textbox", { name: "Description" }).fill(description);
	await sheet.getByRole("textbox", { name: "Hours" }).fill(hours);
	await sheet.getByRole("button", { name: "Save entry" }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("list", { name: "Entries" })).toContainText(description);
}

test("an hour tracked on a past day is locked by the lock date, set with the keyboard alone", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await trackOn(page, LOCKED_DAY, "Survey", "1");
	await trackOn(page, OPEN_DAY, "Drawings", "1:30");

	// Workspace settings from the navigation, and Timesheet locking in it, by keyboard.
	await openShell(page, dayPath(OPEN_DAY));
	const settings = page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: "Workspace settings", exact: true });
	await tabTo(page, settings);
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(destinationPath(slug, "settings"));
	await expect(page.getByRole("heading", { name: "Timesheet locking" })).toBeVisible();
	const set = page.getByRole("button", { name: "Set the lock date" });
	await tabTo(page, set, 200);
	await page.keyboard.press("Enter");

	const sheet = page.getByRole("dialog", { name: "Set the lock date" });
	await expect(sheet).toBeVisible();
	// A date field's keystrokes depend on how the browser's language draws it,
	// so its value is set as its typing ends.
	await sheet.getByLabel("Locked through").fill(LOCK_DATE);
	await tabTo(page, sheet.getByRole("textbox", { name: "Reason" }));
	await page.keyboard.type(REASON);
	await page.keyboard.press("Enter");
	await expect(sheet).toBeHidden();
	await expect(
		page.getByRole("status").filter({ hasText: "Time is locked through 11 October 2026." }),
	).toBeVisible();
	await expect(page.getByRole("main")).toContainText("Locked through 11 October 2026");
	await expect(page.getByRole("main")).toContainText(`Reason: ${REASON}`);

	// The locked day says why, and offers nothing to track or change.
	await openShell(page, dayPath(LOCKED_DAY));
	const main = page.getByRole("main");
	await expect(main).toContainText("This day is on or before the lock date, Sunday 11 October");
	await expect(main).toContainText(`The reason given: ${REASON}`);
	await expect(main.getByRole("list", { name: "Entries" })).toContainText("Survey");
	await expect(page.getByRole("button", { name: "Track time" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /^Actions for Survey/ })).toHaveCount(0);
});

test("a weekly deadline with auto-lock is set on Timesheet locking", async ({ page }) => {
	await openShell(page, destinationPath(slug, "settings"));
	await page.getByRole("button", { name: "Change the timesheet deadline" }).click();
	const sheet = page.getByRole("dialog", { name: "Change the timesheet deadline" });
	// The radio group is one stop; the arrow keys choose in it.
	await tabTo(page, sheet.getByRole("radio", { name: "No deadline" }));
	await page.keyboard.press("ArrowDown");
	await expect(sheet.getByRole("radio", { name: "Weekly" })).toBeChecked();
	await sheet.getByLabel("Time").fill("17:00");
	await sheet.getByRole("textbox", { name: "Auto-lock after (days, optional)" }).fill("2");
	await sheet.getByRole("button", { name: "Save" }).click();
	await expect(sheet).toBeHidden();
	const main = page.getByRole("main");
	await expect(main).toContainText("Weekly, Friday at 17:00");
	await expect(main).toContainText("Auto-lock: 2 days after each deadline");
});

test("the Activity log holds the lock date's change, narrows to its kind, and downloads it", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await openShell(page, dayPath(OPEN_DAY));
	await page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: "Activity log", exact: true })
		.click();
	await expect(page.getByRole("heading", { level: 1, name: "Activity log" })).toBeVisible();
	const records = page.getByRole("list", { name: "Records, newest first" });
	await expect(records).toContainText("Changed the lock date");
	await expect(records).toContainText("Created a time entry");

	// Kind applies as soon as it is chosen.
	await page.getByRole("button", { name: "Every kind Kind" }).click();
	await page
		.getByRole("listbox", { name: "Kind" })
		.getByRole("option", { name: "Lock date and deadline" })
		.click();
	await expect(page).toHaveURL(/[?&]kind=organisation\b/);
	await expect(records).toContainText("Changed the lock date");
	await expect(records).not.toContainText("Created a time entry");

	const downloading = page.waitForEvent("download");
	await page.getByRole("link", { name: "Export as CSV" }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toMatch(
		new RegExp(`^timesifier-${slug}-activity-\\d{4}-\\d{2}-\\d{2}-to-\\d{4}-\\d{2}-\\d{2}\\.csv$`),
	);
	const lines = readFileSync(await download.path())
		.subarray(3)
		.toString("utf8")
		.split("\r\n");
	expect(lines[0]).toBe(
		"recorded_at,performed_by,source,action,what,owned_by,subject_type,subject_id,changes",
	);
	const rows = lines.slice(1, -1);
	expect(rows.length).toBeGreaterThanOrEqual(2);
	expect(rows.every((row) => row.includes(",organisation,"))).toBe(true);
	expect(rows.some((row) => row.includes("lock_date.changed"))).toBe(true);
	expect(rows.some((row) => row.includes(REASON))).toBe(true);
});

test("an entry's History opens from the Day view's Actions menu", async ({ page }) => {
	await openShell(page, dayPath(OPEN_DAY));
	await page.getByRole("button", { name: /^Actions for Drawings/ }).click();
	await page.getByRole("menuitem", { name: "History" }).click();
	await expect(page.getByRole("heading", { level: 1, name: "Entry history" })).toBeVisible();
	await expect(page.getByRole("list", { name: "Changes, oldest first" })).toContainText(
		"Created a time entry",
	);
	await page.getByRole("link", { name: "Back to the day" }).click();
	await expect(page).toHaveURL(dayPath(OPEN_DAY));
});

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });

			test("Timesheet locking, a locked day, the Activity log and an entry's history have no accessibility problems", async ({
				page,
			}) => {
				await openShell(page, destinationPath(slug, "settings"));
				await expect(page.getByRole("heading", { name: "Timesheet locking" })).toBeVisible();
				expect(await problems(page), "problems in Workspace settings").toEqual([]);

				await openShell(page, dayPath(LOCKED_DAY));
				await expect(page.getByRole("main")).toContainText("on or before the lock date");
				expect(await problems(page), "problems on a locked day").toEqual([]);

				await openShell(page, destinationPath(slug, "activity"));
				await expect(page.getByRole("list", { name: "Records, newest first" })).toBeVisible();
				expect(await problems(page), "problems on the Activity log").toEqual([]);

				await openShell(page, dayPath(OPEN_DAY));
				await page.getByRole("button", { name: /^Actions for Drawings/ }).click();
				await page.getByRole("menuitem", { name: "History" }).click();
				await expect(page.getByRole("heading", { level: 1, name: "Entry history" })).toBeVisible();
				expect(await problems(page), "problems on an entry's history").toEqual([]);

				// Nothing runs off the side of the window.
				const overflow = await page.evaluate(
					() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
				);
				expect(overflow).toBeLessThanOrEqual(0);
			});
		});
	}
}
