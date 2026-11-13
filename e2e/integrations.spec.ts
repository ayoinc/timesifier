import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { calendarFeedsPath, importPath } from "../app/integrations/paths";
import { retainersPath } from "../app/invoices/paths";
import { destinationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";

// Integrations in a browser (TS-076, TS-081, TS-087, TS-089): API tokens,
// webhooks, a CSV import with its preview and revert, calendar feeds, and the
// ZIP of every invoice's PDF. No WCAG 2.2 A or AA violation on each page and
// each open sheet, at both window sizes and in both schemes; each task done
// with the keyboard alone. Each test signs in a new person who makes an
// organisation of their own; everything is made through the pages.

test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

async function ownNewOrganisation(page: Page) {
	const person = newPerson();
	await signIn(page, person.email);
	return { slug: (await createOrganisation(page)).slug, email: person.email };
}

async function expectNoProblems(page: Page, heading: string) {
	await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
	expect(await problems(page, [EMPTY_INPUT]), `problems in "${heading}"`).toEqual([]);
}

async function expectNoProblemsInSheet(page: Page, name: string) {
	await expect(page.getByRole("dialog", { name })).toBeVisible();
	expect(
		await problems(page, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS, EMPTY_INPUT]),
		`problems with "${name}" open`,
	).toEqual([]);
}

/** Presses Tab until `name` has the focus, then Enter. */
async function pressWithKeyboard(page: Page, role: "button" | "link", name: string) {
	const target = page.getByRole(role, { name, exact: true }).first();
	for (let presses = 0; presses < 60; presses++) {
		await page.keyboard.press("Tab");
		if (await target.evaluate((element) => element === document.activeElement)) {
			await page.keyboard.press("Enter");
			return;
		}
	}
	throw new Error(`Tab never reached ${name}`);
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });

			test("tokens and webhooks, made and shown once, with the keyboard alone", async ({
				page,
			}) => {
				// A sign-in, which can wait its turn at the mailbox, and eight scans by axe.
				test.slow();
				const { slug } = await ownNewOrganisation(page);
				await page.goto(destinationPath(slug, "integrations"));
				await expectNoProblems(page, "Integrations");

				// A token: name it, keep its one scope, make it; it is shown once.
				await pressWithKeyboard(page, "button", "Create token");
				await expectNoProblemsInSheet(page, "Create a token");
				await page.keyboard.type("Zapier");
				await page.keyboard.press("Enter");
				const reveal = page.getByRole("dialog", { name: "Your token: Zapier" });
				await expect(reveal).toBeVisible();
				const token = (await reveal.locator("code").textContent()) ?? "";
				expect(token).toMatch(/^tsf_[A-Za-z0-9_-]{43}$/);
				await expectNoProblemsInSheet(page, "Your token: Zapier");
				await reveal.getByRole("button", { name: "Done" }).press("Enter");
				await expect(reveal).toBeHidden();
				await expect(page.getByRole("status").first()).toContainText("Token made: Zapier.");
				await expect(page.getByText(`tsf_${token.slice(4, 12)}…`)).toBeVisible();
				await expect(page.getByText(token)).toHaveCount(0);

				// It works, then it is revoked.
				const me = await page.request.get("/api/v1/me", {
					headers: { Authorization: `Bearer ${token}` },
				});
				expect(me.status()).toBe(200);
				await page.getByRole("button", { name: "Revoke Zapier" }).press("Enter");
				const revoke = page.getByRole("dialog", { name: "Revoke Zapier?" });
				await expectNoProblemsInSheet(page, "Revoke Zapier?");
				await revoke.getByRole("button", { name: "Revoke token" }).press("Enter");
				await expect(revoke).toBeHidden();
				const refused = await page.request.get("/api/v1/me", {
					headers: { Authorization: `Bearer ${token}` },
				});
				expect(refused.status()).toBe(401);

				// A webhook: its secret is shown once.
				await page.getByRole("button", { name: "Add webhook" }).press("Enter");
				await expectNoProblemsInSheet(page, "Add a webhook");
				await page.keyboard.type("https://hooks.example.com/timesifier");
				await page.keyboard.press("Enter");
				const secret = page.getByRole("dialog", { name: "Its signing secret" });
				await expect(secret.locator("code")).toHaveText(/^[0-9a-f]{64}$/);
				await secret.getByRole("button", { name: "Done" }).press("Enter");
				await expect(page.getByText("https://hooks.example.com/timesifier")).toBeVisible();
				await expectNoProblems(page, "Integrations");
			});

			test("a CSV of time, previewed, imported and reverted", async ({ page }) => {
				const { slug, email } = await ownNewOrganisation(page);
				await page.goto(importPath(slug, "time"));
				await expectNoProblems(page, "Import time");

				const csv = [
					"Date,Client,Project,Task,Notes,Hours,Email",
					"2026-10-05,Initech,Website,Design,Homepage,2.5,",
					`2026-10-05,Initech,Website,Design,Homepage,2.5,${email}`,
					`2026-10-06,,Research,Reading,,1,${email}`,
				].join("\r\n");
				await page.getByLabel("CSV file").setInputFiles({
					name: "harvest.csv",
					mimeType: "text/csv",
					buffer: Buffer.from(csv),
				});
				await page.getByRole("button", { name: "Upload and preview" }).press("Enter");
				await expect(page.getByRole("heading", { name: "Preview of harvest.csv" })).toBeVisible();
				await expect(page.getByText("2 to import, 1 to skip.")).toBeVisible();
				await expect(page.getByText("No person.")).toBeVisible();
				await expectNoProblems(page, "Import time");

				await page.getByRole("button", { name: "Import 2 entries" }).press("Enter");
				await expect(page.getByRole("heading", { name: "harvest.csv: imported" })).toBeVisible();
				await expectNoProblems(page, "Import time");

				await page.getByRole("button", { name: "Revert harvest.csv" }).press("Enter");
				await expectNoProblemsInSheet(page, "Revert harvest.csv?");
				await page
					.getByRole("dialog", { name: "Revert harvest.csv?" })
					.getByRole("button", { name: "Revert import" })
					.press("Enter");
				await expect(page.getByRole("status").first()).toContainText(
					"Import reverted: 2 entries deleted.",
				);
			});

			test("a calendar feed, made, read and revoked", async ({ page }) => {
				const { slug } = await ownNewOrganisation(page);
				await page.goto(calendarFeedsPath(slug));
				await expectNoProblems(page, "Calendar feeds");
				await pressWithKeyboard(page, "button", "Make a feed");
				await expectNoProblemsInSheet(page, "Make a feed");
				await page
					.getByRole("dialog", { name: "Make a feed" })
					.getByRole("button", { name: "Make the feed" })
					.press("Enter");
				const reveal = page.getByRole("dialog", { name: "Your feed's address" });
				const address = (await reveal.locator("code").textContent()) ?? "";
				expect(address).toMatch(/\/calendar\/cal_[A-Za-z0-9_-]{43}\.ics$/);
				await reveal.getByRole("button", { name: "Done" }).press("Enter");

				const feed = await page.request.get(new URL(address).pathname);
				expect(feed.status()).toBe(200);
				expect(feed.headers()["content-type"]).toContain("text/calendar");
				expect(await feed.text()).toContain("BEGIN:VCALENDAR");

				await page.getByRole("button", { name: /^Revoke my feed/ }).press("Enter");
				await page
					.getByRole("dialog", { name: "Revoke this feed?" })
					.getByRole("button", { name: "Revoke feed" })
					.press("Enter");
				await expect(page.getByRole("status").first()).toContainText("Feed revoked.");
				expect((await page.request.get(new URL(address).pathname)).status()).toBe(404);
				await expectNoProblems(page, "Calendar feeds");
			});

			test("every invoice as a PDF in one ZIP, downloaded with the keyboard", async ({ page }) => {
				test.slow();
				const { slug } = await ownNewOrganisation(page);
				const client = "Babbage Engines Ltd";

				// A client and a draft invoice for a retainer's funds, made through the pages.
				await openShell(page, destinationPath(slug, "clients"));
				await page.getByRole("button", { name: "Create client" }).click();
				const sheet = page.getByRole("dialog", { name: "Create a client" });
				await sheet.getByLabel("Client name").fill(client);
				await sheet.getByRole("button", { name: "Create the client" }).click();
				await expect(sheet).toBeHidden();
				await openShell(page, retainersPath(slug));
				const opening = page.getByRole("region", { name: "New retainer" });
				await choose(page, opening, "Client", client);
				await opening.getByRole("button", { name: "Open retainer" }).click();
				await expect(opening.getByRole("status")).toHaveText(
					"Retainer opened. Invoice funds into it to start.",
				);
				await page.getByLabel(/^Amount/).fill("500");
				await page.getByRole("button", { name: `Invoice funds into ${client}` }).click();
				const heading = page.getByRole("heading", { level: 1, name: /^Invoice / });
				await expect(heading).toBeVisible();
				const number = ((await heading.textContent()) ?? "").replace(/^Invoice /, "");

				// The export, beside the export of all time, reached with Tab and taken with Enter.
				await page.goto(destinationPath(slug, "integrations"));
				await expectNoProblems(page, "Integrations");
				const downloading = page.waitForEvent("download");
				await pressWithKeyboard(page, "link", "Export all invoices as PDFs");
				const download = await downloading;
				expect(download.suggestedFilename()).toBe(`${slug}-all-invoices.zip`);
				const bytes = readFileSync(await download.path());
				expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
				const name = `invoice-${number.replace(/[^A-Za-z0-9-]/g, "-")}.pdf`;
				expect(bytes.toString("latin1")).toContain(name);
			});
		});
	}
}

/** Chooses `option` in the Select labelled `label` within `within`. */
async function choose(page: Page, within: Locator, label: string, option: string) {
	await within.getByRole("button", { name: new RegExp(label) }).click();
	await page.getByRole("listbox", { name: label }).getByRole("option", { name: option }).click();
	await expect(within.getByRole("button", { name: new RegExp(label) })).toContainText(option);
}
