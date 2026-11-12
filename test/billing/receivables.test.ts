import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OrganisationScope, organisationScope, uuidv7 } from "~/db";
import { billingCsvCells, billingReportOf } from "~/invoices/billing-reports.server";
import {
	createDraft,
	deletePayment,
	issueInvoice,
	MORE_THAN_OWED,
	recordPayment,
	settledOf,
	voidInvoice,
} from "~/invoices/invoices.server";
import { receivablesOf } from "~/invoices/receivables.server";
import { settledStatus } from "~/invoices/status";
import { invoiceView } from "~/invoices/view.server";
import { dayOf } from "~/time/calendar";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, value } from "../organisations/harness";
import { type Person, person } from "../pages/harness";

// What clients owe (TS-074): receivables by how overdue they are in the
// organisation's time zone, and the balance an invoice's payments and
// write-offs leave, which is never below 0.

/** Noon in London on 1 November 2026: already 2 November in Auckland. */
const NOW = Date.parse("2026-11-01T12:00:00Z");

let mailbox: Mailbox;
let scope: OrganisationScope;
let owner: Person;
let organisationId: string;
let clientId: string;

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
	organisationId = acme.id;
	scope = organisationScope(env.DB, acme.id);
	const [client] = await scope.clients.insert({ name: "Initech", nameKey: "initech" });
	if (!client) throw new Error("seed failed");
	clientId = client.id;
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** An issued invoice of one line for `amountMinor`, due on `dueOn`. */
async function issued(amountMinor: number, dueOn: string, currency = "GBP") {
	const made = await createDraft(scope, owner.user.id, {
		clientId,
		currency,
		issuedOn: dueOn,
		paymentTermsDays: 0,
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
	expect((await issueInvoice(scope, owner.user.id, made.id))?.ok).toBe(true);
	return made.id;
}

function pay(id: string, amountMinor: number, kind: "payment" | "write_off" = "payment") {
	return recordPayment(
		scope,
		owner.user.id,
		id,
		{
			kind,
			amountMinor,
			paidOn: "2026-10-31",
			method: kind === "payment" ? "bank_transfer" : null,
			note: null,
		},
		"2026-10-31",
	);
}

describe("receivables by age", () => {
	it("buckets what is owed as current, 1–30, 31–60, 61–90 and 90+ days overdue on the organisation's day", async () => {
		await env.DB.prepare("update organisations set time_zone = 'Pacific/Auckland' where id = ?")
			.bind(organisationId)
			.run();
		const zone = await value<string>(
			"select time_zone from organisations where id = ?",
			organisationId,
		);
		const today = dayOf(NOW, zone ?? "UTC");
		expect(today).toBe("2026-11-02");
		expect(dayOf(NOW, "UTC")).toBe("2026-11-01");

		await issued(1000, "2026-11-02"); // due today: current
		const yesterday = await issued(2000, "2026-11-01"); // 1 day late in Auckland, not yet in London
		await issued(3000, "2026-10-03"); // 30
		await issued(4000, "2026-10-02"); // 31
		await issued(5000, "2026-09-03"); // 60
		await issued(6000, "2026-09-02"); // 61
		await issued(7000, "2026-08-04"); // 90
		await issued(8000, "2026-08-03"); // 91
		const partly = await issued(9000, "2026-07-01");
		expect((await pay(partly, 4000))?.ok).toBe(true);
		const paid = await issued(10_000, "2026-07-01");
		expect((await pay(paid, 6000))?.ok).toBe(true);
		expect((await pay(paid, 4000, "write_off"))?.ok).toBe(true);
		const voided = await issued(11_000, "2026-07-01");
		await voidInvoice(scope, owner.user.id, voided, new Date(NOW));
		await createDraft(scope, owner.user.id, {
			clientId,
			currency: "GBP",
			issuedOn: "2026-07-01",
			paymentTermsDays: 0,
			lines: [
				{
					kind: "manual",
					description: "Draft",
					projectId: null,
					quantityMilli: 1000,
					unitPriceMinor: 12_000,
					amountMinor: 12_000,
					timeEntryIds: [],
					expenseIds: [],
				},
			],
		});
		await issued(13_000, "2026-10-20", "USD");

		const report = await billingReportOf(
			scope,
			"receivables",
			{ first: "2026-11-01", last: "2026-11-30" },
			today,
		);
		expect(report.aged).toEqual([
			{
				currency: "GBP",
				byAge: { current: 1000, "1-30": 5000, "31-60": 9000, "61-90": 13_000, "90+": 13_000 },
				totalMinor: 41_000,
			},
			{
				currency: "USD",
				byAge: { current: 0, "1-30": 13_000, "31-60": 0, "61-90": 0, "90+": 0 },
				totalMinor: 13_000,
			},
		]);
		expect(report.totals).toEqual([
			{ currency: "GBP", amountMinor: 41_000 },
			{ currency: "USD", amountMinor: 13_000 },
		]);
		const row = report.rows.find((r) => r.invoiceId === yesterday);
		expect(row && billingCsvCells("receivables", row)).toEqual([
			"2",
			"Initech",
			"2026-11-01",
			"1–30 days overdue",
			"GBP",
			"20.00",
		]);
		expect(await receivablesOf(scope, today)).toEqual([
			{ currency: "GBP", outstandingMinor: 41_000, overdueMinor: 40_000 },
			{ currency: "USD", outstandingMinor: 13_000, overdueMinor: 13_000 },
		]);

		// On London's day the invoice due yesterday in Auckland is not late yet.
		const london = await billingReportOf(
			scope,
			"receivables",
			{ first: "2026-11-01", last: "2026-11-30" },
			dayOf(NOW, "UTC"),
		);
		expect(london.rows.find((r) => r.invoiceId === yesterday)?.age).toBe("current");
	});
});

describe("balance", () => {
	it("property: balance = total − payments − write-offs ≥ 0 over random payments, write-offs and deletions", async () => {
		const next = random(2026);
		for (let run = 0; run < 8; run++) {
			const total = 1 + Math.floor(next() * 500_000);
			const id = await issued(total, "2026-10-01");
			const recorded: { id: string; kind: "payment" | "write_off"; amountMinor: number }[] = [];
			for (let step = 0; step < 12; step++) {
				const label = `run ${run}, step ${step}`;
				const paidMinor = recorded
					.filter((p) => p.kind === "payment")
					.reduce((sum, p) => sum + p.amountMinor, 0);
				const writtenOffMinor = recorded
					.filter((p) => p.kind === "write_off")
					.reduce((sum, p) => sum + p.amountMinor, 0);
				const balance = total - paidMinor - writtenOffMinor;

				if (recorded.length > 0 && next() < 0.3) {
					const [gone] = recorded.splice(Math.floor(next() * recorded.length), 1);
					if (!gone) throw new Error("nothing to delete");
					const deleted = await deletePayment(scope, owner.user.id, id, gone.id, "2026-10-31");
					expect(deleted?.ok, label).toBe(true);
				} else {
					const kind = next() < 0.7 ? "payment" : "write_off";
					const amountMinor = 1 + Math.floor(next() * balance * 1.3);
					const result = await pay(id, amountMinor, kind);
					if (balance === 0) {
						expect(result, label).toEqual({
							ok: false,
							problem: "Nothing is owed on that invoice.",
						});
					} else if (amountMinor > balance) {
						expect(result, label).toEqual({ ok: false, problem: MORE_THAN_OWED });
					} else {
						expect(result?.ok, label).toBe(true);
						const known = new Set(recorded.map((p) => p.id));
						const [added] = (await scope.payments.select()).filter(
							(p) => p.invoiceId === id && !known.has(p.id),
						);
						if (!added) throw new Error("payment not stored");
						recorded.push({ id: added.id, kind, amountMinor });
					}
				}

				const settled = {
					paidMinor: recorded
						.filter((p) => p.kind === "payment")
						.reduce((s, p) => s + p.amountMinor, 0),
					writtenOffMinor: recorded
						.filter((p) => p.kind === "write_off")
						.reduce((s, p) => s + p.amountMinor, 0),
				};
				const view = await invoiceView(scope, "Acme", id, { locale: "en-GB", today: "2026-10-31" });
				expect(view?.settled, label).toEqual(settled);
				expect(
					(await settledOf(scope, [id])).get(id) ?? { paidMinor: 0, writtenOffMinor: 0 },
					label,
				).toEqual(settled);
				expect(view?.balanceMinor, label).toBe(total - settled.paidMinor - settled.writtenOffMinor);
				expect(view?.balanceMinor, label).toBeGreaterThanOrEqual(0);
				expect(view?.invoice.status, label).toBe(settledStatus(total, settled));
				const state =
					view?.balanceMinor === 0
						? settled.writtenOffMinor > 0
							? "written-off"
							: "paid"
						: "overdue";
				expect(view?.state, label).toBe(state);
			}
		}
	});

	it("the database refuses a payment beyond the balance, whoever writes it", async () => {
		const id = await issued(10_000, "2026-10-01");
		expect((await pay(id, 7000))?.ok).toBe(true);
		await expect(
			env.DB.prepare(
				"insert into payments (id, organisation_id, invoice_id, kind, amount_minor, paid_on, method, recorded_by, created_at) values (?, ?, ?, 'write_off', 3001, '2026-10-31', null, ?, ?)",
			)
				.bind(uuidv7(), organisationId, id, owner.user.id, NOW)
				.run(),
		).rejects.toThrow(/a payment is at most/);
		expect((await pay(id, 3000, "write_off"))?.ok).toBe(true);
		expect(await value("select status from invoices where id = ?", id)).toBe("paid");
	});
});
