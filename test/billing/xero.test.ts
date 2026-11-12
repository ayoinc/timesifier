import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { type OrganisationScope, organisationScope } from "~/db";
import {
	createDraft,
	issueInvoice,
	type NewInvoice,
	voidInvoice,
} from "~/invoices/invoices.server";
import type { DraftLine } from "~/invoices/lines";
import { addContact } from "~/invoices/mail.server";
import { addTax } from "~/invoices/settings.server";
import {
	DEFAULT_XERO_OPTIONS,
	XERO_COLUMNS,
	xeroCsv,
	xeroDate,
	xeroFilename,
} from "~/invoices/xero";

import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation } from "../organisations/harness";
import { open, type Person, person } from "../pages/harness";

// The Xero sales-invoice export (TS-088): the formatter's file and the
// route's download, both against a fixture written out by hand from Xero's
// import template. The fixture is kept with plain line ends; the file's are
// CRLF, so the fixture's are made CRLF before the comparison.

const fixture = import.meta.glob<string>("./fixtures/xero-invoices.csv", {
	eager: true,
	query: "?raw",
	import: "default",
})["./fixtures/xero-invoices.csv"];

const expected = () => (fixture ?? "").replace(/\r?\n/g, "\r\n");

const XERO = "/app/acme/invoices/xero";

let scope: OrganisationScope;
let owner: Person;
let clientId: string;
let vat: string;

const line = (description: string, quantityMilli: number, unitPriceMinor: number): DraftLine => ({
	kind: "manual",
	description,
	projectId: null,
	quantityMilli,
	unitPriceMinor,
	amountMinor: (quantityMilli * unitPriceMinor) / 1000,
	timeEntryIds: [],
	expenseIds: [],
});

async function invoice(more: Omit<NewInvoice, "clientId" | "currency">, issue = true) {
	const made = await createDraft(scope, owner.user.id, { clientId, currency: "GBP", ...more });
	if (!made.ok) throw new Error(made.problem);
	if (issue) await issueInvoice(scope, owner.user.id, made.id);
	return made.id;
}

beforeEach(async () => {
	await freshDatabase();
	const mailbox = captureEmail();
	owner = await person(mailbox, "ada@example.com");
	const acme = await createOrganisation(owner.cookie, "Acme");
	scope = organisationScope(env.DB, acme.id);
	const [client] = await scope.clients.insert({ name: "Initech, Ltd", nameKey: "initech, ltd" });
	if (!client) throw new Error("seed failed");
	clientId = client.id;
	await addContact(scope, owner.user.id, clientId, {
		name: "Bill",
		email: "accounts@initech.example",
	});
	const added = await addTax(scope, {
		name: "20% (VAT on Income)",
		rateBasisPoints: 2000,
		compound: false,
	});
	if (!added?.ok) throw new Error("tax refused");
	vat = added.id;

	// INV 1: two exact lines, one taxed, with a PO number.
	await invoice({
		issuedOn: "2026-11-02",
		poNumber: "PO-7",
		paymentTermsDays: 30,
		lines: [line("Design work", 7500, 12000), line("Hosting", 1000, 5000)],
		lineTaxes: [
			[vat, null],
			[null, null],
		],
	});
	// INV 2: a 10% discount, so its line is written as one of its amount.
	await invoice({
		issuedOn: "2026-11-20",
		paymentTermsDays: 14,
		discountBasisPoints: 1000,
		lines: [line("Support", 2000, 10000)],
		lineTaxes: [[vat, null]],
	});
	// Left out: a draft, a void invoice, and one issued outside the range.
	await invoice({ issuedOn: "2026-11-21", lines: [line("Draft", 1000, 100)] }, false);
	const voided = await invoice({ issuedOn: "2026-11-22", lines: [line("Void", 1000, 100)] });
	await voidInvoice(scope, owner.user.id, voided, new Date());
	await invoice({ issuedOn: "2026-12-01", lines: [line("December", 1000, 100)] });
});

describe("Xero sales-invoice CSV", () => {
	it("uses the 27 headings of Xero's template, in its order", () => {
		expect(XERO_COLUMNS).toHaveLength(27);
		expect(expected().split("\r\n")[0]).toBe(XERO_COLUMNS.join(","));
	});

	it("writes dates as the Xero organisation's region reads them", () => {
		expect(xeroDate("2026-11-02", "day-first")).toBe("02/11/2026");
		expect(xeroDate("2026-11-02", "month-first")).toBe("11/02/2026");
	});

	it("formats invoices exactly as the fixture", () => {
		const file = xeroCsv(
			[
				{
					number: "1",
					clientName: "Initech, Ltd",
					email: "accounts@initech.example",
					poNumber: "PO-7",
					issuedOn: "2026-11-02",
					dueOn: "2026-12-02",
					currency: "GBP",
					discountMinor: 0,
					lines: [
						{ ...line("Design work", 7500, 12000), taxId: vat, secondTaxId: null },
						{ ...line("Hosting", 1000, 5000), taxId: null, secondTaxId: null },
					],
				},
				{
					number: "2",
					clientName: "Initech, Ltd",
					email: "accounts@initech.example",
					poNumber: null,
					issuedOn: "2026-11-20",
					dueOn: "2026-12-04",
					currency: "GBP",
					discountMinor: 2000,
					lines: [{ ...line("Support", 2000, 10000), taxId: vat, secondTaxId: null }],
				},
			],
			[{ id: vat, name: "20% (VAT on Income)" }],
			DEFAULT_XERO_OPTIONS,
		);
		expect(file).toBe(expected());
	});

	it("downloads the issued invoices of the range as the fixture", async () => {
		const response = await open(`${XERO}?from=2026-11-01&to=2026-11-30`, owner);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8; header=present");
		expect(response.headers.get("Content-Disposition")).toBe(
			`attachment; filename="${xeroFilename("acme", "2026-11-01", "2026-11-30")}"`,
		);
		expect(response.headers.get("Content-Disposition")).toBe(
			'attachment; filename="timesifier-acme-xero-2026-11-01-to-2026-11-30.csv"',
		);
		expect(await response.text()).toBe(expected());
	});

	it("refuses options that are not ones", async () => {
		const response = await open(`${XERO}?dateOrder=sideways`, owner);
		expect(response.status).toBe(400);
	});
});
