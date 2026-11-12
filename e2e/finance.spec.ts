import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { destinationPath, organisationPath } from "../app/shell/destinations";
import {
	foundInMessageSentBy,
	ownAddress,
	type Person,
	setName,
	signIn,
	TIME_WITH_TURNS,
} from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { EMPTY_INPUT, problems } from "./axe";
import { expect, openShell, test } from "./fixtures";
import {
	createOrganisation,
	expectRefusal,
	INVITATION_LINK,
	openInvitations,
} from "./organisation";
import { createProject, workEveryDay } from "./timesheet";

// The Finance role in the browser (TS-075): a new owner makes an organisation,
// a project, an hour and a half of time and a client through the pages, and
// invites a second new person as Finance from Team > Invitations. That person
// joins from the link in their email, and opens Invoices, Estimates, Clients,
// Reports, Dashboards and the Activity log with the keyboard; on Reports they
// narrow the report to the owner and back to Everyone, and download the CSV,
// which holds the owner's time. Every page has no WCAG 2.2 A or AA violation at
// either window size in either scheme. Nothing is written to the database but
// through the pages. What each role may do, route by route, is tested through
// the Worker (test/pages/finance.test.ts).
//
// Invoices, Estimates and Dashboards are other cards' pages, empty states on
// this branch: here they are opened and read.

const owner: Person = { name: "Ada Lovelace", email: `ada-${randomUUID()}@example.com` };
const finance: Person = {
	name: "Katherine Johnson",
	email: `katherine-${randomUUID()}@example.com`,
};

let slug: string;
let organisationName: string;

/** The Finance person's session, which every test in this file uses. */
const OWN_SESSION = join(tmpdir(), `timesifier-finance-${randomUUID()}.json`);
test.use({ storageState: OWN_SESSION });

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser, baseURL }) => {
	test.setTimeout(4 * TIME_WITH_TURNS);

	// The owner: an organisation, a project, time on it today, and a client.
	const owners = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
	await ownAddress(owners, baseURL);
	const page = await owners.newPage();
	await signIn(page, owner.email);
	({ slug, name: organisationName } = await createOrganisation(page));
	await setName(page, owner.name);
	await createProject(page, slug, "Website");
	// Time is tracked today: every day is worked, so it is regular time whatever day the run is on (TS-095).
	await workEveryDay(page, slug);

	await openShell(page, organisationPath(slug));
	await page.getByRole("button", { name: "Track time", exact: true }).click();
	const track = page.getByRole("dialog", { name: "Track time" });
	await track.getByRole("textbox", { name: "Description" }).fill("Design review");
	await track.getByRole("textbox", { name: "Hours" }).fill("1.5");
	await track.getByRole("button", { name: "Save entry" }).click();
	await expect(track).toBeHidden();

	await openShell(page, destinationPath(slug, "clients"));
	await page.getByRole("button", { name: "Create client" }).click();
	const creating = page.getByRole("dialog", { name: "Create a client" });
	await creating.getByLabel("Client name").fill("Initech");
	await creating.getByRole("button", { name: "Create the client" }).click();
	await expect(creating).toBeHidden();

	// The invitation, as Finance.
	await openInvitations(page, slug);
	await page.getByRole("button", { name: "Invite a person" }).click();
	const inviting = page.getByRole("dialog", { name: "Invite a person" });
	await inviting.getByLabel("Email address").fill(finance.email);
	// The radio itself is hidden; its label is what a pointer presses.
	await inviting.getByText("Finance", { exact: true }).click();
	const link = await foundInMessageSentBy(
		() => inviting.getByRole("button", { name: "Send invitation" }).click(),
		INVITATION_LINK,
		"the invitation's link",
	);
	await expect(page.getByText("Invited as a Finance member.")).toBeVisible();
	await owners.close();

	// Finance joins, from the link, in a browser of their own.
	const theirs = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
	await ownAddress(theirs, baseURL);
	const other = await theirs.newPage();
	await signIn(other, finance.email, `/sign-in?next=${encodeURIComponent(link)}`);
	await expect(other).toHaveURL(link);
	await expect(
		other.getByText(
			`${owner.name} (${owner.email}) invited you to join ${organisationName} as a Finance member.`,
		),
	).toBeVisible();
	const joining = other.getByRole("button", { name: "Join" });
	await joining.focus();
	await other.keyboard.press("Enter");
	await expect(other).toHaveURL(organisationPath(slug));
	await setName(other, finance.name);
	await theirs.storageState({ path: OWN_SESSION });
	await theirs.close();
});

/** The pages this card shows Finance, by their link's label, and the heading each opens on. */
const PAGES = [
	{ id: "invoices", label: "Invoices" },
	{ id: "estimates", label: "Estimates" },
	{ id: "clients", label: "Clients" },
	{ id: "reports", label: "Reports" },
	{ id: "dashboards", label: "Dashboards" },
	{ id: "activity", label: "Activity log" },
] as const;

/** Follows a link from the keyboard: it takes the focus, and Enter opens it. */
async function follow(page: Page, link: Locator) {
	await link.focus();
	await expect(link).toBeFocused();
	await page.keyboard.press("Enter");
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

test("Finance is shown its pages, opens each with the keyboard, and reads them", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await openShell(page, organisationPath(slug));
	const navigation = page.getByRole("navigation", { name: "Main" });

	for (const { id, label } of PAGES) {
		await follow(page, navigation.getByRole("link", { name: label, exact: true }));
		await expect(page).toHaveURL(destinationPath(slug, id));
		await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();

		if (id === "clients") {
			// Read, not changed: the owner's client, and nothing to press.
			await expect(page.getByRole("main")).toContainText("Initech");
			await expect(page.getByRole("button", { name: "Create client" })).toHaveCount(0);
			await expect(page.getByRole("button", { name: "Actions for Initech" })).toHaveCount(0);
		}
		if (id === "activity") {
			// The owner's records: the project she created.
			await expect(page.getByRole("main")).toContainText("Website");
		}
	}

	// What Finance manages nothing of is not in its navigation.
	for (const label of ["Team", "Tasks", "Approvals", "Integrations", "Workspace settings"]) {
		await expect(navigation.getByRole("link", { name: label, exact: true })).toHaveCount(0);
	}
});

test("Team and Workspace settings are the 404 page to Finance", async ({ page, refusals }) => {
	for (const id of ["team", "settings"] as const) {
		const path = destinationPath(slug, id);
		expectRefusal(refusals, path, 404);
		expect((await page.goto(path))?.status(), path).toBe(404);
	}
});

test("on Reports Finance narrows to the owner, returns to Everyone, and downloads everyone's rows", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await openShell(page, destinationPath(slug, "reports"));
	await expect(page.getByText(`Everyone's time in ${organisationName}.`)).toBeVisible();

	// The report applies as soon as the person changes (TS-091).
	await page.getByRole("button", { name: "Everyone Person" }).focus();
	await choose(page, "Person", owner.name);
	await expect(page.getByText(`The time of ${owner.name}.`)).toBeVisible();
	await expect(page.getByText(/^Total\s*1:30$/)).toBeVisible();

	await page.getByRole("button", { name: `${owner.name} Person` }).focus();
	await choose(page, "Person", "Everyone");
	await expect(page.getByText(`Everyone's time in ${organisationName}.`)).toBeVisible();
	await expect(page.getByText(/^Total\s*1:30$/)).toBeVisible();

	const downloading = page.waitForEvent("download");
	await follow(page, page.getByRole("link", { name: "Export as CSV" }));
	const download = await downloading;
	const bytes = readFileSync(await download.path());
	const lines = bytes.subarray(3).toString("utf8").split("\r\n");
	expect(lines[0]).toBe(
		"entry_id,person,project,client,description,started_at,ended_at,duration_seconds,overtime",
	);
	const rows = lines.slice(1, -1);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toContain(`,${owner.name},Website,,Design review,`);
	expect(rows[0]?.endsWith(",5400,no")).toBe(true);
});

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });

			test("each page Finance is shown has no accessibility problems", async ({ page }) => {
				for (const { id, label } of PAGES) {
					await openShell(page, destinationPath(slug, id));
					await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
					// Clients' search field is empty, so axe cannot measure its text.
					expect(await problems(page, [EMPTY_INPUT]), `problems in ${label}`).toEqual([]);
				}
			});
		});
	}
}
