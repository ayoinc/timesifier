import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OrganisationScope, organisationScope } from "~/db";
import {
	addEstimateLine,
	createEstimate,
	decideByClient,
	estimateLinesOf,
	estimateToken,
	findEstimate,
	invoiceEstimate,
	isEstimateToken,
	markEstimateSent,
	recordDecision,
	revertDecision,
} from "~/estimates/estimates.server";
import { taxesOf, totalsOf } from "~/invoices/documents.server";
import type { LineInput } from "~/invoices/invoices.server";
import { createDraft, findInvoice, linesOf } from "~/invoices/invoices.server";
import { estimateLinkPath } from "~/invoices/paths";
import { addTax } from "~/invoices/settings.server";
import { lineAmount } from "~/money/money";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, value } from "../organisations/harness";
import { open, type Person, person, submit, textOf } from "../pages/harness";

// Estimates (TS-077): priced with the invoice's arithmetic, answered once by
// the client on a link only this deployment can make, recorded or taken back
// by staff, and turned into a draft invoice with the same lines.

const TODAY = "2026-11-02";
const NOW = new Date("2026-11-02T12:00:00Z");

let mailbox: Mailbox;
let scope: OrganisationScope;
let owner: Person;
let clientId: string;
let vat: string;
let levy: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	owner = await person(mailbox, "ada@example.com");
	const acme = await createOrganisation(owner.cookie, "Acme");
	scope = organisationScope(env.DB, acme.id);
	const [client] = await scope.clients.insert({ name: "Initech", nameKey: "initech" });
	if (!client) throw new Error("seed failed");
	clientId = client.id;
	const addedVat = await addTax(scope, { name: "VAT", rateBasisPoints: 2000, compound: false });
	const addedLevy = await addTax(scope, { name: "Levy", rateBasisPoints: 250, compound: true });
	if (!addedVat?.ok || !addedLevy?.ok) throw new Error("seed failed");
	vat = addedVat.id;
	levy = addedLevy.id;
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** An estimate with Design (2.5 × £400.00, VAT and Levy) and Hosting (3 × £33.33, VAT only), 10% off. */
async function estimate() {
	const made = await createEstimate(scope, owner.user.id, {
		clientId,
		currency: "GBP",
		issuedOn: TODAY,
		poNumber: "PO-9",
		subject: "Website",
		notes: "Valid for 30 days.",
		discountBasisPoints: 1000,
	});
	if (!made) throw new Error("no estimate");
	if (!made.ok) throw new Error(made.problem);
	const lines: LineInput[] = [
		{
			description: "Design",
			quantityMilli: 2500,
			unitPriceMinor: 40_000,
			taxId: vat,
			secondTaxId: levy,
		},
		{
			description: "Hosting",
			quantityMilli: 3000,
			unitPriceMinor: 3333,
			taxId: vat,
			secondTaxId: null,
		},
	];
	for (const line of lines) {
		expect((await addEstimateLine(scope, owner.user.id, made.id, line))?.ok).toBe(true);
	}
	return made.id;
}

async function stored(id: string) {
	const row = await findEstimate(scope, id);
	if (!row) throw new Error("no such estimate");
	return row;
}

const decisions = (id: string) =>
	value(
		"select count(*) from activity_records where subject_id = ? and action in ('estimate.accepted', 'estimate.declined')",
		id,
	);

describe("creating an estimate", () => {
	it("prices it with the invoice's arithmetic", async () => {
		const id = await estimate();
		const row = await stored(id);
		expect(row.number).toBe("1");
		expect(row.status).toBe("draft");
		const lines = await estimateLinesOf(scope, id);
		expect(lines.map((l) => l.amountMinor)).toEqual([100_000, 9999]);
		expect(lines.map((l) => l.amountMinor)).toEqual(
			lines.map((l) => lineAmount(l.quantityMilli, l.unitPriceMinor)),
		);
		const totals = totalsOf(lines, 1000, await taxesOf(scope));
		expect([row.subtotalMinor, row.discountMinor, row.taxMinor, row.totalMinor]).toEqual([
			totals.subtotalMinor,
			totals.discountMinor,
			totals.taxMinor,
			totals.totalMinor,
		]);
		// Design £1,000.00; Hosting £99.99; subtotal £1,099.99. 10% off is £110.00
		// (£109.999 half up). VAT is 20% of each line's discounted amount: of
		// £900.00 and £89.991, £197.9982 → £198.00. The Levy is 2.5% of Design's
		// £900.00 plus its £180.00 VAT: £27.00. Total £989.99 + £225.00.
		expect([row.subtotalMinor, row.discountMinor, row.taxMinor, row.totalMinor]).toEqual([
			109_999, 11_000, 22_500, 121_499,
		]);
		expect(totals.taxes).toEqual([
			{ id: vat, amountMinor: 19_800 },
			{ id: levy, amountMinor: 2700 },
		]);

		// An invoice of the same lines comes to the same numbers.
		const invoice = await createDraft(scope, owner.user.id, {
			clientId,
			currency: "GBP",
			issuedOn: TODAY,
			discountBasisPoints: 1000,
			lines: lines.map((l) => ({
				kind: "manual",
				description: l.description,
				projectId: null,
				quantityMilli: l.quantityMilli,
				unitPriceMinor: l.unitPriceMinor,
				amountMinor: l.amountMinor,
				timeEntryIds: [],
				expenseIds: [],
			})),
			lineTaxes: lines.map((l) => [l.taxId, l.secondTaxId]),
		});
		if (!invoice.ok) throw new Error(invoice.problem);
		const billed = await findInvoice(scope, invoice.id);
		expect([
			billed?.subtotalMinor,
			billed?.discountMinor,
			billed?.taxMinor,
			billed?.totalMinor,
		]).toEqual([row.subtotalMinor, row.discountMinor, row.taxMinor, row.totalMinor]);

		expect((await stored(await estimate())).number).toBe("2");
	});
});

describe("the client's link", () => {
	it("is proved by its token alone, and declines anything else as not found", async () => {
		const id = await estimate();
		const other = await estimate();
		const token = await estimateToken(id);
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(await isEstimateToken(id, token)).toBe(true);
		expect(await isEstimateToken(other, token)).toBe(false);
		expect(
			await isEstimateToken(
				id,
				token.replace(/.$/, (c) => (c === "0" ? "1" : "0")),
			),
		).toBe(false);
		expect(await isEstimateToken(id, token.toUpperCase())).toBe(false);
		expect(await isEstimateToken(id, "")).toBe(false);

		const page = await open(estimateLinkPath(id, token));
		expect(page.status).toBe(200);
		const text = textOf(await page.text());
		expect(text).toContain("Estimate 1");
		expect(text).toContain("From Acme");

		for (const wrong of [
			estimateLinkPath(other, token),
			estimateLinkPath(id, "0".repeat(64)),
			estimateLinkPath("missing", token),
		]) {
			expect((await open(wrong)).status, wrong).toBe(404);
			expect(
				(await submit(wrong, { decision: "accepted" }, undefined, { byScript: true })).status,
				wrong,
			).toBe(404);
		}
		expect((await stored(id)).status).toBe("draft");
	});

	it("records the client's answer once; a second click changes nothing", async () => {
		const id = await estimate();
		const link = estimateLinkPath(id, await estimateToken(id));

		// Not sent yet: there is nothing to answer.
		await submit(link, { decision: "accepted" }, undefined, { byScript: true });
		expect((await stored(id)).status).toBe("draft");
		expect(await decisions(id)).toBe(0);

		await markEstimateSent(scope, id, NOW);
		expect((await stored(id)).status).toBe("sent");
		const first = await submit(link, { decision: "accepted" }, undefined, { byScript: true });
		expect(first.status).toBe(200);
		expect(await first.text()).toContain("Thank you. The estimate is accepted.");
		const accepted = await stored(id);
		expect(accepted.status).toBe("accepted");
		expect(accepted.decidedAt).not.toBeNull();
		expect(await decisions(id)).toBe(1);

		for (const decision of ["declined", "accepted"]) {
			const again = await submit(link, { decision }, undefined, { byScript: true });
			expect(await again.text()).toContain("This estimate is accepted already");
		}
		const after = await stored(id);
		expect(after.status).toBe("accepted");
		expect(after.decidedAt?.getTime()).toBe(accepted.decidedAt?.getTime());
		expect(await decisions(id)).toBe(1);

		// The same, straight to the function, for a decline.
		const declined = await estimate();
		await markEstimateSent(scope, declined, NOW);
		expect(await decideByClient(scope, declined, "declined", NOW)).toEqual({
			recorded: true,
			status: "declined",
			decidedAt: NOW,
		});
		expect(
			await decideByClient(scope, declined, "accepted", new Date(NOW.getTime() + 1000)),
		).toEqual({
			recorded: false,
			status: "declined",
			decidedAt: NOW,
		});
		expect(await decisions(declined)).toBe(1);
	});
});

describe("staff", () => {
	it("record a decision for the client and take it back", async () => {
		const id = await estimate();
		expect(await recordDecision(scope, owner.user.id, id, "declined", NOW)).toEqual({
			ok: true,
			id,
		});
		expect((await stored(id)).status).toBe("declined");
		expect((await recordDecision(scope, owner.user.id, id, "accepted", NOW))?.ok).toBe(false);
		expect((await stored(id)).status).toBe("declined");

		expect(await revertDecision(scope, owner.user.id, id)).toEqual({ ok: true, id });
		const reverted = await stored(id);
		expect(reverted.status).toBe("sent");
		expect(reverted.decidedAt).toBeNull();
		expect(await revertDecision(scope, owner.user.id, id)).toEqual({
			ok: false,
			problem: "That estimate has not been decided.",
		});

		// Through the page, as Finance or an owner does it.
		const page = `/app/acme/estimates/${id}`;
		await submit(page, { intent: "decide", decision: "accepted" }, owner, { byScript: true });
		expect((await stored(id)).status).toBe("accepted");
		await submit(page, { intent: "revert" }, owner, { byScript: true });
		expect((await stored(id)).status).toBe("sent");

		// Reverted, the client's link answers again.
		expect((await decideByClient(scope, id, "accepted", NOW))?.recorded).toBe(true);
	});
});

describe("an accepted estimate", () => {
	it("becomes a draft invoice with the same lines, once", async () => {
		const id = await estimate();
		expect(await invoiceEstimate(scope, owner.user.id, id, TODAY)).toEqual({
			ok: false,
			problem: "Only an accepted estimate becomes an invoice.",
		});
		await recordDecision(scope, owner.user.id, id, "accepted", NOW);
		const made = await invoiceEstimate(scope, owner.user.id, id, TODAY);
		if (!made?.ok) throw new Error("not invoiced");

		const row = await stored(id);
		expect(row.invoiceId).toBe(made.id);
		const invoice = await findInvoice(scope, made.id);
		expect(invoice).toMatchObject({
			status: "draft",
			clientId,
			currency: "GBP",
			issuedOn: TODAY,
			poNumber: "PO-9",
			subject: "Website",
			notes: "Valid for 30 days.",
			discountBasisPoints: 1000,
			estimateId: id,
			subtotalMinor: row.subtotalMinor,
			discountMinor: row.discountMinor,
			taxMinor: row.taxMinor,
			totalMinor: row.totalMinor,
		});
		const shape = (l: {
			description: string;
			quantityMilli: number;
			unitPriceMinor: number;
			amountMinor: number;
			taxId: string | null;
			secondTaxId: string | null;
		}) => [l.description, l.quantityMilli, l.unitPriceMinor, l.amountMinor, l.taxId, l.secondTaxId];
		expect((await linesOf(scope, made.id)).map(shape)).toEqual(
			(await estimateLinesOf(scope, id)).map(shape),
		);

		expect(await invoiceEstimate(scope, owner.user.id, id, TODAY)).toEqual({
			ok: false,
			problem: "That estimate is an invoice already.",
		});
		expect(await revertDecision(scope, owner.user.id, id)).toEqual({
			ok: false,
			problem: "That estimate has become an invoice. Delete the draft first.",
		});
		expect(await value("select count(*) from invoices")).toBe(1);
	});
});
