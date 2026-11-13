import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OrganisationScope, organisationScope } from "~/db";
import { taxesOf, totalsOf } from "~/invoices/documents.server";
import {
	createDraft,
	deleteDraft,
	deleteLine,
	deletePayment,
	issueInvoice,
	linesOf,
	MORE_THAN_OWED,
	recordPayment,
	voidInvoice,
} from "~/invoices/invoices.server";
import type { DraftLine } from "~/invoices/lines";
import { invoiceTotals, percentOf } from "~/money/money";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, seedMembership, seedTeam, value } from "../organisations/harness";
import { open, openData, type Person, person, submit } from "../pages/harness";

// Invoices (TS-073, TS-074) through the Worker and the server functions the
// pages call: who may reach them, the numbering, what an invoice locks and
// lets go of, the totals against app/money, payments and the status.

const INVOICES = "/app/acme/invoices";
const TODAY = "2026-11-02";

let mailbox: Mailbox;
let scope: OrganisationScope;
let owner: Person;
let clientId: string;
let projectId: string;

/** A seeded generator (mulberry32), so a failing case can be run again. */
function random(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	owner = await person(mailbox, "ada@example.com");
	const acme = await createOrganisation(owner.cookie, "Acme");
	scope = organisationScope(env.DB, acme.id);
	const [client] = await scope.clients.insert({ name: "Initech", nameKey: "initech" });
	const [project] = await scope.projects.insert({
		name: "Site",
		nameKey: "site",
		clientId: client?.id ?? null,
	});
	if (!client || !project) throw new Error("seed failed");
	clientId = client.id;
	projectId = project.id;
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function entry(hour: number) {
	const [row] = await scope.timeEntries.insert({
		userId: owner.user.id,
		projectId,
		description: "Work",
		billable: true,
		startedAt: new Date(`2026-10-05T${String(hour).padStart(2, "0")}:00:00Z`),
		spentOn: "2026-10-05",
		endedAt: new Date(`2026-10-05T${String(hour + 1).padStart(2, "0")}:00:00Z`),
	});
	if (!row) throw new Error("seed failed");
	return row.id;
}

function timeLine(entryIds: string[], amountMinor = 10_000): DraftLine {
	return {
		kind: "time",
		description: "Design",
		projectId,
		quantityMilli: entryIds.length * 1000,
		unitPriceMinor: amountMinor / Math.max(entryIds.length, 1),
		amountMinor,
		timeEntryIds: entryIds,
		expenseIds: [],
	};
}

const manual = (amountMinor: number): DraftLine => ({
	kind: "manual",
	description: "Extra",
	projectId: null,
	quantityMilli: 1000,
	unitPriceMinor: amountMinor,
	amountMinor,
	timeEntryIds: [],
	expenseIds: [],
});

async function draft(lines: DraftLine[]) {
	const made = await createDraft(scope, owner.user.id, {
		clientId,
		currency: "GBP",
		issuedOn: TODAY,
		lines,
	});
	if (!made.ok) throw new Error(made.problem);
	return made.id;
}

describe("who reaches Invoices", () => {
	it("owners, admins and Finance can; a manager and a member get 404", async () => {
		const acmeId = scope.organisationId;
		const admin = await person(mailbox, "grace@example.com");
		const finance = await person(mailbox, "katherine@example.com");
		const manager = await person(mailbox, "hedy@example.com");
		const member = await person(mailbox, "linus@example.com");
		await seedMembership(acmeId, admin.user.id, "admin");
		await seedMembership(acmeId, finance.user.id, "finance");
		await seedMembership(acmeId, manager.user.id, "member");
		await seedMembership(acmeId, member.user.id, "member");
		await seedTeam(acmeId, "Design", { members: [member.user.id], managers: [manager.user.id] });
		const id = await draft([manual(5000)]);

		for (const who of [owner, admin, finance]) {
			for (const address of [INVOICES, `${INVOICES}/new`, `${INVOICES}/${id}`]) {
				expect((await open(address, who)).status, address).toBe(200);
				expect((await openData(address, who)).status, address).toBe(200);
			}
		}
		for (const who of [manager, member]) {
			for (const address of [INVOICES, `${INVOICES}/new`, `${INVOICES}/${id}`]) {
				expect((await open(address, who)).status, address).toBe(404);
			}
			const posted = await submit(`${INVOICES}/${id}`, { intent: "delete" }, who, {
				byScript: true,
			});
			expect(posted.status).toBe(404);
		}
		expect(await value("select count(*) from invoices")).toBe(1);
	});

	it("is 404 for another organisation's invoice", async () => {
		const id = await draft([manual(5000)]);
		const grace = await person(mailbox, "grace@example.com");
		await createOrganisation(grace.cookie, "Initech");
		const theirs = await open(`/app/initech/invoices/${id}`, grace);
		expect(theirs.status).toBe(404);
		expect((await open(`/app/initech/invoices/${id}/pdf`, grace)).status).toBe(404);
	});
});

describe("numbering", () => {
	it("never repeats under concurrent saves, and a deleted draft's number is not given again", async () => {
		const ids = await Promise.all(Array.from({ length: 8 }, () => draft([manual(100)])));
		const numbers = await Promise.all(
			ids.map((id) => value<string>("select number from invoices where id = ?", id)),
		);
		expect(new Set(numbers).size).toBe(8);
		expect([...numbers].map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

		const last = ids[numbers.indexOf("8")] as string;
		expect((await deleteDraft(scope, owner.user.id, last))?.ok).toBe(true);
		const next = await draft([manual(100)]);
		expect(await value("select number from invoices where id = ?", next)).toBe("9");
	});
});

describe("billed time", () => {
	it("is locked while on an invoice and let go by deleting the line, the draft or voiding", async () => {
		const a = await entry(9);
		const b = await entry(11);
		const id = await draft([timeLine([a, b])]);
		const change = () =>
			env.DB.prepare("update time_entries set description = 'changed' where id = ?").bind(a).run();
		await expect(change()).rejects.toThrow(/invoiced entry does not change/);
		// Every entry has its day (migration 0021, TS-111), so an invoiced
		// entry's day does not change either, and no entry's may be emptied.
		const day = (entryId: string, spentOn: string) =>
			env.DB.prepare("update time_entries set spent_on = ? where id = ?")
				.bind(spentOn, entryId)
				.run();
		await expect(day(a, "2026-11-03")).rejects.toThrow(/invoiced entry does not change/);
		const unbilled = await entry(13);
		await expect(day(unbilled, "")).rejects.toThrow(/an entry has the date of its day/);
		await expect(day(unbilled, "2026-02-30")).rejects.toThrow(/an entry has the date of its day/);

		// The same time on a second invoice is refused.
		const again = await createDraft(scope, owner.user.id, {
			clientId,
			currency: "GBP",
			issuedOn: TODAY,
			lines: [timeLine([a])],
		});
		expect(again.ok).toBe(false);

		const [line] = await linesOf(scope, id);
		expect((await deleteLine(scope, owner.user.id, id, line?.id ?? ""))?.ok).toBe(true);
		await change();

		const second = await draft([timeLine([a, b])]);
		await expect(change()).rejects.toThrow();
		expect((await deleteDraft(scope, owner.user.id, second))?.ok).toBe(true);
		await change();

		const third = await draft([timeLine([a, b])]);
		expect((await issueInvoice(scope, owner.user.id, third))?.ok).toBe(true);
		await expect(change()).rejects.toThrow();
		expect((await voidInvoice(scope, owner.user.id, third, new Date()))?.ok).toBe(true);
		await change();
		expect(await value("select status from invoices where id = ?", third)).toBe("void");
	});

	it("an issued invoice's lines do not change", async () => {
		const id = await draft([manual(1000)]);
		await issueInvoice(scope, owner.user.id, id);
		await expect(
			env.DB.prepare("update invoice_lines set amount_minor = 1 where invoice_id = ?")
				.bind(id)
				.run(),
		).rejects.toThrow(/lines do not change/);
	});
});

describe("totals", () => {
	it("property: stored totals are app/money's, subtotal − discount + tax = total", async () => {
		const [vat] = await scope.taxes.insert({ name: "VAT", rateBasisPoints: 2000, compound: false });
		const [levy] = await scope.taxes.insert({ name: "Levy", rateBasisPoints: 350, compound: true });
		if (!vat || !levy) throw new Error("seed failed");
		const taxes = await taxesOf(scope);
		const next = random(7);
		for (let run = 0; run < 25; run++) {
			const lines = Array.from({ length: 1 + Math.floor(next() * 4) }, () =>
				manual(Math.floor(next() * 1_000_000)),
			);
			const discountBasisPoints = Math.floor(next() * 3000);
			const made = await createDraft(scope, owner.user.id, {
				clientId,
				currency: "GBP",
				issuedOn: TODAY,
				lines,
				discountBasisPoints,
				taxIds: [vat.id, levy.id],
			});
			if (!made.ok) throw new Error(made.problem);
			const stored = await scope.invoices.select();
			const row = stored.find((i) => i.id === made.id);
			const expected = invoiceTotals({
				lines: lines.map((l) => ({ amountMinor: l.amountMinor, taxIds: [vat.id, levy.id] })),
				discountBasisPoints,
				taxes: [
					{ id: vat.id, basisPoints: 2000, compound: false },
					{ id: levy.id, basisPoints: 350, compound: true },
				],
			});
			expect(row?.subtotalMinor).toBe(expected.subtotalMinor);
			expect(row?.discountMinor).toBe(expected.discountMinor);
			expect(row?.taxMinor).toBe(expected.taxMinor);
			expect(row?.totalMinor).toBe(expected.totalMinor);
			expect(expected.subtotalMinor - expected.discountMinor + expected.taxMinor).toBe(
				expected.totalMinor,
			);
			expect(expected.discountMinor).toBe(percentOf(expected.subtotalMinor, discountBasisPoints));
			expect(
				totalsOf(
					lines.map((l) => ({ amountMinor: l.amountMinor, taxId: vat.id, secondTaxId: levy.id })),
					discountBasisPoints,
					taxes,
				),
			).toEqual(expected);
		}
	});
});

describe("payments and status", () => {
	it("moves sent → partly paid → paid, refuses more than owed, and goes back when a payment is deleted", async () => {
		const id = await draft([manual(10_000)]);
		expect(await value("select status from invoices where id = ?", id)).toBe("draft");
		await issueInvoice(scope, owner.user.id, id);
		expect(await value("select status from invoices where id = ?", id)).toBe("sent");

		const pay = (amountMinor: number, kind: "payment" | "write_off" = "payment") =>
			recordPayment(
				scope,
				owner.user.id,
				id,
				{ kind, amountMinor, paidOn: TODAY, method: "bank_transfer", note: null },
				TODAY,
			);
		expect((await pay(4000))?.ok).toBe(true);
		expect(await value("select status from invoices where id = ?", id)).toBe("partially_paid");
		expect(await pay(7000)).toEqual({ ok: false, problem: MORE_THAN_OWED });
		expect((await pay(6000, "write_off"))?.ok).toBe(true);
		expect(await value("select status from invoices where id = ?", id)).toBe("paid");

		const paymentId = await value<string>(
			"select id from payments where invoice_id = ? and kind = 'write_off'",
			id,
		);
		expect((await deletePayment(scope, owner.user.id, id, paymentId ?? "", TODAY))?.ok).toBe(true);
		expect(await value("select status from invoices where id = ?", id)).toBe("partially_paid");

		// An invoice with a payment is not voided.
		expect((await voidInvoice(scope, owner.user.id, id, new Date()))?.ok).toBe(false);
	});

	it("records a payment from the invoice page's form", async () => {
		const id = await draft([manual(10_000)]);
		await issueInvoice(scope, owner.user.id, id);
		const response = await submit(
			`${INVOICES}/${id}`,
			{ intent: "payment", kind: "payment", amount: "100.00", paidOn: TODAY, method: "card" },
			owner,
			{ byScript: true },
		);
		expect(response.status).toBeLessThan(400);
		expect(await value("select status from invoices where id = ?", id)).toBe("paid");
	});
});

describe("the PDF", () => {
	it("is a PDF with the invoice's number in its name", async () => {
		const id = await draft([manual(12_345)]);
		const response = await open(`${INVOICES}/${id}/pdf`, owner);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("application/pdf");
		expect(response.headers.get("Content-Disposition")).toContain("1");
		const bytes = new Uint8Array(await response.arrayBuffer());
		expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
	});
});
