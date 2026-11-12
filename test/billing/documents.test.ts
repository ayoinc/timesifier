import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OrganisationScope, organisationScope } from "~/db";
import { sendInvoice } from "~/invoices/deliver.server";
import { invoiceDetailsOf } from "~/invoices/documents.server";
import {
	createDraft,
	findInvoice,
	issueInvoice,
	type NewInvoice,
	recordPayment,
	voidInvoice,
} from "~/invoices/invoices.server";
import type { DraftLine } from "~/invoices/lines";
import { addContact, contactsOf, fillTemplate, SUBJECTS } from "~/invoices/mail.server";
import { pdfFilename, pdfOf } from "~/invoices/pdf";
import {
	addTax,
	MOST_ACTIVE_TAXES,
	saveInvoiceDetails,
	TOO_MANY_TAXES,
} from "~/invoices/settings.server";
import { type TermsChoice, termsDays, termsLabel } from "~/invoices/terms";
import { historyOf, invoiceView } from "~/invoices/view.server";
import { negotiateLocale } from "~/shell/locale";
import { addDays } from "~/time/calendar";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation } from "../organisations/harness";
import { open, type Person, person, textOf } from "../pages/harness";

// An invoice as a document (TS-074): the organisation's settings and payment
// terms, taxes (UK VAT and a compound tax), the PDF against the page, and
// sending it to the client's billing contacts.

const INVOICES = "/app/acme/invoices";
const TODAY = "2026-11-02";
const NOW = Date.parse("2026-11-02T12:00:00Z");
/** The locale a page is written in for a browser that names none. */
const LOCALE = negotiateLocale(null);

let mailbox: Mailbox;
let scope: OrganisationScope;
let owner: Person;
let clientId: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	owner = await person(mailbox, "ada@example.com");
	const acme = await createOrganisation(owner.cookie, "Acme");
	scope = organisationScope(env.DB, acme.id);
	const [client] = await scope.clients.insert({ name: "Initech", nameKey: "initech" });
	if (!client) throw new Error("seed failed");
	clientId = client.id;
});

afterEach(() => {
	vi.restoreAllMocks();
});

const manual = (amountMinor: number, description = "Extra"): DraftLine => ({
	kind: "manual",
	description,
	projectId: null,
	quantityMilli: 1000,
	unitPriceMinor: amountMinor,
	amountMinor,
	timeEntryIds: [],
	expenseIds: [],
});

async function draft(lines: DraftLine[], more: Partial<NewInvoice> = {}) {
	const made = await createDraft(scope, owner.user.id, {
		clientId,
		currency: "GBP",
		issuedOn: TODAY,
		lines,
		...more,
	});
	if (!made.ok) throw new Error(made.problem);
	return made.id;
}

async function tax(name: string, rateBasisPoints: number, compound = false) {
	const added = await addTax(scope, { name, rateBasisPoints, compound });
	if (!added?.ok) throw new Error("tax refused");
	return added.id;
}

async function stored(id: string) {
	const row = await findInvoice(scope, id);
	if (!row) throw new Error("no such invoice");
	return row;
}

async function printed(id: string, locale = LOCALE) {
	const view = await invoiceView(scope, "Acme", id, { locale, today: TODAY });
	if (!view) throw new Error("no such invoice");
	return view.printed;
}

/** Spaces formatting puts in numbers, which the PDF writes as plain spaces. */
const plain = (text: string) => text.replace(/[\u00a0\u2009\u202f]/g, " ");

/** The WinAnsi codes the PDF writes for characters outside Latin-1 (app/invoices/pdf.ts). */
const FROM_WIN_ANSI: Record<number, string> = {
	128: "€",
	133: "…",
	145: "‘",
	146: "’",
	147: "“",
	148: "”",
	149: "•",
	150: "–",
	151: "—",
};

/** Every string the PDF draws, in order: its `(...) Tj` literals, unescaped. */
function pdfText(bytes: Uint8Array): string[] {
	const file = new TextDecoder("latin1").decode(bytes);
	return [...file.matchAll(/\(((?:\\[0-7]{3}|\\.|[^\\)])*)\) Tj/g)].map(([, body = ""]) =>
		body.replace(
			/\\([0-7]{3})|\\(.)/g,
			(_, octal: string | undefined, char: string | undefined) => {
				if (octal === undefined) return char ?? "";
				const code = Number.parseInt(octal, 8);
				return FROM_WIN_ANSI[code] ?? String.fromCharCode(code);
			},
		),
	);
}

describe("invoice settings", () => {
	it("keeps the organisation's details, and its payment terms set each new invoice's due date", async () => {
		const details = {
			legalName: "Acme Ltd",
			address: "1 High Street\nLondon",
			taxNumber: "GB123456789",
			paymentTermsDays: 30,
			defaultNotes: "Thank you for your business.",
			lateReminderAfterDays: 7,
			lateReminderEveryDays: 14,
		};
		await saveInvoiceDetails(scope, details);
		expect(await invoiceDetailsOf(scope)).toMatchObject(details);

		const terms: [TermsChoice, string | undefined, number, string][] = [
			["receipt", undefined, 0, "Upon receipt"],
			["net15", undefined, 15, "Net 15"],
			["net30", undefined, 30, "Net 30"],
			["net45", undefined, 45, "Net 45"],
			["net60", undefined, 60, "Net 60"],
			["custom", "21", 21, "Net 21"],
		];
		for (const [choice, custom, days, label] of terms) {
			const paymentTermsDays = termsDays(choice, custom);
			expect(paymentTermsDays, choice).toBe(days);
			await saveInvoiceDetails(scope, { ...details, paymentTermsDays: days });
			const id = await draft([manual(1000)]);
			const row = await stored(id);
			expect(row.dueOn, choice).toBe(addDays(TODAY, days));
			expect(row.notes, choice).toBe(details.defaultNotes);
			expect(termsLabel(days)).toBe(label);
			expect((await printed(id)).facts, choice).toContainEqual(["Terms", label]);
		}
		expect(termsDays("custom", "366")).toBeNull();
		expect(termsDays("custom", "-1")).toBeNull();
		expect(termsDays("custom", "")).toBeNull();

		const id = await draft([manual(1000)], { poNumber: "PO-7" });
		const document = await printed(id);
		expect(document.from).toEqual([
			"Acme Ltd",
			"1 High Street",
			"London",
			"Tax number GB123456789",
		]);
		expect(document.facts).toContainEqual(["PO number", "PO-7"]);
	});

	it("holds at most two taxes at once", async () => {
		await tax("VAT", 2000);
		await tax("Levy", 250, true);
		expect(MOST_ACTIVE_TAXES).toBe(2);
		expect(await addTax(scope, { name: "Third", rateBasisPoints: 100, compound: false })).toEqual({
			ok: false,
			problem: TOO_MANY_TAXES,
		});
	});
});

describe("tax", () => {
	it("UK VAT at 20%, with a discount and a line chosen to bear none", async () => {
		const vat = await tax("VAT", 2000);
		const lines = [manual(12_345, "Design"), manual(10_000, "Build")];

		const plainVat = await stored(await draft(lines, { taxIds: [vat, null] }));
		expect([
			plainVat.subtotalMinor,
			plainVat.discountMinor,
			plainVat.taxMinor,
			plainVat.totalMinor,
		]).toEqual([22_345, 0, 4469, 26_814]);

		// 10% off £223.45 is £22.345, rounded half up to £22.35. VAT is 20% of
		// the discounted £201.105: £40.221, so £40.22.
		const discounted = await draft(lines, {
			taxIds: [vat, null],
			discountBasisPoints: 1000,
			poNumber: "PO-7",
		});
		const row = await stored(discounted);
		expect([row.subtotalMinor, row.discountMinor, row.taxMinor, row.totalMinor]).toEqual([
			22_345, 2235, 4022, 24_132,
		]);
		expect(row.poNumber).toBe("PO-7");
		expect((await printed(discounted, "en-GB")).totals).toEqual([
			["Subtotal", "£223.45"],
			["Discount (10%)", "-£22.35"],
			["VAT (20%)", "£40.22"],
			["Total (GBP)", "£241.32"],
		]);

		// Per line: Build is exempt.
		const exempt = await stored(
			await draft(lines, {
				lineTaxes: [
					[vat, null],
					[null, null],
				],
			}),
		);
		expect([exempt.subtotalMinor, exempt.taxMinor, exempt.totalMinor]).toEqual([
			22_345, 2469, 24_814,
		]);
	});

	it("a compound tax is charged on the line plus its simple tax, and never on itself", async () => {
		const vat = await tax("VAT", 2000);
		const levy = await tax("Levy", 250, true);
		// £1,000.00 bearing both: VAT £200.00; Levy 2.5% of £1,200.00 = £30.00.
		// £33.33 bearing only the Levy: £0.83325. £45.67 bearing only VAT: £9.134.
		// VAT £209.134 → £209.13; Levy £30.83325 → £30.83.
		const id = await draft([manual(100_000), manual(3333), manual(4567)], {
			lineTaxes: [
				[vat, levy],
				[levy, null],
				[vat, null],
			],
		});
		const row = await stored(id);
		expect([row.subtotalMinor, row.discountMinor, row.taxMinor, row.totalMinor]).toEqual([
			107_900, 0, 23_996, 131_896,
		]);
		expect((await printed(id, "en-GB")).totals).toEqual([
			["Subtotal", "£1,079.00"],
			["VAT (20%)", "£209.13"],
			["Levy (2.5%)", "£30.83"],
			["Total (GBP)", "£1,318.96"],
		]);
	});
});

describe("the PDF", () => {
	it("prints the numbers the page shows", async () => {
		const vat = await tax("VAT", 2000);
		const lines = [
			manual(12_345, "Design (wireframes)"),
			{
				...manual(0, "Café — build"),
				quantityMilli: 2500,
				unitPriceMinor: 4000,
				amountMinor: 10_000,
			},
		];
		const pound = await draft(lines, {
			taxIds: [vat, null],
			discountBasisPoints: 1000,
			poNumber: "PO-7",
		});
		await issueInvoice(scope, owner.user.id, pound);
		await recordPayment(
			scope,
			owner.user.id,
			pound,
			{ kind: "payment", amountMinor: 5000, paidOn: TODAY, method: "card", note: null },
			TODAY,
		);
		const euro = await draft(lines, { currency: "EUR", taxIds: [vat, null] });

		for (const [id, locale] of [
			[pound, LOCALE],
			[euro, "de-DE"],
		] as const) {
			const document = await printed(id, locale);
			const text = pdfText(pdfOf(document));
			const expected = [
				document.title,
				document.number,
				...document.facts.flat(),
				...document.lines.flatMap((l) => [l.description, l.quantity, l.unitPrice, l.amount]),
				...document.totals.flat(),
			].map(plain);
			for (const words of expected) expect(text, `${id} ${words}`).toContain(words);
		}

		// The page and the PDF it links to show those same strings.
		const document = await printed(pound);
		expect(document.totals.map(([label]) => label)).toEqual([
			"Subtotal",
			"Discount (10%)",
			"VAT (20%)",
			"Total (GBP)",
			"Paid",
			"Balance due",
		]);
		const page = await open(`${INVOICES}/${pound}`, owner);
		expect(page.status).toBe(200);
		const shown = plain(textOf(await page.text()));
		for (const [label, amount] of document.totals) {
			expect(shown).toContain(label);
			expect(shown).toContain(plain(amount));
		}
		for (const line of document.lines) expect(shown).toContain(plain(line.amount));

		const served = await open(`${INVOICES}/${pound}/pdf`, owner);
		expect(served.status).toBe(200);
		expect(pdfText(new Uint8Array(await served.arrayBuffer()))).toEqual(pdfText(pdfOf(document)));
	});
});

describe("sending", () => {
	it("goes to each billing contact with the PDF, and is logged on the invoice's history", async () => {
		const actor = owner.user.id;
		expect(
			await addContact(scope, actor, clientId, { name: "Bola", email: "bola@initech.example" }),
		).toBe(true);
		await addContact(scope, actor, clientId, { name: null, email: "Accounts@Initech.example" });
		await addContact(scope, actor, clientId, { name: null, email: "accounts@initech.example" });
		const contacts = await contactsOf(scope, clientId);
		expect(contacts.map((c) => c.email)).toEqual([
			"bola@initech.example",
			"Accounts@Initech.example",
		]);

		const id = await draft([manual(12_345, "Design")]);
		const already = mailbox.send.mock.calls.length;
		const sent = await sendInvoice(scope, owner.user.id, id, {
			organisationName: "Acme",
			to: contacts.map((c) => c.email),
			locale: "en-GB",
			today: TODAY,
			now: new Date(NOW),
		});
		expect(sent).toEqual({ ok: true, number: "1" });
		const row = await stored(id);
		expect(row.status).toBe("sent");
		expect(row.sentAt?.getTime()).toBe(NOW);

		const pdf = pdfOf(await printed(id, "en-GB"));
		const messages = mailbox.send.mock.calls.slice(already).map(
			([message]) =>
				message as unknown as {
					to: string;
					subject: string;
					text: string;
					attachments: {
						disposition: string;
						filename: string;
						type: string;
						content: Uint8Array;
					}[];
				},
		);
		expect(messages.map((m) => m.to)).toEqual(contacts.map((c) => c.email));
		for (const message of messages) {
			expect(message.subject).toBe(
				fillTemplate(SUBJECTS.invoice, { number: "1", organisation: "Acme" }),
			);
			expect(message.subject).toBe("Invoice 1 from Acme");
			expect(message.text).toContain("£123.45");
			expect(message.text).toContain("Initech");
			expect(message.attachments).toHaveLength(1);
			const [attachment] = message.attachments;
			expect(attachment?.disposition).toBe("attachment");
			expect(attachment?.type).toBe("application/pdf");
			expect(attachment?.filename).toBe(pdfFilename("Invoice", "1"));
			expect(attachment?.filename).toBe("invoice-1.pdf");
			expect(pdfText(attachment?.content ?? new Uint8Array())).toEqual(pdfText(pdf));
		}

		const history = await historyOf(scope, id);
		const sends = history.filter((r) => r.action === "invoice.sent");
		expect(sends).toHaveLength(1);
		expect(sends[0]?.summary).toEqual({ after: { recipients: 2, reminder: false } });
		expect(sends[0]?.actorId).toBe(owner.user.id);

		// Sending again is logged again; a void invoice is not sent.
		await sendInvoice(scope, owner.user.id, id, {
			organisationName: "Acme",
			to: ["bola@initech.example"],
			locale: "en-GB",
			today: TODAY,
			now: new Date(NOW),
		});
		expect((await historyOf(scope, id)).filter((r) => r.action === "invoice.sent")).toHaveLength(2);
		const voided = await draft([manual(500)]);
		await issueInvoice(scope, owner.user.id, voided);
		await voidInvoice(scope, owner.user.id, voided, new Date(NOW));
		const before = mailbox.send.mock.calls.length;
		expect(
			await sendInvoice(scope, owner.user.id, voided, {
				organisationName: "Acme",
				to: ["bola@initech.example"],
				locale: "en-GB",
				today: TODAY,
				now: new Date(NOW),
			}),
		).toEqual({ ok: false, problem: "A void invoice is not sent." });
		expect(mailbox.send.mock.calls.length).toBe(before);
	});
});
