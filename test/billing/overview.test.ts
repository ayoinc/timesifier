import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type OrganisationScope, organisationScope } from "~/db";
import { createDraft, issueInvoice, recordPayment, voidInvoice } from "~/invoices/invoices.server";
import { barStep } from "~/invoices/Overview";
import { invoiceOverview } from "~/invoices/overview.server";
import { receivablesOf } from "~/invoices/receivables.server";

import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { open, type Person, pageBody, textOf } from "../pages/harness";
import { KINDS, type Kind, seedRoles } from "../pages/roles-seed";

// The overview Invoices opens on (TS-119, S2-11), from fixed figures on a
// fixed day: what is outstanding and overdue, what was paid this year, and a
// year of issued against paid, each a SQL sum in the organisation's currency.
// Owners, admins and Finance are shown it; managers and members are shown no
// Invoices at all.

/** Wednesday 11 November 2026 in London, the organisation's zone being UTC. */
const T0 = Date.parse("2026-11-11T10:00:00Z");
const TODAY = "2026-11-11";
const INVOICES = "/app/acme/invoices";
const SEES_MONEY: Record<Kind, boolean> = {
	owner: true,
	admin: true,
	finance: true,
	manager: false,
	member: false,
};

let scope: OrganisationScope;
let people: Record<Kind, Person>;
let clientId: string;

beforeEach(async () => {
	await freshDatabase();
	const seeded = await seedRoles(captureEmail());
	people = seeded.people;
	scope = organisationScope(env.DB, seeded.acme.id);
	const [client] = await scope.clients.insert({ name: "Initech", nameKey: "initech" });
	if (!client) throw new Error("seed failed");
	clientId = client.id;
	await seedInvoices();
}, 60_000);

afterEach(() => {
	vi.restoreAllMocks();
});

const owner = () => people.owner.user.id;

/** An invoice of one line for `amountMinor`, issued on `issuedOn` and due `terms` days later; or a draft. */
async function invoice(
	amountMinor: number,
	issuedOn: string,
	{ terms = 30, currency = "GBP", draft = false } = {},
) {
	const made = await createDraft(scope, owner(), {
		clientId,
		currency,
		issuedOn,
		paymentTermsDays: terms,
		taxIds: [null, null],
		lines: [
			{
				kind: "manual",
				description: "Work",
				projectId: null,
				quantityMilli: 1000,
				unitPriceMinor: amountMinor,
				amountMinor,
				timeEntryIds: [],
				expenseIds: [],
			},
		],
	});
	if (!made.ok) throw new Error(made.problem);
	if (!draft) expect((await issueInvoice(scope, owner(), made.id))?.ok).toBe(true);
	return made.id;
}

async function pay(id: string, amountMinor: number, paidOn: string, kind = "payment") {
	const paid = await recordPayment(
		scope,
		owner(),
		id,
		{
			kind: kind as "payment" | "write_off",
			amountMinor,
			paidOn,
			method: kind === "payment" ? "bank_transfer" : null,
			note: null,
		},
		TODAY,
	);
	expect(paid?.ok).toBe(true);
}

/**
 * In GBP: A £100 issued 15 January, paid 1 February; B £500 issued 1 October,
 * due 31 October, £200 paid 20 October and £50 written off; C £300 issued
 * 2 November, due 2 December; D £70 issued 20 November 2025, paid 5 December
 * 2025; E £40 issued 1 October 2025, never paid. And what no figure counts:
 * a £999 USD invoice, a £10 draft, and an £800 invoice voided.
 */
async function seedInvoices() {
	await pay(await invoice(10_000, "2026-01-15"), 10_000, "2026-02-01");
	const b = await invoice(50_000, "2026-10-01");
	await pay(b, 20_000, "2026-10-20");
	await pay(b, 5_000, "2026-10-21", "write_off");
	await invoice(30_000, "2026-11-02");
	await pay(await invoice(7_000, "2025-11-20"), 7_000, "2025-12-05");
	await invoice(4_000, "2025-10-01");
	await invoice(99_900, "2026-11-01", { currency: "USD" });
	await invoice(1_000, "2026-11-03", { draft: true });
	await voidInvoice(scope, owner(), await invoice(80_000, "2026-06-01"), new Date(T0));
}

describe("the figures", () => {
	it("are what is owed, overdue and paid this year, and twelve months of issued against paid, in GBP", async () => {
		const overview = await invoiceOverview(scope, "GBP", TODAY);
		expect(overview).toMatchObject({
			currency: "GBP",
			outstandingMinor: 25_000 + 30_000 + 4_000,
			overdueMinor: 25_000 + 4_000,
			paidThisYearMinor: 10_000 + 20_000,
			otherCurrencies: ["USD"],
		});
		const empty = { issuedMinor: 0, paidMinor: 0 };
		expect(overview.months).toEqual([
			{ month: "2025-12-01", issuedMinor: 0, paidMinor: 7_000 },
			{ month: "2026-01-01", issuedMinor: 10_000, paidMinor: 0 },
			{ month: "2026-02-01", issuedMinor: 0, paidMinor: 10_000 },
			{ month: "2026-03-01", ...empty },
			{ month: "2026-04-01", ...empty },
			{ month: "2026-05-01", ...empty },
			{ month: "2026-06-01", ...empty },
			{ month: "2026-07-01", ...empty },
			{ month: "2026-08-01", ...empty },
			{ month: "2026-09-01", ...empty },
			{ month: "2026-10-01", issuedMinor: 50_000, paidMinor: 20_000 },
			{ month: "2026-11-01", issuedMinor: 30_000, paidMinor: 0 },
		]);
	});

	it("put outstanding and overdue at the receivables report's figures for the same day", async () => {
		for (const today of [TODAY, "2026-10-31", "2026-12-03"]) {
			const overview = await invoiceOverview(scope, "GBP", today);
			const gbp = (await receivablesOf(scope, today)).find((r) => r.currency === "GBP");
			expect(overview.outstandingMinor, today).toBe(gbp?.outstandingMinor);
			expect(overview.overdueMinor, today).toBe(gbp?.overdueMinor);
		}
	});

	it("count only the USD invoices in a USD organisation, and name GBP as the other currency", async () => {
		const overview = await invoiceOverview(scope, "USD", TODAY);
		expect(overview).toMatchObject({
			outstandingMinor: 99_900,
			overdueMinor: 0,
			paidThisYearMinor: 0,
			otherCurrencies: ["GBP"],
		});
		expect(overview.months.at(-1)).toEqual({
			month: "2026-11-01",
			issuedMinor: 99_900,
			paidMinor: 0,
		});
	});

	it("start the year on 1 January: in January, last year's payments are not this year's", async () => {
		const overview = await invoiceOverview(scope, "GBP", "2027-01-10");
		expect(overview.paidThisYearMinor).toBe(0);
		expect(overview.months[0]?.month).toBe("2026-02-01");
		expect(overview.months.at(-1)?.month).toBe("2027-01-01");
	});

	it("draw a bar in steps of the largest month, any sum at least one step", () => {
		expect(barStep(0, 50_000)).toBe(0);
		expect(barStep(50_000, 50_000)).toBe(32);
		expect(barStep(25_000, 50_000)).toBe(16);
		expect(barStep(1, 50_000)).toBe(1);
		expect(barStep(5, 0)).toBe(0);
	});
});

describe("the page", () => {
	it.each(KINDS)(
		"opens on the overview for the %s when they see money, and is not there otherwise",
		async (kind) => {
			vi.spyOn(Date, "now").mockReturnValue(T0);
			const response = await open(INVOICES, people[kind]);
			if (!SEES_MONEY[kind]) {
				expect(response.status).toBe(404);
				const html = await pageBody(response);
				expect(html).not.toContain("Paid in 2026");
				expect(html).not.toContain("£590.00");
				return;
			}
			expect(response.status).toBe(200);
			const text = textOf(await pageBody(response));
			expect(text).toContain("Outstanding £590.00");
			expect(text).toContain("£290.00 overdue");
			expect(text).toContain("Paid in 2026 £300.00");
			expect(text).toContain("Invoices in USD are not in these figures");
			expect(text).toContain("Issued and paid each month, December 2025 to November 2026, in GBP");
			expect(text).toContain("October 2026 £500.00 £200.00");
			expect(text).toContain("December 2025 £0.00 £70.00");
			expect(text).toContain("Open invoices");

			// A list of one state is only that list.
			const drafts = textOf(await pageBody(await open(`${INVOICES}?show=draft`, people[kind])));
			expect(drafts).toContain("Drafts invoices");
			expect(drafts).not.toContain("Paid in 2026");
		},
	);
});
