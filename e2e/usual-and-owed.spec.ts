import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Locator, Page } from "@playwright/test";

import { COLOR_SCHEME_COOKIE, type ColorSchemeChoice } from "../app/shell/color-scheme.server";
import { destinationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, setName, signIn } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";

// TS-119 in the browser. The usual expense categories: an owner of an
// organisation with none adds them from Expenses with the keyboard alone, the
// sheet naming each and Mileage's price at HMRC's rate, while a member is
// told whom to ask. Invoices opens on its overview: what is outstanding and
// overdue, what was paid this year, and a year of issued against paid, the
// bars beside a table; each figure leads to its list from the keyboard. Then
// both pages, the member's, the sheet and Workspace settings before and after
// at 390px and 1280px in both schemes, with no WCAG 2.2 A or AA violation.
//
// A new person makes an organisation of their own, so nothing here touches
// what another test looks at. As no page makes an organisation without
// categories, or an invoice already paid, those are written straight to the
// local D1 the server reads, as reports.spec.ts does; the file is therefore in
// the seeded project. Every date is worked out from today, so it passes on
// any day.
//
// With SHOT_DIR set, each page is also photographed there.

const OWNER = "Ada Owner";
const OWN_SESSION = join(tmpdir(), `timesifier-ts119-${randomUUID()}.json`);
const MEMBER_SESSION = join(tmpdir(), `timesifier-ts119-member-${randomUUID()}.json`);
test.use({ storageState: OWN_SESSION });
test.describe.configure({ mode: "serial" });

let slug: string;

/** Runs SQL against the local D1 of the server under test. */
function execute(sql: string) {
	execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--local", "--command", sql], {
		stdio: "pipe",
	});
}

const org = () => `(select id from organisations where slug = '${slug}')`;

/** Takes the organisation's categories away, as one made before TS-119 has none. */
const noCategories = () =>
	execute(`delete from expense_categories where organisation_id = ${org()};`);

/** A day in UTC, the organisation's zone. */
const iso = (instant: number) => new Date(instant).toISOString().slice(0, 10);
const now = Date.now();
const TODAY = iso(now);
const year = Number(TODAY.slice(0, 4));
const month = Number(TODAY.slice(5, 7)) - 1;
/** The first of the month two before this one, and the day after it. */
const EARLIER = iso(Date.UTC(year, month - 2, 1));
const EARLIER_DUE = iso(Date.UTC(year, month - 2, 2));
const IN_30_DAYS = iso(now + 30 * 86_400_000);
const monthName = (day: string) =>
	new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
		Date.parse(`${day}T00:00:00Z`),
	);

test.beforeAll(async ({ browser, baseURL }) => {
	test.setTimeout(180_000);
	const owner = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
	await ownAddress(owner, baseURL);
	const page = await owner.newPage();
	await signIn(page, newPerson().email);
	({ slug } = await createOrganisation(page));
	await setName(page, OWNER);
	await owner.storageState({ path: OWN_SESSION });
	await owner.close();

	const member = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
	await ownAddress(member, baseURL);
	const memberEmail = newPerson().email;
	await signIn(await member.newPage(), memberEmail);
	await member.storageState({ path: MEMBER_SESSION });
	await member.close();

	const [client, project, first, second] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
	const recorder = `(select user_id from memberships where organisation_id = ${org()} and role = 'owner')`;
	execute(
		[
			`insert into memberships (id, organisation_id, user_id, role, created_at, updated_at) values ('${randomUUID()}', ${org()}, (select id from users where email = '${memberEmail}'), 'member', 0, 0);`,
			`insert into projects (id, organisation_id, name, name_key, created_at, updated_at) values ('${project}', ${org()}, 'Site', 'site', 0, 0);`,
			`insert into clients (id, organisation_id, name, name_key, created_at, updated_at) values ('${client}', ${org()}, 'Initech', 'initech', 0, 0);`,
			// £500 issued two months ago, due the next day, £200 of it paid today: £300 overdue.
			`insert into invoices (id, organisation_id, number, client_id, status, currency, issued_on, due_on, subtotal_minor, total_minor, created_at, updated_at) values ('${first}', ${org()}, 'TS119-1', '${client}', 'partially_paid', 'GBP', '${EARLIER}', '${EARLIER_DUE}', 50000, 50000, 0, 0);`,
			`insert into payments (id, organisation_id, invoice_id, kind, amount_minor, paid_on, method, recorded_by, created_at) values ('${randomUUID()}', ${org()}, '${first}', 'payment', 20000, '${TODAY}', 'bank_transfer', ${recorder}, 0);`,
			// £120 issued today, due in 30 days: owed, not overdue.
			`insert into invoices (id, organisation_id, number, client_id, status, currency, issued_on, due_on, subtotal_minor, total_minor, created_at, updated_at) values ('${second}', ${org()}, 'TS119-2', '${client}', 'sent', 'GBP', '${TODAY}', '${IN_30_DAYS}', 12000, 12000, 0, 0);`,
		].join(" "),
	);
});

/**
 * Photographs the page when SHOT_DIR is set: the window as it stands, as for
 * a sheet, which is laid out on the window; or, by default, the whole page or
 * one `part` of it, in a window made as tall as the page for the photograph,
 * so that what is fixed to the window's foot is at the page's and not across
 * its middle.
 */
async function shot(
	page: Page,
	name: string,
	{ window = false, part }: { window?: boolean; part?: Locator } = {},
) {
	const directory = process.env.SHOT_DIR;
	if (!directory) return;
	const path = join(directory, `${name}.png`);
	const size = page.viewportSize();
	if (window || !size) {
		await page.screenshot({ path });
		return;
	}
	const height = await page.evaluate(() => document.documentElement.scrollHeight);
	await page.setViewportSize({ width: size.width, height: Math.max(height, size.height) });
	const box = await part?.boundingBox();
	await page.screenshot({
		path,
		clip: box
			? { x: 0, y: Math.max(0, box.y - 16), width: size.width, height: box.height + 32 }
			: undefined,
	});
	await page.setViewportSize(size);
}

/** The member on Expenses in a browser of their own, at a size and in a scheme when given. */
async function memberOnExpenses(
	browser: Browser,
	baseURL: string | undefined,
	window?: { viewport: { width: number; height: number }; scheme: ColorSchemeChoice },
): Promise<Page> {
	const member = await browser.newContext({
		baseURL,
		storageState: MEMBER_SESSION,
		viewport: window?.viewport,
	});
	if (window) {
		// The cookie My account would have set, as the `chosenScheme` fixture gives it.
		await member.addCookies([
			{
				name: COLOR_SCHEME_COOKIE,
				value: window.scheme,
				domain: new URL(baseURL ?? "http://localhost").hostname,
				path: "/",
				secure: true,
				sameSite: "Lax",
			},
		]);
	}
	const page = await member.newPage();
	await openShell(page, destinationPath(slug, "expenses"));
	return page;
}

async function expectNoProblems(page: Page, heading: string, unmeasurable: string[] = []) {
	await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
	expect(await problems(page, unmeasurable), `problems in "${heading}"`).toEqual([]);
}

const usualSheet = (page: Page) => page.getByRole("dialog", { name: "Add the usual categories" });

test("an owner adds the usual categories from Expenses with the keyboard; a member is told whom to ask", async ({
	page,
	browser,
	baseURL,
}) => {
	noCategories();
	// The member: no settings to open, the owner named instead.
	const theirs = await memberOnExpenses(browser, baseURL);
	await expect(
		theirs.getByText(`There are no expense categories to record in yet. Ask ${OWNER} to add them.`),
	).toBeVisible();
	await expect(theirs.getByRole("button", { name: "Add the usual categories" })).toHaveCount(0);
	await expect(theirs.getByRole("link", { name: /Workspace settings/ })).toHaveCount(0);
	await theirs.context().close();

	await openShell(page, destinationPath(slug, "expenses"));
	const add = page.getByRole("button", { name: "Add the usual categories" });
	await add.focus();
	await page.keyboard.press("Enter");
	const sheet = usualSheet(page);
	await expect(sheet).toBeVisible();
	await expect(
		sheet.getByRole("list", { name: "The usual categories" }).getByRole("listitem"),
	).toHaveText([
		"Travel",
		"Accommodation",
		"Meals and subsistence",
		"Mileage",
		"Equipment",
		"Software and subscriptions",
		"Training",
		"Other",
	]);
	await expect(sheet).toContainText(
		"Mileage is priced per mile at HMRC’s approved rate for cars and vans: £0.55 from Monday 6 April 2026, and £0.45 before.",
	);
	await expect(
		sheet.getByRole("link", { name: "HMRC’s approved rate for cars and vans" }),
	).toHaveAttribute(
		"href",
		/^https:\/\/www\.gov\.uk\/government\/publications\/rates-and-allowances-travel-mileage-and-fuel-allowances\//,
	);
	// Tab along the sheet to its one action.
	const confirm = sheet.getByRole("button", { name: "Add them" });
	for (let presses = 0; presses < 10; presses++) {
		if (await confirm.evaluate((button) => button === document.activeElement)) break;
		await page.keyboard.press("Tab");
	}
	await expect(confirm).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("status")).toHaveText("8 expense categories added.");
	await expect(page.getByRole("button", { name: "Record expense" })).toBeVisible();
	await expect(add).toHaveCount(0);
});

test("Invoices opens on what is owed, and each figure leads to its list from the keyboard", async ({
	page,
}) => {
	await openShell(page, destinationPath(slug, "invoices"));
	const main = page.getByRole("main");
	await expect(main).toContainText("Outstanding£420.00");
	await expect(main).toContainText("£300.00 overdue");
	await expect(main).toContainText(`Paid in ${year}£200.00`);

	const table = page.getByRole("table", { name: /^Issued and paid each month/ });
	await expect(table.getByRole("row")).toHaveCount(13);
	await expect(
		table.getByRole("row", { name: new RegExp(`^${monthName(EARLIER)} `) }),
	).toContainText(["£500.00", "£0.00"].join(""));
	await expect(table.getByRole("row", { name: new RegExp(`^${monthName(TODAY)} `) })).toContainText(
		["£120.00", "£200.00"].join(""),
	);

	const open = page.getByRole("link", { name: "Open invoices" });
	await open.focus();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/[?&]show=open/);
	await expect(page.getByRole("list", { name: "Open invoices" })).toContainText("TS119-1");
	await expect(main).not.toContainText(`Paid in ${year}`);

	await page.goBack();
	const paid = page.getByRole("link", { name: "Paid invoices" });
	await paid.focus();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/[?&]show=paid/);
	await expect(page.getByText("No paid invoices.")).toBeVisible();
});

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });
			const suffix = `${viewport.width}-${colorScheme}`;

			test("the usual categories on Expenses, in their sheet and in Workspace settings, the member's message, and Invoices' overview", async ({
				page,
				browser,
				baseURL,
			}) => {
				noCategories();
				// The member, told whom to ask.
				const theirs = await memberOnExpenses(browser, baseURL, { viewport, scheme: colorScheme });
				await expect(theirs.getByText(`Ask ${OWNER} to add them.`)).toBeVisible();
				await expectNoProblems(theirs, "Expenses");
				await shot(theirs, `expenses-member-${suffix}`);
				await theirs.context().close();

				// The owner, offered the usual ones on Expenses.
				await openShell(page, destinationPath(slug, "expenses"));
				const offer = page.getByRole("button", { name: "Add the usual categories" });
				await expect(offer).toBeVisible();
				await expectNoProblems(page, "Expenses");
				await shot(page, `expenses-no-categories-${suffix}`);
				await offer.click();
				const sheet = usualSheet(page);
				await expect(sheet).toBeVisible();
				expect(
					await problems(page, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS, EMPTY_INPUT]),
					"problems with the sheet open",
				).toEqual([]);
				await shot(page, `usual-categories-sheet-${suffix}`, { window: true });
				await page.keyboard.press("Escape");
				await expect(sheet).toBeHidden();

				// And in Workspace settings, where they are added: what a new organisation starts with.
				await openShell(page, destinationPath(slug, "settings"));
				const section = page.getByRole("region", { name: "Expense categories" });
				await expect(offer).toBeVisible();
				await expectNoProblems(page, "Workspace settings", [EMPTY_INPUT]);
				await shot(page, `settings-no-categories-${suffix}`, { part: section });
				await offer.click();
				await sheet.getByRole("button", { name: "Add them" }).click();
				await expect(sheet).toBeHidden();
				await expect(page.getByRole("status")).toHaveText("8 expense categories added.");
				await expect(page.getByRole("list", { name: "Expense categories" })).toContainText(
					"£0.55 per mile from Monday 6 April 2026",
				);
				await expect(offer).toHaveCount(0);
				await expectNoProblems(page, "Workspace settings", [EMPTY_INPUT]);
				await shot(page, `settings-usual-categories-${suffix}`, { part: section });

				await openShell(page, destinationPath(slug, "invoices"));
				await expect(
					page.getByRole("table", { name: /^Issued and paid each month/ }),
				).toBeVisible();
				await expectNoProblems(page, "Invoices", [EMPTY_INPUT]);
				await shot(page, `invoices-overview-${suffix}`);
			});
		});
	}
}
