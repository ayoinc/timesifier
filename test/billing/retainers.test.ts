import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OrganisationScope, organisationScope } from "~/db";
import {
	createDraft,
	DRAWN_FROM_RETAINER,
	deletePayment,
	findInvoice,
	issueInvoice,
	recordPayment,
} from "~/invoices/invoices.server";
import {
	balanceAfter,
	drawFromRetainer,
	invoiceFunds,
	MORE_THAN_RETAINED,
	movementsOf,
	openRetainer,
	RETAINER_EXISTS,
	retainersFor,
} from "~/invoices/retainers.server";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation } from "../organisations/harness";
import { type Person, person } from "../pages/harness";

// Retainers (TS-078): a funds invoice adds its total to the balance once it
// is paid, a time invoice draws up to the balance, and the balance is never
// below 0 whatever is deposited, drawn or deleted.

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
	if (!client) throw new Error("seed failed");
	const [project] = await scope.projects.insert({
		name: "Site",
		nameKey: "site",
		clientId: client.id,
	});
	if (!project) throw new Error("seed failed");
	clientId = client.id;
	projectId = project.id;
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function retainer(project: string | null = null) {
	const opened = await openRetainer(scope, owner.user.id, clientId, project, "GBP");
	if (!opened?.ok) throw new Error("not opened");
	return opened.id;
}

async function balance(id: string) {
	const [row] = await scope.retainers.select();
	const movements = await movementsOf(scope, id);
	const moved = movements.reduce(
		(sum, m) => sum + (m.kind === "deposit" ? m.amountMinor : -m.amountMinor),
		0,
	);
	expect(row?.balanceMinor).toBe(moved);
	return row?.balanceMinor ?? Number.NaN;
}

/** An issued funds invoice for `amountMinor`. */
async function funds(retainerId: string, amountMinor: number) {
	const made = await invoiceFunds(scope, owner.user.id, retainerId, amountMinor, TODAY);
	if (!made?.ok) throw new Error("not made");
	expect((await issueInvoice(scope, owner.user.id, made.id))?.ok).toBe(true);
	return made.id;
}

/** An issued time invoice for `amountMinor` on Site. */
async function work(amountMinor: number, currency = "GBP") {
	const made = await createDraft(scope, owner.user.id, {
		clientId,
		currency,
		issuedOn: TODAY,
		taxIds: [null, null],
		lines: [
			{
				kind: "manual",
				description: "Design",
				projectId,
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

function pay(invoiceId: string, amountMinor: number, kind: "payment" | "write_off" = "payment") {
	return recordPayment(
		scope,
		owner.user.id,
		invoiceId,
		{
			kind,
			amountMinor,
			paidOn: TODAY,
			method: kind === "payment" ? "bank_transfer" : null,
			note: null,
		},
		TODAY,
	);
}

async function paymentIds(invoiceId: string) {
	return (await scope.payments.select()).filter((p) => p.invoiceId === invoiceId).map((p) => p.id);
}

describe("opening a retainer", () => {
	it("one per client, and one per client and project", async () => {
		await retainer();
		await retainer(projectId);
		expect(await openRetainer(scope, owner.user.id, clientId, null, "GBP")).toEqual({
			ok: false,
			problem: RETAINER_EXISTS,
		});
		expect(await openRetainer(scope, owner.user.id, clientId, projectId, "GBP")).toEqual({
			ok: false,
			problem: RETAINER_EXISTS,
		});
	});
});

describe("funds", () => {
	it("a funds invoice adds its total once, when it is paid in full", async () => {
		const id = await retainer();
		const invoice = await funds(id, 100_000);
		expect((await findInvoice(scope, invoice))?.retainerId).toBe(id);
		expect(await balance(id)).toBe(0);

		expect((await pay(invoice, 40_000))?.ok).toBe(true);
		expect(await balance(id)).toBe(0);
		expect((await pay(invoice, 60_000))?.ok).toBe(true);
		expect(await balance(id)).toBe(100_000);
		const movements = await movementsOf(scope, id);
		expect(movements.map((m) => [m.kind, m.amountMinor, m.invoiceId])).toEqual([
			["deposit", 100_000, invoice],
		]);

		// Paying again is refused; nothing more is deposited.
		expect((await pay(invoice, 1))?.ok).toBe(false);
		expect(await balance(id)).toBe(100_000);
		expect(await movementsOf(scope, id)).toHaveLength(1);

		// Unpaid again, its deposit goes; paid again, it comes back, once.
		const [first] = await paymentIds(invoice);
		expect((await deletePayment(scope, owner.user.id, invoice, first ?? "", TODAY))?.ok).toBe(true);
		expect(await balance(id)).toBe(0);
		expect((await pay(invoice, 40_000))?.ok).toBe(true);
		expect(await balance(id)).toBe(100_000);
		expect(await movementsOf(scope, id)).toHaveLength(1);
	});
});

describe("drawing", () => {
	it("a time invoice draws up to the balance, and up to what it owes", async () => {
		const id = await retainer();
		await pay(await funds(id, 50_000), 50_000);
		const big = await work(80_000);
		expect((await retainersFor(scope, big)).map((r) => r.id)).toEqual([id]);

		expect(await drawFromRetainer(scope, owner.user.id, big, id, 50_001, TODAY)).toEqual({
			ok: false,
			problem: MORE_THAN_RETAINED,
		});
		expect(await drawFromRetainer(scope, owner.user.id, big, id, 30_000, TODAY)).toEqual({
			ok: true,
			id: big,
		});
		expect(await balance(id)).toBe(20_000);
		expect((await findInvoice(scope, big))?.status).toBe("partially_paid");
		expect(await drawFromRetainer(scope, owner.user.id, big, id, 20_000, TODAY)).toEqual({
			ok: true,
			id: big,
		});
		expect(await balance(id)).toBe(0);
		expect(await drawFromRetainer(scope, owner.user.id, big, id, 1, TODAY)).toEqual({
			ok: false,
			problem: MORE_THAN_RETAINED,
		});

		// Never more than the invoice owes, whatever the balance.
		await pay(await funds(id, 90_000), 90_000);
		const small = await work(10_000);
		expect(await drawFromRetainer(scope, owner.user.id, small, id, 10_001, TODAY)).toEqual({
			ok: false,
			problem: MORE_THAN_RETAINED,
		});
		expect((await drawFromRetainer(scope, owner.user.id, small, id, 10_000, TODAY))?.ok).toBe(true);
		expect((await findInvoice(scope, small))?.status).toBe("paid");
		expect(await balance(id)).toBe(80_000);

		// A draw is a payment the invoice shows; deleting it gives the funds back.
		const [drawn] = (await scope.payments.select()).filter((p) => p.invoiceId === small);
		expect(drawn?.note).toBe(DRAWN_FROM_RETAINER);
		expect((await deletePayment(scope, owner.user.id, small, drawn?.id ?? "", TODAY))?.ok).toBe(
			true,
		);
		expect(await balance(id)).toBe(90_000);
		expect((await findInvoice(scope, small))?.status).toBe("sent");

		// Another currency, or a funds invoice, draws from nothing.
		const dollars = await work(1000, "USD");
		expect(await retainersFor(scope, dollars)).toEqual([]);
		expect((await drawFromRetainer(scope, owner.user.id, dollars, id, 1000, TODAY))?.ok).toBe(
			false,
		);
	});

	it("a funds payment that has been drawn on cannot be deleted", async () => {
		const id = await retainer();
		const invoice = await funds(id, 50_000);
		await pay(invoice, 50_000);
		await drawFromRetainer(scope, owner.user.id, await work(10_000), id, 10_000, TODAY);
		const [payment] = await paymentIds(invoice);
		const refused = await deletePayment(scope, owner.user.id, invoice, payment ?? "", TODAY);
		expect(refused?.ok).toBe(false);
		expect(await balance(id)).toBe(40_000);
		expect((await findInvoice(scope, invoice))?.status).toBe("paid");
	});
});

describe("the balance", () => {
	it("balanceAfter refuses every draw beyond the balance", () => {
		const next = random(78);
		for (let run = 0; run < 200; run++) {
			const movements = Array.from({ length: Math.floor(next() * 30) }, () => ({
				kind: next() < 0.4 ? ("deposit" as const) : ("draw" as const),
				amountMinor: 1 + Math.floor(next() * 10_000),
			}));
			let running = 0;
			let refused = 0;
			for (const m of movements) {
				if (m.kind === "deposit") running += m.amountMinor;
				else if (m.amountMinor <= running) running -= m.amountMinor;
				else refused++;
				expect(running).toBeGreaterThanOrEqual(0);
			}
			expect(balanceAfter(movements)).toEqual({ balanceMinor: running, refused });
		}
	});

	it("property: never below 0 under random deposits, draws and payment deletions", async () => {
		const next = random(2026);
		const id = await retainer();
		/** Funds invoices: their total and their payments. */
		const deposits: {
			invoice: string;
			total: number;
			payments: { id: string; amount: number }[];
		}[] = [];
		/** Draws: the time invoice, its payment and its amount. */
		const draws: { invoice: string; payment: string; amount: number }[] = [];
		const owed = new Map<string, number>();
		const paidOf = (d: (typeof deposits)[number]) => d.payments.reduce((s, p) => s + p.amount, 0);
		const expected = () =>
			deposits.filter((d) => paidOf(d) === d.total).reduce((s, d) => s + d.total, 0) -
			draws.reduce((s, d) => s + d.amount, 0);

		for (let step = 0; step < 60; step++) {
			const label = `step ${step}`;
			const roll = next();
			if (roll < 0.25) {
				const total = 1 + Math.floor(next() * 50_000);
				const invoice = await funds(id, total);
				deposits.push({ invoice, total, payments: [] });
			} else if (roll < 0.5 && deposits.length > 0) {
				const deposit = deposits[Math.floor(next() * deposits.length)];
				if (!deposit) throw new Error("no deposit");
				const left = deposit.total - paidOf(deposit);
				if (left === 0) continue;
				const amount = next() < 0.5 ? left : 1 + Math.floor(next() * left);
				const known = new Set(await paymentIds(deposit.invoice));
				expect((await pay(deposit.invoice, amount))?.ok, label).toBe(true);
				const [added] = (await paymentIds(deposit.invoice)).filter((p) => !known.has(p));
				deposit.payments.push({ id: added ?? "", amount });
			} else if (roll < 0.75) {
				let target = [...owed].find(([, left]) => left > 0)?.[0];
				if (!target || next() < 0.3) {
					const total = 1 + Math.floor(next() * 40_000);
					target = await work(total);
					owed.set(target, total);
				}
				const left = owed.get(target) ?? 0;
				const now = await balance(id);
				const amount = 1 + Math.floor(next() * Math.max(1, Math.min(now, left)) * 1.2);
				const known = new Set(await paymentIds(target));
				const drawn = await drawFromRetainer(scope, owner.user.id, target, id, amount, TODAY);
				if (amount > Math.min(now, left)) {
					expect(drawn, label).toEqual({ ok: false, problem: MORE_THAN_RETAINED });
				} else {
					expect(drawn?.ok, label).toBe(true);
					const [payment] = (await paymentIds(target)).filter((p) => !known.has(p));
					draws.push({ invoice: target, payment: payment ?? "", amount });
					owed.set(target, left - amount);
				}
			} else if (next() < 0.5 && draws.length > 0) {
				const [draw] = draws.splice(Math.floor(next() * draws.length), 1);
				if (!draw) throw new Error("no draw");
				const deleted = await deletePayment(
					scope,
					owner.user.id,
					draw.invoice,
					draw.payment,
					TODAY,
				);
				expect(deleted?.ok, label).toBe(true);
				owed.set(draw.invoice, (owed.get(draw.invoice) ?? 0) + draw.amount);
			} else {
				const paid = deposits.filter((d) => d.payments.length > 0);
				const deposit = paid[Math.floor(next() * paid.length)];
				if (!deposit) continue;
				const index = Math.floor(next() * deposit.payments.length);
				const payment = deposit.payments[index];
				if (!payment) throw new Error("no payment");
				const wasFull = paidOf(deposit) === deposit.total;
				const before = await balance(id);
				const deleted = await deletePayment(
					scope,
					owner.user.id,
					deposit.invoice,
					payment.id,
					TODAY,
				);
				if (wasFull && before < deposit.total) {
					expect(deleted?.ok, label).toBe(false);
				} else {
					expect(deleted?.ok, label).toBe(true);
					deposit.payments.splice(index, 1);
				}
			}
			const now = await balance(id);
			expect(now, label).toBeGreaterThanOrEqual(0);
			expect(now, label).toBe(expected());
		}
		expect(draws.length + deposits.length).toBeGreaterThan(5);
	});
});
