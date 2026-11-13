import type { BrowserContext, Locator, Page } from "@playwright/test";

import {
	billingReportPath,
	estimatesPath,
	invoiceSettingsPath,
	invoicesPath,
	newInvoicePath,
	recurringListPath,
	retainersPath,
	uninvoicedPath,
} from "../app/invoices/paths";
import { destinationPath } from "../app/shell/destinations";
import { foundInMessageSentBy, newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { EMPTY_INPUT, problems } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";

// Bill in a browser (TS-073, TS-074, TS-077): the owner invoices a client and
// takes the payment with the keyboard alone; an estimate is sent to a client's
// contact, accepted on its public link by somebody signed out, and made an
// invoice. Then every page of Invoices and Estimates at both window sizes and
// in both schemes, with no WCAG 2.2 A or AA violation. Each test is a new
// person with an organisation of their own, and nothing is seeded.
//
// This branch has no page that gives a project a billable rate or a fixed fee
// (the Rates page is Money's), so New invoice has no priced time to make a
// draft from here. The draft below comes from a retainer's funds and an
// accepted estimate instead; drafts made from tracked time are covered by the
// worker tests (test/billing/sources.test.ts) until the rates page lands.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS * 2 });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

const CLIENT = "Babbage Engines Ltd";
/** The link in an estimate's email, where the client accepts or declines it. */
const ESTIMATE_LINK = /https?:\/\/[^\s/]+\/estimate\/[\w-]+\/[\w-]+/;

/** Creates a client of the organisation through the Clients page. */
async function createClient(page: Page, slug: string, name = CLIENT) {
	await openShell(page, destinationPath(slug, "clients"));
	await page.getByRole("button", { name: "Create client" }).click();
	const sheet = page.getByRole("dialog", { name: "Create a client" });
	await sheet.getByLabel("Client name").fill(name);
	await sheet.getByRole("button", { name: "Create the client" }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("status")).toHaveText(`Client created: ${name}.`);
}

/** Chooses `option` in the Select labelled `label` within `within`. */
async function choose(page: Page, within: Locator, label: string, option: string) {
	await within.getByRole("button", { name: new RegExp(label) }).click();
	await page.getByRole("listbox", { name: label }).getByRole("option", { name: option }).click();
	await expect(within.getByRole("button", { name: new RegExp(label) })).toContainText(option);
}

/** Presses Tab until `target` has the focus, as a person with a keyboard would. */
async function tabTo(page: Page, target: Locator, most = 80) {
	for (let presses = 0; presses < most; presses++) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press("Tab");
	}
	await expect(target).toBeFocused();
}

/** Opens the invoice's More menu and chooses `item`. */
async function more(page: Page, item: string) {
	await page.getByRole("button", { name: /^More actions for invoice / }).click();
	await page.getByRole("menuitem", { name: item }).click();
}

/** Starts an estimate for the client on Estimates, and arrives at its page. */
async function startEstimate(page: Page, slug: string, subject: string) {
	await openShell(page, estimatesPath(slug));
	const start = page.getByRole("region", { name: "New estimate" });
	await choose(page, start, "Client", CLIENT);
	await start.getByLabel("Subject").fill(subject);
	await start.getByRole("button", { name: "Start estimate" }).click();
	await expect(page.getByRole("heading", { level: 1, name: /^Estimate / })).toBeVisible();
	await expect(page.getByText(`For ${CLIENT}. Draft.`)).toBeVisible();
}

/** Adds a line on an estimate's page. */
async function addEstimateLine(page: Page, description: string, unitPrice: string) {
	const adding = page.getByRole("region", { name: "Add a line" });
	await adding.getByLabel("Description").fill(description);
	await adding.getByLabel(/^Unit price/).fill(unitPrice);
	await adding.getByRole("button", { name: "Add line" }).click();
	await expect(adding.getByRole("status")).toHaveText("Line added.");
	await expect(page.getByRole("region", { name: "Draft" })).toContainText(description);
}

/**
 * Gives the client a billing contact and sends the estimate to them, and
 * returns the link the email holds, where the estimate is accepted.
 */
async function sendEstimate(page: Page, email: string): Promise<string> {
	const sending = page.getByRole("region", { name: "Send" });
	await sending.getByLabel("Email address").fill(email);
	await sending.getByRole("button", { name: "Add address" }).click();
	await expect(sending.getByRole("status")).toHaveText(`${email} added.`);
	// The box is drawn by its label; the input under it is hidden from the pointer.
	const to = sending.getByRole("checkbox", { name: email });
	await sending.getByText(email, { exact: true }).click();
	await expect(to).toBeChecked();
	await sending.getByLabel("Note").fill("As we discussed on Tuesday.");
	const link = await foundInMessageSentBy(
		() => sending.getByRole("button", { name: "Send estimate" }).click(),
		ESTIMATE_LINK,
		"the estimate's link",
	);
	await expect(sending.getByRole("status").first()).toHaveText(/^Estimate .+ is sent to /);
	return link;
}

/** A context signed in as nobody, with an address of its own. */
async function signedOut(context: BrowserContext, baseURL: string | undefined) {
	const browser = context.browser();
	if (!browser) throw new Error("No browser.");
	const outside = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
	await ownAddress(outside, baseURL);
	return outside;
}

test("the owner invoices a client, issues it, and records its payment with the keyboard alone", async ({
	page,
}) => {
	await signIn(page, newPerson().email);
	const { slug } = await createOrganisation(page);
	await createClient(page, slug);

	// Invoices has nothing yet; New invoice offers the client, which has no priced time to invoice.
	await openShell(page, invoicesPath(slug));
	await expect(page.getByRole("heading", { name: "No invoices yet" })).toBeVisible();
	// With no invoice there is no overview (TS-119): nothing to sum.
	await expect(page.getByRole("table", { name: /^Issued and paid each month/ })).toHaveCount(0);
	await page.getByRole("button", { name: "New invoice" }).click();
	await expect(page).toHaveURL(newInvoicePath(slug));
	const what = page.getByRole("form", { name: "What to invoice" });
	await choose(page, what, "Client", CLIENT);
	await what.getByRole("button", { name: "Show what can be invoiced" }).click();
	await expect(page).toHaveURL(/[?&]client=/);
	await expect(page.getByRole("button", { name: "Create draft invoice" })).toBeDisabled();

	// A retainer for the client, and an invoice for its funds: a draft.
	await openShell(page, retainersPath(slug));
	const opening = page.getByRole("region", { name: "New retainer" });
	await choose(page, opening, "Client", CLIENT);
	await opening.getByRole("button", { name: "Open retainer" }).click();
	await expect(opening.getByRole("status")).toHaveText(
		"Retainer opened. Invoice funds into it to start.",
	);
	await page.getByLabel(/^Amount/).fill("500");
	await page.getByRole("button", { name: `Invoice funds into ${CLIENT}` }).click();
	const heading = page.getByRole("heading", { level: 1, name: /^Invoice / });
	await expect(heading).toBeVisible();
	const number = ((await heading.textContent()) ?? "").replace(/^Invoice /, "");
	const lead = page.getByText(new RegExp(`^${CLIENT} · `));
	await expect(lead).toContainText("· Draft ·");

	// A free line on the draft.
	await more(page, "Add a line");
	const adding = page.getByRole("dialog", { name: "Add a line" });
	await adding.getByLabel("Description").fill("Discovery workshop");
	await adding.getByLabel("Quantity").fill("2");
	await adding.getByLabel(/^Unit price/).fill("125");
	await adding.getByRole("button", { name: "Add the line" }).click();
	await expect(adding).toBeHidden();
	await expect(page.getByRole("status")).toHaveText("Line added.");
	await expect(page.getByRole("region", { name: "Draft" })).toContainText("Discovery workshop");
	await expect(lead).toContainText("750.00");

	// Issued without sending: its lines are fixed, and it is owed.
	await more(page, "Issue without sending");
	const issuing = page.getByRole("dialog", { name: `Issue invoice ${number}?` });
	await issuing.getByRole("button", { name: "Issue invoice" }).click();
	await expect(issuing).toBeHidden();
	await expect(page.getByRole("status")).toHaveText(
		`Invoice ${number} is issued. Its lines are fixed now.`,
	);
	await expect(lead).toContainText("· Open ·");
	await expect(lead).toContainText("750.00 owed");

	// The payment, with the keyboard alone: Tab to Record payment, Enter, the
	// whole balance as it is offered, a note typed, and Enter to record it.
	const record = page.getByRole("button", { name: "Record payment" });
	await tabTo(page, record);
	await page.keyboard.press("Enter");
	const paying = page.getByRole("dialog", { name: "Record a payment" });
	await expect(paying).toBeVisible();
	await expect(paying.getByLabel(/^Amount/)).toHaveValue("750.00");
	const note = paying.getByLabel("Note");
	await tabTo(page, note);
	await page.keyboard.type("Paid by bank transfer");
	await page.keyboard.press("Enter");
	await expect(paying).toBeHidden();
	await expect(page.getByRole("status")).toHaveText(/^Payment of .*750\.00 recorded\.$/);
	await expect(lead).toContainText("· Paid ·");
	await expect(lead).toContainText("0.00 owed");
	await expect(page.getByRole("button", { name: "Record payment" })).toHaveCount(0);
	await expect(page.getByRole("region", { name: "Payments" })).toContainText(
		"Paid by bank transfer",
	);

	// Paid invoices list it as paid.
	await openShell(page, `${invoicesPath(slug)}?show=paid`);
	await expect(page.getByRole("list", { name: "Paid invoices" })).toContainText(
		`${number} · ${CLIENT}`,
	);
	await expect(page.getByRole("list", { name: "Paid invoices" })).toContainText("Paid");
});

test("an estimate is sent to the client's contact, accepted on its link signed out, and made an invoice", async ({
	page,
	context,
	baseURL,
}) => {
	await signIn(page, newPerson().email);
	const { name: organisation, slug } = await createOrganisation(page);
	await createClient(page, slug);

	await startEstimate(page, slug, "Website rebuild");
	const estimate = page.url();
	const number = (
		(await page.getByRole("heading", { level: 1, name: /^Estimate / }).textContent()) ?? ""
	).replace(/^Estimate /, "");
	await addEstimateLine(page, "Design and build", "1200");
	const link = await sendEstimate(page, `accounts-${number.toLowerCase()}@example.com`);
	await expect(page.getByText(new RegExp(`^For ${CLIENT}\\. Sent, sent `))).toBeVisible();

	// The client opens the link without an account, and accepts it.
	const outside = await signedOut(context, baseURL);
	const client = await outside.newPage();
	await openShell(client, new URL(link).pathname, "main");
	await expect(client.getByRole("heading", { level: 1, name: `Estimate ${number}` })).toBeVisible();
	await expect(client.getByText(`From ${organisation}. Sent.`)).toBeVisible();
	await expect(client.getByRole("main")).toContainText("Design and build");
	await client.getByRole("button", { name: "Accept estimate" }).click();
	await expect(client.getByRole("status")).toHaveText("Thank you. The estimate is accepted.");
	await expect(client.getByRole("button", { name: "Accept estimate" })).toHaveCount(0);
	await outside.close();

	// The staff see it accepted, and make it an invoice.
	await openShell(page, new URL(estimate).pathname);
	await expect(page.getByText(new RegExp(`^For ${CLIENT}\\. Accepted `))).toBeVisible();
	await openShell(page, estimatesPath(slug));
	await expect(page.getByRole("list", { name: "Estimates" })).toContainText(
		"Accepted · Website rebuild",
	);
	await page.getByRole("link", { name: `${number} · ${CLIENT}` }).click();
	await page.getByRole("button", { name: "Make invoice" }).click();
	await expect(page.getByRole("heading", { level: 1, name: /^Invoice / })).toBeVisible();
	await expect(page.getByText(new RegExp(`^${CLIENT} · Draft · `))).toContainText("1,200.00");
	await expect(page.getByRole("region", { name: "Draft" })).toContainText("Design and build");

	await openShell(page, new URL(estimate).pathname);
	await expect(page.getByRole("link", { name: "Open its invoice" })).toBeVisible();
});

/** What axe says of text that a scrolled container clips. */
const PARTLY_SCROLLED_AWAY = "elmPartiallyObscured";

/**
 * Expects no problem on the page. The row of Invoice pages scrolls sideways
 * where its five tabs are wider than the window, and axe cannot measure the
 * tab the scroll cuts: such a row is scanned from each end, so every tab is
 * measured whole once.
 */
async function expectNoProblems(page: Page, heading: string | RegExp, unmeasurable: string[] = []) {
	await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
	const rows = page.getByRole("group", { name: "Invoice pages" }).locator("..");
	const scrolls =
		(await rows.count()) > 0 && (await rows.evaluate((row) => row.scrollWidth > row.clientWidth));
	if (!scrolls) {
		expect(await problems(page, unmeasurable), `problems in "${heading}"`).toEqual([]);
		return;
	}
	for (const end of [0, 1]) {
		await rows.evaluate((row, at) => {
			row.scrollLeft = at * row.scrollWidth;
		}, end);
		expect(
			await problems(page, [...unmeasurable, PARTLY_SCROLLED_AWAY]),
			`problems in "${heading}", its tabs scrolled to the ${end ? "end" : "start"}`,
		).toEqual([]);
	}
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });

			test("Invoices and its pages, Estimates, an estimate, its public link, and an invoice", async ({
				page,
			}) => {
				await signIn(page, newPerson().email);
				const { slug } = await createOrganisation(page);
				await createClient(page, slug);

				// An estimate with a line, sent: its page, and the client's page of it.
				await startEstimate(page, slug, "Website rebuild");
				const estimate = new URL(page.url()).pathname;
				await addEstimateLine(page, "Design and build", "1200");
				const link = await sendEstimate(page, `accounts-${Date.now()}@example.com`);
				await expectNoProblems(page, /^Estimate /, [EMPTY_INPUT]);

				await openShell(page, new URL(link).pathname, "main");
				await expectNoProblems(page, /^Estimate /);
				await page.getByRole("button", { name: "Accept estimate" }).click();
				await expect(page.getByRole("status")).toHaveText("Thank you. The estimate is accepted.");
				await expectNoProblems(page, /^Estimate /);

				await openShell(page, estimatesPath(slug));
				await expectNoProblems(page, "Estimates", [EMPTY_INPUT]);

				// Made an invoice: one invoice, a draft, then issued.
				await openShell(page, estimate);
				await expectNoProblems(page, /^Estimate /);
				await page.getByRole("button", { name: "Make invoice" }).click();
				await expectNoProblems(page, /^Invoice /);
				await more(page, "Issue without sending");
				await page
					.getByRole("dialog", { name: /^Issue invoice / })
					.getByRole("button", { name: "Issue invoice" })
					.click();
				await expect(page.getByRole("status")).toHaveText(/ is issued\./);
				await expectNoProblems(page, /^Invoice /);

				await openShell(page, invoicesPath(slug));
				await expectNoProblems(page, "Invoices");

				await openShell(page, newInvoicePath(slug));
				const what = page.getByRole("form", { name: "What to invoice" });
				await choose(page, what, "Client", CLIENT);
				await what.getByRole("button", { name: "Show what can be invoiced" }).click();
				await expect(page).toHaveURL(/[?&]client=/);
				await expectNoProblems(page, "New invoice", [EMPTY_INPUT]);

				await openShell(page, uninvoicedPath(slug));
				await expectNoProblems(page, "Uninvoiced", [EMPTY_INPUT]);

				await openShell(page, recurringListPath(slug));
				await expectNoProblems(page, "Recurring invoices", [EMPTY_INPUT]);

				await openShell(page, retainersPath(slug));
				await expectNoProblems(page, "Retainers", [EMPTY_INPUT]);

				for (const report of ["receivables", "invoiced", "payments"] as const) {
					await openShell(page, billingReportPath(slug, report));
					await expectNoProblems(page, "Invoice reports", [EMPTY_INPUT]);
				}

				await openShell(page, invoiceSettingsPath(slug));
				await expectNoProblems(page, "Invoice settings", [EMPTY_INPUT]);
			});
		});
	}
}
