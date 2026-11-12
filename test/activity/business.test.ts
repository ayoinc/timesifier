import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type OrganisationScope, organisationScope } from "~/db";
import { addEstimateLine, createEstimate, estimateToken } from "~/estimates/estimates.server";
import { sendInvoice } from "~/invoices/deliver.server";
import {
	createDraft,
	deletePayment,
	issueInvoice,
	recordPayment,
	voidInvoice,
} from "~/invoices/invoices.server";
import { addContact } from "~/invoices/mail.server";
import { estimateLinkPath } from "~/invoices/paths";
import {
	addRecurringLine,
	changeRecurring,
	createRecurring,
	stopRecurring,
} from "~/invoices/recurring.server";
import { openRetainer } from "~/invoices/retainers.server";
import { projectPath } from "~/projects/projects";
import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { value } from "../organisations/harness";
import { type Person, submit } from "../pages/harness";
import { KINDS, type Kind, seedRoles } from "../pages/roles-seed";

// The activity log (TS-064, TS-092) of the business features: rates, budgets,
// invoices, payments, sends, estimates, recurring invoices, retainers and
// expense categories. Each change writes exactly one record, in the batch that
// makes it, saying who made it (or none, for the client on an estimate's
// link), through which door, and never the words a person typed. Imports and
// the API are in test/integrations (import.test.ts, api.test.ts).

const ACME = "acme";
const SETTINGS = "/app/acme/settings";
const PROFITABILITY = "/app/acme/reports/profitability";
const INVOICES = "/app/acme/invoices";
const ESTIMATES = "/app/acme/estimates";
const TODAY = "2026-11-02";
const NOW = new Date("2026-11-02T12:00:00Z");

/** A note typed with a payment: it must never reach the log. */
const TYPED = "Cheque 4471 from the back office";

let acme: { id: string };
let scope: OrganisationScope;
let people: Record<Kind, Person>;
let owner: string;
let clientId: string;
let site: string;

beforeEach(async () => {
	await freshDatabase();
	const seeded = await seedRoles(captureEmail());
	acme = seeded.acme;
	people = seeded.people;
	owner = people.owner.user.id;
	scope = organisationScope(env.DB, acme.id);
	const [client] = await scope.clients.insert({ name: "Initech", nameKey: "initech" });
	if (!client) throw new Error("seed failed");
	clientId = client.id;
	const [project] = await scope.projects.insert({ name: "Site", nameKey: "site", clientId });
	if (!project) throw new Error("seed failed");
	site = project.id;
}, 60_000);

afterEach(() => {
	vi.restoreAllMocks();
});

interface Recorded {
	actor: string | null;
	source: string;
	subjectType: string;
	subjectId: string;
	owner: string | null;
	summary: { before?: Record<string, unknown>; after?: Record<string, unknown> };
}

/** The rows recording `action`, oldest first. */
async function records(action: string): Promise<Recorded[]> {
	const { results } = await env.DB.prepare(
		`select actor_id as actor, source, subject_type as subjectType, subject_id as subjectId,
		owner_id as owner, summary from activity_records where action = ? order by rowid`,
	)
		.bind(action)
		.all<Omit<Recorded, "summary"> & { summary: string }>();
	return results.map((r) => ({ ...r, summary: JSON.parse(r.summary) }));
}

/** The answer to a form the page posts by script. */
async function send(path: string, fields: Record<string, string>, who: Person) {
	const response = await submit(path, fields, who, { byScript: true });
	return response.status;
}

/** A draft of one £100.00 line for Initech, with no taxes. */
async function draft() {
	const made = await createDraft(scope, owner, {
		clientId,
		currency: "GBP",
		issuedOn: TODAY,
		taxIds: [null, null],
		lines: [
			{
				kind: "manual",
				description: "Design work",
				projectId: null,
				quantityMilli: 1000,
				unitPriceMinor: 10_000,
				amountMinor: 10_000,
				timeEntryIds: [],
				expenseIds: [],
			},
		],
	});
	if (!made.ok) throw new Error(made.problem);
	return made.id;
}

const SETS_RATES: Record<Kind, boolean> = {
	owner: true,
	admin: true,
	finance: true,
	manager: false,
	member: false,
};
const KEEPS_CATEGORIES: Record<Kind, boolean> = {
	owner: true,
	admin: true,
	finance: false,
	manager: false,
	member: false,
};

describe.each(KINDS)("the %s's money changes", (kind) => {
	const who = () => people[kind];

	it("a billable rate and a cost rate, set and changed, are each recorded once, as nobody's", async () => {
		const project = projectPath(ACME, site);
		const rate = { intent: "rate", level: "project", key: "", amount: "120", from: "2099-01-01" };
		expect(await send(project, rate, who())).toBe(SETS_RATES[kind] ? 200 : 403);
		const cost = {
			intent: "cost-rate",
			userId: people.member.user.id,
			amount: "25.00",
			effectiveFrom: "2026-10-01",
		};
		const costed = await send(PROFITABILITY, cost, who());
		if (!SETS_RATES[kind]) {
			expect(costed).not.toBe(200);
			expect(await value("select count(*) from activity_records where subject_type = 'rate'")).toBe(
				0,
			);
			return;
		}
		expect(costed).toBe(200);
		expect(await send(PROFITABILITY, { ...cost, amount: "30.00" }, who())).toBe(200);
		// The same again changes nothing, so records nothing.
		expect(await send(PROFITABILITY, { ...cost, amount: "30.00" }, who())).toBe(200);

		const created = await records("rate.created");
		expect(created).toHaveLength(2);
		expect(created[0]).toMatchObject({
			actor: who().user.id,
			source: "web",
			subjectType: "rate",
			owner: null,
			summary: { after: { projectId: site, amountMinor: 12_000, effectiveFrom: "2099-01-01" } },
		});
		// A cost rate is the organisation's, so a manager never reads it in their people's log.
		expect(created[1]).toMatchObject({
			actor: who().user.id,
			source: "web",
			subjectType: "rate",
			owner: null,
			summary: {
				after: {
					kind: "cost",
					userId: people.member.user.id,
					amountMinor: 2500,
					effectiveFrom: "2026-10-01",
				},
			},
		});
		const updated = await records("rate.updated");
		expect(updated).toHaveLength(1);
		expect(updated[0]).toMatchObject({
			actor: who().user.id,
			subjectId: created[1]?.subjectId,
			owner: null,
			summary: { before: { amountMinor: 2500 }, after: { amountMinor: 3000 } },
		});
	});

	it("a budget set and removed is recorded on the project's budget", async () => {
		const project = projectPath(ACME, site);
		const budget = (budgetKind: string, amount: string) =>
			send(project, { intent: "budget", budgetKind, amount, alertPercent: "" }, who());
		expect(await budget("total_hours", "10")).toBe(SETS_RATES[kind] ? 200 : 403);
		expect(await budget("none", "")).toBe(SETS_RATES[kind] ? 200 : 403);
		// No budget to remove: nothing changes, nothing is recorded.
		expect(await budget("none", "")).toBe(SETS_RATES[kind] ? 200 : 403);
		if (!SETS_RATES[kind]) {
			expect(
				await value("select count(*) from activity_records where subject_type = 'budget'"),
			).toBe(0);
			return;
		}
		const set = await records("budget.created");
		expect(set).toEqual([
			{
				actor: who().user.id,
				source: "web",
				subjectType: "budget",
				subjectId: site,
				owner: null,
				summary: {
					before: expect.objectContaining({ budgetKind: "none" }),
					after: expect.objectContaining({ budgetKind: "total_hours", budgetAmount: 600 }),
				},
			},
		]);
		const removed = await records("budget.deleted");
		expect(removed).toHaveLength(1);
		expect(removed[0]).toMatchObject({
			actor: who().user.id,
			subjectType: "budget",
			subjectId: site,
			summary: { before: { budgetKind: "total_hours" }, after: { budgetKind: "none" } },
		});
		expect(await records("budget.updated")).toEqual([]);
	});

	it("an expense category created, priced again, archived and restored is recorded each time", async () => {
		const added = await send(
			SETTINGS,
			{
				intent: "add-category",
				name: "Mileage",
				unitName: "mile",
				unitPrice: "0.45",
				from: "2026-11-01",
			},
			who(),
		);
		expect(added).toBe(KEEPS_CATEGORIES[kind] ? 200 : 404);
		if (!KEEPS_CATEGORIES[kind]) {
			expect(await value("select count(*) from expense_categories")).toBe(0);
			expect(
				await value(
					"select count(*) from activity_records where subject_type = 'expense_category'",
				),
			).toBe(0);
			return;
		}
		const id = (await value<string>("select id from expense_categories")) as string;
		const created = await records("expense_category.created");
		expect(created).toEqual([
			{
				actor: who().user.id,
				source: "web",
				subjectType: "expense_category",
				subjectId: id,
				owner: null,
				summary: {
					after: {
						name: "Mileage",
						unitName: "mile",
						unitPriceMinor: 45,
						effectiveFrom: "2026-11-01",
					},
				},
			},
		]);

		const change = {
			intent: "change-category",
			categoryId: id,
			name: "Mileage",
			unitName: "mile",
			unitPrice: "0.50",
			from: "2027-01-01",
		};
		expect(await send(SETTINGS, change, who())).toBe(200);
		// The same again: nothing differs, so nothing is recorded.
		expect(await send(SETTINGS, change, who())).toBe(200);
		const updated = await records("expense_category.updated");
		expect(updated).toHaveLength(1);
		expect(updated[0]).toMatchObject({
			actor: who().user.id,
			subjectId: id,
			summary: { after: { unitPriceMinor: 50, effectiveFrom: "2027-01-01" } },
		});

		for (const intent of ["archive-category", "archive-category", "restore-category"]) {
			expect(await send(SETTINGS, { intent, categoryId: id }, who())).toBe(200);
		}
		// Archiving one already archived changes nothing, and records nothing.
		expect(await records("expense_category.archived")).toMatchObject([
			{ actor: who().user.id, subjectType: "expense_category", subjectId: id, owner: null },
		]);
		expect(await records("expense_category.restored")).toMatchObject([
			{ actor: who().user.id, subjectType: "expense_category", subjectId: id, owner: null },
		]);
	});

	it("a payment recorded on an invoice's page is recorded as theirs, never with its note", async () => {
		const id = await draft();
		await issueInvoice(scope, owner, id);
		const paid = await send(
			`${INVOICES}/${id}`,
			{
				intent: "payment",
				kind: "payment",
				amount: "40.00",
				paidOn: TODAY,
				method: "card",
				note: TYPED,
			},
			who(),
		);
		if (SETS_RATES[kind]) expect(paid).toBeLessThan(400);
		else expect(paid).toBeGreaterThanOrEqual(400);
		const recorded = await records("payment.recorded");
		if (!SETS_RATES[kind]) {
			expect(recorded).toEqual([]);
			return;
		}
		expect(recorded).toEqual([
			{
				actor: who().user.id,
				source: "web",
				subjectType: "payment",
				subjectId: expect.any(String),
				owner: null,
				summary: { after: { invoice: "1", kind: "payment", amountMinor: 4000 } },
			},
		]);
		expect(await value("select count(*) from activity_records where summary like '%Cheque%'")).toBe(
			0,
		);
	});
});

describe("invoices", () => {
	it("a draft made is recorded as created", async () => {
		const id = await draft();
		expect(await records("invoice.created")).toEqual([
			{
				actor: owner,
				source: "web",
				subjectType: "invoice",
				subjectId: id,
				owner: null,
				summary: { after: { lines: 1, totalMinor: 10_000 } },
			},
		]);
		expect(
			await value("select count(*) from activity_records where summary like '%Design work%'"),
		).toBe(0);
	});

	it("issuing is recorded once; a second issue is refused and records nothing", async () => {
		const id = await draft();
		expect((await issueInvoice(scope, owner, id))?.ok).toBe(true);
		expect((await issueInvoice(scope, owner, id))?.ok).not.toBe(true);
		expect(await records("invoice.updated")).toEqual([
			{
				actor: owner,
				source: "web",
				subjectType: "invoice",
				subjectId: id,
				owner: null,
				summary: { before: { status: "draft" }, after: { status: "open", number: "1" } },
			},
		]);
	});

	it("voiding is recorded once; voiding a void one records nothing", async () => {
		const id = await draft();
		await issueInvoice(scope, owner, id);
		expect((await voidInvoice(scope, owner, id, NOW))?.ok).toBe(true);
		expect((await voidInvoice(scope, owner, id, NOW))?.ok).toBe(false);
		expect(await records("invoice.voided")).toEqual([
			{
				actor: owner,
				source: "web",
				subjectType: "invoice",
				subjectId: id,
				owner: null,
				summary: { before: { status: "sent" }, after: { status: "void" } },
			},
		]);
	});

	it("a payment and a write-off recorded, and a payment deleted, are each recorded", async () => {
		const id = await draft();
		await issueInvoice(scope, owner, id);
		const payment = {
			kind: "payment" as const,
			paidOn: TODAY,
			method: "card" as const,
			note: TYPED,
		};
		expect(
			(await recordPayment(scope, owner, id, { ...payment, amountMinor: 4000 }, TODAY))?.ok,
		).toBe(true);
		expect(
			(
				await recordPayment(
					scope,
					owner,
					id,
					{ ...payment, kind: "write_off", method: null, amountMinor: 500 },
					TODAY,
				)
			)?.ok,
		).toBe(true);
		const recorded = await records("payment.recorded");
		expect(recorded.map((r) => r.summary.after)).toEqual([
			{ invoice: "1", kind: "payment", amountMinor: 4000 },
			{ invoice: "1", kind: "write_off", amountMinor: 500 },
		]);
		const first = recorded[0]?.subjectId ?? "";
		expect((await deletePayment(scope, owner, id, first, TODAY))?.ok).toBe(true);
		expect(await records("payment.deleted")).toEqual([
			{
				actor: owner,
				source: "web",
				subjectType: "payment",
				subjectId: first,
				owner: null,
				summary: { before: { invoice: "1", kind: "payment", amountMinor: 4000 } },
			},
		]);
		expect(await value("select count(*) from activity_records where summary like '%Cheque%'")).toBe(
			0,
		);
	});

	it("sending by email records the send with the sent time, and the new billing contact on the client", async () => {
		const id = await draft();
		expect(
			await addContact(scope, owner, clientId, { name: null, email: "accounts@initech.example" }),
		).toBe(true);
		expect(await records("client.updated")).toEqual([
			{
				actor: owner,
				source: "web",
				subjectType: "client",
				subjectId: clientId,
				owner: null,
				summary: { after: { billingContact: "accounts@initech.example" } },
			},
		]);
		const sent = await sendInvoice(scope, owner, id, {
			organisationName: "Acme",
			to: ["accounts@initech.example"],
			locale: "en-GB",
			today: TODAY,
			now: NOW,
		});
		expect(sent).toEqual({ ok: true, number: "1" });
		expect(await records("invoice.sent")).toEqual([
			{
				actor: owner,
				source: "web",
				subjectType: "invoice",
				subjectId: id,
				owner: null,
				summary: { after: { recipients: 1, reminder: false } },
			},
		]);
		// Sending a draft issues it first: that is its own record.
		expect(await records("invoice.updated")).toHaveLength(1);
		const [invoice] = await scope.invoices.select();
		expect(invoice?.sentAt?.getTime()).toBe(NOW.getTime());
	});
});

describe("estimates", () => {
	it("created, sent from its page and accepted on the client's link: one record each", async () => {
		const made = await createEstimate(scope, owner, {
			clientId,
			currency: "GBP",
			issuedOn: TODAY,
			poNumber: null,
			subject: "Website",
			notes: null,
			discountBasisPoints: 0,
		});
		if (!made?.ok) throw new Error("no estimate");
		const id = made.id;
		await addEstimateLine(scope, owner, id, {
			description: "Design",
			quantityMilli: 1000,
			unitPriceMinor: 50_000,
			taxId: null,
			secondTaxId: null,
		});
		expect(await records("estimate.created")).toEqual([
			{
				actor: owner,
				source: "web",
				subjectType: "estimate",
				subjectId: id,
				owner: null,
				summary: {},
			},
		]);
		// A line added is recorded as a change, without its words.
		expect(await records("estimate.updated")).toMatchObject([
			{ summary: { after: { line: "added" } } },
		]);

		await addContact(scope, owner, clientId, { name: null, email: "accounts@initech.example" });
		expect(
			await send(
				`${ESTIMATES}/${id}`,
				{ intent: "send", to: "accounts@initech.example", note: "" },
				people.finance,
			),
		).toBe(200);
		expect(await records("estimate.sent")).toEqual([
			{
				actor: people.finance.user.id,
				source: "web",
				subjectType: "estimate",
				subjectId: id,
				owner: null,
				summary: { after: { recipients: 1, reminder: false } },
			},
		]);
		expect(await value("select status from estimates where id = ?", id)).toBe("sent");

		const link = estimateLinkPath(id, await estimateToken(id));
		await submit(link, { decision: "accepted" }, undefined, { byScript: true });
		await submit(link, { decision: "declined" }, undefined, { byScript: true });
		expect(await records("estimate.accepted")).toEqual([
			{
				actor: null,
				source: "system",
				subjectType: "estimate",
				subjectId: id,
				owner: null,
				summary: { after: { by: "client" } },
			},
		]);
		expect(await records("estimate.declined")).toEqual([]);
	});
});

describe("recurring invoices and retainers", () => {
	it("a recurring invoice set up, changed, given a line and stopped is recorded each time, stopping once", async () => {
		const made = await createRecurring(scope, owner, {
			clientId,
			frequency: "monthly",
			startsOn: "2030-01-01",
			endsOn: null,
			sendAutomatically: false,
			includeUninvoicedTime: false,
			currency: "GBP",
			paymentTermsDays: 30,
			subject: null,
			notes: null,
		});
		if (!made?.ok) throw new Error("not made");
		const id = made.id;
		expect(await records("recurring_invoice.created")).toEqual([
			{
				actor: owner,
				source: "web",
				subjectType: "recurring_invoice",
				subjectId: id,
				owner: null,
				summary: { after: { frequency: "monthly", startsOn: "2030-01-01" } },
			},
		]);
		expect(
			await changeRecurring(
				scope,
				owner,
				id,
				{
					frequency: "monthly",
					nextIssueOn: "2030-01-01",
					endsOn: null,
					sendAutomatically: false,
					includeUninvoicedTime: false,
					paymentTermsDays: 14,
					subject: "Hosting for Initech",
					notes: null,
				},
				NOW,
			),
		).toBe(true);
		await addRecurringLine(scope, owner, id, {
			description: "Hosting",
			quantityMilli: 1000,
			unitPriceMinor: 2000,
			taxId: null,
			secondTaxId: null,
		});
		expect((await records("recurring_invoice.updated")).map((r) => r.summary)).toEqual([
			{ before: { paymentTermsDays: 30 }, after: { paymentTermsDays: 14, subject: "changed" } },
			{ after: { line: "added" } },
		]);
		expect(await stopRecurring(scope, owner, id, NOW)).not.toBeNull();
		expect(await stopRecurring(scope, owner, id, NOW)).toBeNull();
		expect(await records("recurring_invoice.stopped")).toMatchObject([
			{ actor: owner, subjectType: "recurring_invoice", subjectId: id },
		]);
		expect(
			await value("select count(*) from activity_records where summary like '%Hosting%'"),
		).toBe(0);
	});

	it("a retainer opened is recorded", async () => {
		const opened = await openRetainer(scope, owner, clientId, null, "GBP");
		if (!opened?.ok) throw new Error("not opened");
		expect(await records("retainer.created")).toEqual([
			{
				actor: owner,
				source: "web",
				subjectType: "retainer",
				subjectId: opened.id,
				owner: null,
				summary: { after: { clientId, projectId: null, currency: "GBP" } },
			},
		]);
	});
});
