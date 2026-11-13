import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { Locator, Page } from "@playwright/test";

import { destinationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { EMPTY_INPUT, problems } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";

// The day an entry is stored with: the one it starts on in the browser's zone,
// which the person's becomes (TS-111).
const dayIn = (instant: number) => new Date(instant).toLocaleDateString("en-CA");

// Projects searched by a project's or its client's name, grouped under the
// clients, with each project's hours to date; Clients filtered by name
// (TS-057). Each test signs in a new person who makes an organisation of
// their own, and gives it clients, projects and time straight in the
// database, so nothing here changes what the other tests see. Each view is
// scanned at both window sizes, and the search is done with the keyboard alone.

test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

/**
 * Runs SQL against the database the test server uses. Two workers writing at
 * once find it locked, so a refused write is tried again.
 */
function sql(command: string): string {
	for (let attempt = 1; ; attempt++) {
		try {
			return execFileSync(
				"pnpm",
				["exec", "wrangler", "d1", "execute", "DB", "--local", "--json", "--command", command],
				{ encoding: "utf8", stdio: "pipe" },
			);
		} catch (error) {
			if (attempt === 5) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * attempt);
		}
	}
}

/**
 * Gives the organisation `slug` two clients and three projects, Website
 * (Globex), Payroll (Initech) and Office move (none), and an hour and a half
 * of `email`'s time on Website.
 */
function seedOrganisation(slug: string, email: string) {
	const now = Date.now();
	const organisation = `(select id from organisations where slug = '${slug}')`;
	const globex = randomUUID();
	const initech = randomUUID();
	const website = randomUUID();
	const client = (id: string, name: string) =>
		`insert into clients (id, organisation_id, name, name_key, created_at, updated_at) values ('${id}', ${organisation}, '${name}', '${name.toLowerCase()}', ${now}, ${now})`;
	const project = (id: string, name: string, clientId: string | null) =>
		`insert into projects (id, organisation_id, name, name_key, client_id, created_at, updated_at) values ('${id}', ${organisation}, '${name}', '${name.toLowerCase()}', ${clientId ? `'${clientId}'` : "null"}, ${now}, ${now})`;
	sql(
		[
			client(globex, "Globex"),
			client(initech, "Initech"),
			project(website, "Website", globex),
			project(randomUUID(), "Payroll", initech),
			project(randomUUID(), "Office move", null),
			`insert into time_entries (id, organisation_id, user_id, project_id, description, started_at, spent_on, ended_at, created_at, updated_at) values ('${randomUUID()}', ${organisation}, (select id from users where email = '${email}'), '${website}', 'Copy', ${now - 5_400_000 - 60_000}, '${dayIn(now - 5_400_000 - 60_000)}', ${now - 60_000}, ${now}, ${now})`,
		].join("; "),
	);
}

/** A new person signs in and creates an organisation with clients, projects and time. Its slug. */
async function ownSeededOrganisation(page: Page): Promise<string> {
	const { email } = newPerson();
	await signIn(page, email);
	const { slug } = await createOrganisation(page);
	seedOrganisation(slug, email);
	return slug;
}

async function expectNoProblems(
	page: Page,
	heading: string,
	state: string,
	unmeasurable: string[] = [],
) {
	await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
	expect(await problems(page, unmeasurable), `problems in "${heading}", ${state}`).toEqual([]);
}

/** The element holds the keyboard focus and shows it. */
async function expectFocusShown(element: Locator) {
	await expect(element).toBeFocused();
	const outline = await element.evaluate((focused) => {
		const { outlineStyle, outlineWidth } = getComputedStyle(focused);
		return { outlineStyle, width: Number.parseFloat(outlineWidth) };
	});
	expect(outline.outlineStyle).toBe("solid");
	expect(outline.width).toBeGreaterThan(0);
}

/**
 * Presses Tab from `from` until `to` holds the focus. A field shows it by its
 * own indicator, so only the outline of a button or link is checked.
 */
async function tabUntil(page: Page, from: Locator, to: Locator) {
	await from.focus();
	for (let presses = 0; presses < 30; presses++) {
		if (await to.evaluate((element) => element === document.activeElement)) break;
		await page.keyboard.press("Tab");
	}
	if ((await to.evaluate((element) => element.tagName)) === "INPUT") {
		await expect(to).toBeFocused();
	} else {
		await expectFocusShown(to);
	}
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	test.describe(`in a window ${viewport.width}px wide`, () => {
		test.use({ viewport });

		test("Projects grouped by client with hours, searched, and Clients filtered", async ({
			page,
		}) => {
			const slug = await ownSeededOrganisation(page);
			const projects = destinationPath(slug, "projects");
			await openShell(page, projects);

			const groups = page.getByRole("tabpanel").getByRole("heading", { level: 2 });
			await expect(groups).toHaveText(["Globex", "Initech", "No client"]);
			await expect(page.getByRole("list", { name: "Active projects: Globex" })).toContainText(
				/Website\s*1:30/,
			);
			await expect(page.getByRole("list", { name: "Active projects: No client" })).toContainText(
				/Office move\s*0:00/,
			);
			// The search field is empty here: it has no text to measure.
			await expectNoProblems(page, "Projects", "grouped", [EMPTY_INPUT]);

			await openShell(page, `${projects}?q=initech`);
			await expect(groups).toHaveText(["Initech"]);
			await expect(page.getByRole("searchbox", { name: "Search projects or clients" })).toHaveValue(
				"initech",
			);
			await expectNoProblems(page, "Projects", "searched");

			await openShell(page, `${projects}?q=nothing`);
			await expect(page.getByText("No active project has “nothing” in its name")).toBeVisible();
			await expectNoProblems(page, "Projects", "with no match");

			await openShell(page, `${destinationPath(slug, "clients")}?q=glob`);
			await expect(page.getByRole("list", { name: "Active clients" })).toContainText("Globex");
			await expect(page.getByRole("list", { name: "Active clients" })).not.toContainText("Initech");
			await expectNoProblems(page, "Clients", "filtered");
		});
	});
}

test("Projects and Clients are searched with the keyboard alone, in the address", async ({
	page,
}) => {
	const slug = await ownSeededOrganisation(page);
	const projects = destinationPath(slug, "projects");
	await openShell(page, projects);
	const heading = page.getByRole("heading", { level: 1, name: "Projects" });

	// The field, from the heading, by Tab; Enter applies the search at once, in the address.
	const field = page.getByRole("searchbox", { name: "Search projects or clients" });
	await tabUntil(page, heading, field);
	await page.keyboard.type("GLOB");
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\?q=GLOB$/);
	const groups = page.getByRole("tabpanel").getByRole("heading", { level: 2 });
	await expect(groups).toHaveText(["Globex"]);
	await expect(page.getByRole("tabpanel")).not.toContainText("Payroll");
	await expect(field).toHaveValue("GLOB");

	// The Archived tab keeps the search; the arrow keys move between the tabs.
	await page.getByRole("tab", { name: "Active" }).focus();
	await page.keyboard.press("ArrowRight");
	await expect(page.getByRole("tab", { name: "Archived" })).toBeFocused();
	await expect(page).toHaveURL(/\?q=GLOB&show=archived$/);
	await expect(page.getByText("No archived project has “GLOB” in its name")).toBeVisible();
	await page.keyboard.press("ArrowLeft");
	await expect(page).toHaveURL(/\?q=GLOB$/);

	// Clear search, by Tab from the field, brings every project back.
	const clear = page.getByRole("button", { name: "Clear search" });
	await tabUntil(page, field, clear);
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(new RegExp(`${projects}$`));
	await expect(groups).toHaveText(["Globex", "Initech", "No client"]);
	await expect(field).toHaveValue("");

	// No Search, Filter or Apply button is on the page (TS-091, W15).
	for (const word of ["Search", "Filter", "Apply"]) {
		await expect(page.getByRole("button", { name: word, exact: true })).toHaveCount(0);
	}

	// Clients: the filter applies as it is typed, with no key and no button (W28).
	await openShell(page, destinationPath(slug, "clients"));
	const filter = page.getByRole("searchbox", { name: "Search clients" });
	await tabUntil(page, page.getByRole("heading", { level: 1, name: "Clients" }), filter);
	await page.keyboard.type("init");
	await expect(page).toHaveURL(/\?q=init$/);
	const clients = page.getByRole("list", { name: "Active clients" });
	await expect(clients).toContainText("Initech");
	await expect(clients).not.toContainText("Globex");
});
