import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { destinationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { problems } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";

// Reports (TS-014a) and the export as CSV (TS-014b) in the browser: a report
// chosen with the keyboard alone, its filters applied as they change, a
// custom range it cannot report on, the file it downloads, the stepper moving
// the range by its own length (TS-059, TS-091), and no WCAG 2.2 A or AA
// violation at either window size in either scheme. Whose time a report holds,
// role by role, is tested through the Worker (test/pages/reports.test.ts).
//
// A new person signs in and makes an organisation of their own here, so the
// entries below change nothing another test looks at, and the shared owner
// keeps the one organisation other tests expect. Entries are written straight
// to the local D1 the server reads, as no page here makes them.

/** Monday 5 to Sunday 11 October 2026, a week in the past. */
const FIRST = "2026-10-05";
const LAST = "2026-10-11";

let slug: string;

/** The new person's session, which every test in this file uses. */
const OWN_SESSION = join(tmpdir(), `timesifier-reports-${randomUUID()}.json`);
test.use({ storageState: OWN_SESSION });

/** Runs SQL against the local D1 of the server under test. */
function execute(sql: string) {
	execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--local", "--command", sql], {
		stdio: "pipe",
	});
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser, baseURL }) => {
	test.setTimeout(120_000);
	const context = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
	await ownAddress(context, baseURL);
	const page = await context.newPage();
	const { email } = newPerson();
	await signIn(page, email);
	({ slug } = await createOrganisation(page));
	await context.storageState({ path: OWN_SESSION });
	await context.close();

	const [client, website, internal] = [randomUUID(), randomUUID(), randomUUID()];
	const org = `(select id from organisations where slug = '${slug}')`;
	const user = `(select id from users where email = '${email}')`;
	const at = (instant: string) => Date.parse(instant);
	const entry = (project: string, description: string, from: string, to: string) =>
		`insert into time_entries (id, organisation_id, user_id, project_id, description, started_at, ended_at, created_at, updated_at) values ('${randomUUID()}', ${org}, ${user}, '${project}', '${description}', ${at(from)}, ${at(to)}, 0, 0);`;
	execute(
		[
			`insert into clients (id, organisation_id, name, name_key, created_at, updated_at) values ('${client}', ${org}, 'Initech', 'initech', 0, 0);`,
			`insert into projects (id, organisation_id, name, name_key, client_id, created_at, updated_at) values ('${website}', ${org}, 'Website', 'website', '${client}', 0, 0), ('${internal}', ${org}, 'Internal', 'internal', null, 0, 0);`,
			entry(website, "Design review", "2026-10-05T09:00:00Z", "2026-10-05T10:30:00Z"),
			// Across midnight in UTC and in London alike (the browser's zone, which the
			// person's becomes): it starts on Tuesday in both, so it counts on Tuesday.
			entry(website, "Release, overnight", "2026-10-06T22:30:00Z", "2026-10-07T00:30:00Z"),
			entry(internal, "=SUM(A1:A9)", "2026-10-08T14:00:00Z", "2026-10-08T14:45:00Z"),
		].join(" "),
	);
});

const reportsPath = () => destinationPath(slug, "reports");
const customWeek = () => `${reportsPath()}?range=custom&from=${FIRST}&to=${LAST}`;

/** The report's sheet: the one whose heading line starts "By". */
const totals = (page: Page) => page.getByRole("list", { name: /^Time by/ });

/** The keyboard focus is on the element, and it shows. */
async function expectFocusShown(element: Locator) {
	await expect(element).toBeFocused();
	const outline = await element.evaluate((focused) => getComputedStyle(focused).outlineStyle);
	expect(outline).toBe("solid");
}

/** Opens a Select that holds the focus and chooses `option` by typing, with Enter. */
async function choose(page: Page, list: string, option: string) {
	await page.keyboard.press("Enter");
	const listbox = page.getByRole("listbox", { name: list });
	await expect(listbox).toBeVisible();
	await page.keyboard.type(option.slice(0, 3));
	await expect(listbox.getByRole("option", { name: option })).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(listbox).toBeHidden();
}

test("a report is chosen and shown with the keyboard alone", async ({ page }) => {
	await openShell(page, reportsPath());
	await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
	// The filters apply as they change: there is nothing to press.
	await expect(page.getByRole("button", { name: "Show report" })).toHaveCount(0);

	const range = page.getByRole("button", { name: "This week Range" });
	await range.focus();
	await expectFocusShown(range);
	await choose(page, "Range", "Custom range");
	await expect(page.getByRole("button", { name: "Custom range Range" })).toBeFocused();

	// Choosing a custom range brings its two days, and waits for them.
	await expect(page).toHaveURL(reportsPath());
	await page.keyboard.press("Tab");
	await expect(page.getByRole("button", { name: "Project Group by" })).toBeFocused();
	await choose(page, "Group by", "Day");
	// Group by applies at once.
	await expect(page).toHaveURL(/[?&]group=day(&|$)/);
	await expect(page.getByRole("button", { name: "Day Group by" })).toBeFocused();
	await page.keyboard.press("Tab");
	const first = page.getByLabel("First day");
	await expect(first).toBeFocused();
	// A date field's typed order follows the browser's locale, and Tab moves
	// through its day, month and year; the value it takes does not change.
	await first.fill(FIRST);
	const last = page.getByLabel("Last day");
	await last.focus();
	// A whole date applies the range, with no button and no Enter.
	await last.fill(LAST);

	await expect(page).toHaveURL(`${reportsPath()}?range=custom&group=day&from=${FIRST}&to=${LAST}`);
	// An entry across midnight counts whole on the day it starts.
	await expect(totals(page).getByRole("listitem")).toHaveText([
		"Monday 5 October1:30",
		"Tuesday 6 October2:00",
		"Thursday 8 October0:45",
	]);
	await expect(page.getByText(/^Total\s*4:15$/)).toBeVisible();
	await expect(page.getByRole("heading", { level: 2, name: "Entries" })).toBeVisible();
});

test.describe("a range the page refuses", () => {
	// The page answers a range it cannot show with status 400, which Chromium logs.
	// The slug is known only once the seeding has run, so the refusal is named then.
	// biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's needs from its first argument.
	test.use({ refusals: async ({}, use) => use({ [reportsPath()]: [400] }) });

	test("a custom range that runs backwards shows the page again, the days as typed and why", async ({
		page,
	}) => {
		await openShell(page, `${reportsPath()}?range=custom&from=${LAST}&to=${FIRST}`);
		await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
		await expect(page.getByLabel("First day")).toHaveValue(LAST);
		const last = page.getByLabel("Last day");
		await expect(last).toHaveValue(FIRST);
		await expect(last).toHaveAttribute("min", LAST);
		await expect(page.getByText("Must be on or after the first day")).toBeVisible();
		await expect(page.getByRole("link", { name: "Export as CSV" })).toHaveCount(0);

		// Putting it right applies it.
		await last.fill("2026-10-12");
		await expect(page).toHaveURL(
			`${reportsPath()}?range=custom&group=project&from=${LAST}&to=2026-10-12`,
		);
		await expect(page.getByText("Must be on or after the first day")).toHaveCount(0);
		await expect(page.getByText(/^Total\s*0:00$/)).toBeVisible();
	});
});

test("groups by client, with the time of no client last", async ({ page }) => {
	await openShell(page, `${customWeek()}&group=client`);
	await expect(totals(page).getByRole("listitem")).toHaveText(["Initech3:30", "No client0:45"]);
});

test("the export downloads the rows on screen as a UTF-8 CSV named for the range", async ({
	page,
}) => {
	await openShell(page, `${customWeek()}&group=project`);
	const downloading = page.waitForEvent("download");
	await page.getByRole("link", { name: "Export as CSV" }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe(`timesifier-${slug}-${FIRST}-to-${LAST}.csv`);

	const path = await download.path();
	const bytes = readFileSync(path);
	expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
	const lines = bytes.subarray(3).toString("utf8").split("\r\n");
	expect(lines[0]).toBe(
		"entry_id,person,project,client,description,started_at,ended_at,duration_seconds,overtime",
	);
	expect(lines.at(-1)).toBe("");
	const rows = lines.slice(1, -1);
	// One row an entry: the one across midnight too.
	expect(rows).toHaveLength(3);
	expect(rows.join("\n")).toContain(
		',Website,Initech,"Release, overnight",2026-10-06T22:30:00Z,2026-10-07T00:30:00Z,7200,no',
	);
	expect(rows.join("\n")).toContain(
		",Internal,,'=SUM(A1:A9),2026-10-08T14:00:00Z,2026-10-08T14:45:00Z,2700,no",
	);
	const seconds = rows.reduce((sum, row) => sum + Number(row.split(",").at(-1)), 0);
	expect(seconds).toBe(4 * 3600 + 15 * 60);
});

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });

			test("Reports has no accessibility problems, with entries and with none", async ({
				page,
			}) => {
				await openShell(page, `${customWeek()}&group=project`);
				await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
				await expect(page.getByLabel("First day")).toBeVisible();
				expect(await problems(page), "problems in a report").toEqual([]);

				await openShell(page, `${reportsPath()}?range=custom&from=2020-01-06&to=2020-01-12`);
				await expect(page.getByText("Nothing tracked in this range.")).toBeVisible();
				expect(await problems(page), "problems in an empty report").toEqual([]);

				// Nothing runs off the side of the window.
				const overflow = await page.evaluate(
					() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
				);
				expect(overflow).toBeLessThanOrEqual(0);
			});
		});
	}
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	test(`the stepper moves the range by its own length, with the keyboard, ${viewport.width}px wide`, async ({
		page,
	}) => {
		await page.setViewportSize(viewport);
		/** Follows the link named `name` from the keyboard, with its focus shown. */
		const follow = async (name: string) => {
			const link = page.getByRole("main").getByRole("link", { name, exact: true });
			await link.focus();
			await expectFocusShown(link);
			await page.keyboard.press("Enter");
		};

		// A week, by a week: from the one before to the one with the entries.
		await openShell(page, `${reportsPath()}?range=week&from=2026-09-30`);
		await expect(page.getByText("Nothing tracked in this range.")).toBeVisible();
		await follow("Next week");
		await expect(page).toHaveURL(`${reportsPath()}?range=week&from=${FIRST}&group=project`);
		// Away from this week, the way back to it.
		await expect(page.getByRole("main").getByRole("link", { name: "This week" })).toBeVisible();
		await expect(page.getByText(/^Total\s*4:15$/)).toBeVisible();
		expect(await problems(page), "problems in a stepped week").toEqual([]);

		// A month, by a calendar month: October, which ends on the 31st, to November and back.
		await openShell(page, `${reportsPath()}?range=month&from=2026-10-31`);
		await expect(page.getByText(/^Total\s*4:15$/)).toBeVisible();
		await follow("Next month");
		await expect(page).toHaveURL(`${reportsPath()}?range=month&from=2026-11-01&group=project`);
		await expect(page.getByText(/^1–30 November 2026$/).first()).toBeVisible();
		await follow("Previous month");
		await expect(page).toHaveURL(`${reportsPath()}?range=month&from=2026-10-01&group=project`);
		await expect(page.getByText(/^Total\s*4:15$/)).toBeVisible();
		expect(await problems(page), "problems in a stepped month").toEqual([]);

		// A custom range, by its number of days, the grouping kept.
		await openShell(page, `${customWeek()}&group=day`);
		await follow("Next 7 days");
		await expect(page).toHaveURL(
			`${reportsPath()}?range=custom&from=2026-10-12&to=2026-10-18&group=day`,
		);
		await expect(page.getByText("Nothing tracked in this range.")).toBeVisible();
		await follow("Previous 7 days");
		await expect(page).toHaveURL(
			`${reportsPath()}?range=custom&from=${FIRST}&to=${LAST}&group=day`,
		);
		await expect(page.getByText(/^Total\s*4:15$/)).toBeVisible();
		expect(await problems(page), "problems in a stepped custom range").toEqual([]);

		// Nothing runs off the side of the window.
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
		);
		expect(overflow).toBeLessThanOrEqual(0);
	});
}
