import { env } from "cloudflare:workers";
import { asc, isNull, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";

import { everyRow, type OrganisationScope, uuidv7 } from "~/db";
import { formatMoney, type InvoiceTotals, invoiceTotals } from "~/money/money";

import { quantityText } from "./lines";
import type { PrintedDocument } from "./pdf";

/**
 * What invoices and estimates share (TS-073, TS-074, TS-077): the
 * organisation's invoicing details, its taxes, the arithmetic of a document's
 * totals (`invoiceTotals` in app/money, with its one rounding rule), the
 * numbering, and the words a document is printed in. The page and the PDF
 * both read `printedDocument`, so what is on paper is what is on screen.
 */

/** Runs `items` as one D1 batch: all of them, or none. */
export async function inOneBatch(items: readonly BatchItem<"sqlite">[]): Promise<void> {
	const [first, ...rest] = items;
	if (!first) return;
	await drizzle(env.DB).batch([first, ...rest]);
}

/** The organisation's invoicing details, with the defaults until they are saved. */
export interface InvoiceDetails {
	legalName: string | null;
	address: string | null;
	taxNumber: string | null;
	paymentTermsDays: number;
	defaultNotes: string | null;
	lateReminderAfterDays: number | null;
	lateReminderEveryDays: number | null;
}

export const DEFAULT_DETAILS: InvoiceDetails = {
	legalName: null,
	address: null,
	taxNumber: null,
	paymentTermsDays: 30,
	defaultNotes: null,
	lateReminderAfterDays: null,
	lateReminderEveryDays: null,
};

export async function invoiceDetailsOf(scope: OrganisationScope): Promise<InvoiceDetails> {
	const [row] = await scope.invoiceSettings.select(undefined, { limit: 1 });
	return row ?? DEFAULT_DETAILS;
}

/**
 * Makes the organisation's settings row if it has none, so a number can be
 * taken from it. Two requests making it at once both find it made.
 */
export async function ensureInvoiceSettings(scope: OrganisationScope): Promise<void> {
	await scope.invoiceSettings.statements.insertIfAbsent({ id: uuidv7() }).query;
}

/**
 * The next number of a sequence, read inside the batch that stores the
 * document and raises the sequence (`raiseSequence`), so two documents saved
 * at once never share one and a number is never given twice.
 */
export function nextNumber(
	scope: OrganisationScope,
	sequence: "invoice" | "estimate",
): SQL<string> {
	return scope.invoiceSettings.value(
		(s) =>
			sql<string>`cast(${sequence === "invoice" ? s.nextInvoiceNumber : s.nextEstimateNumber} as text)`,
	);
}

/** The statement that moves a sequence on by one, for the same batch. */
export function raiseSequence(scope: OrganisationScope, sequence: "invoice" | "estimate") {
	return scope.invoiceSettings.statements.update(
		sequence === "invoice"
			? { nextInvoiceNumber: sql`next_invoice_number + 1` }
			: { nextEstimateNumber: sql`next_estimate_number + 1` },
		everyRow,
	).query;
}

/** A tax as a document applies it. */
export interface TaxRow {
	id: string;
	name: string;
	rateBasisPoints: number;
	compound: boolean;
	archivedAt: Date | null;
}

/** The organisation's taxes, the active ones first, each by when it was made. */
export async function taxesOf(scope: OrganisationScope): Promise<TaxRow[]> {
	// Simple taxes before compound ones, then oldest first; the id breaks a tie
	// between two made in the same second, so the order never changes.
	const rows = await scope.taxes.select(undefined, {
		orderBy: (t) => [asc(t.compound), asc(t.createdAt), asc(t.id)],
	});
	return [...rows].sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null));
}

/** The taxes a new line bears: the organisation's active ones, at most two. */
export async function defaultTaxIds(
	scope: OrganisationScope,
): Promise<[string | null, string | null]> {
	const active = await scope.taxes.select((t) => isNull(t.archivedAt), {
		orderBy: (t) => [asc(t.createdAt)],
		limit: 2,
	});
	return [active[0]?.id ?? null, active[1]?.id ?? null];
}

/** A line as the totals read it. */
export interface PricedLine {
	amountMinor: number;
	taxId: string | null;
	secondTaxId: string | null;
}

/** The totals of a document's lines: the shared arithmetic of app/money, with the taxes its lines name. */
export function totalsOf(
	lines: readonly PricedLine[],
	discountBasisPoints: number,
	taxes: readonly TaxRow[],
): InvoiceTotals {
	const named = new Set(lines.flatMap(({ taxId, secondTaxId }) => [taxId, secondTaxId]));
	return invoiceTotals({
		lines: lines.map(({ amountMinor, taxId, secondTaxId }) => ({
			amountMinor,
			taxIds: [taxId, secondTaxId].filter((id): id is string => id !== null),
		})),
		discountBasisPoints,
		taxes: taxes
			.filter(({ id }) => named.has(id))
			.map(({ id, rateBasisPoints, compound }) => ({ id, basisPoints: rateBasisPoints, compound })),
	});
}

/** The stored totals of a document, from `totalsOf`. */
export function storedTotals(totals: InvoiceTotals) {
	return {
		subtotalMinor: totals.subtotalMinor,
		discountMinor: totals.discountMinor,
		taxMinor: totals.taxMinor,
		totalMinor: totals.totalMinor,
	};
}

/** A rate in basis points as a percentage: 2000 is "20%", 1750 is "17.5%". */
export function percentText(basisPoints: number): string {
	const whole = Math.floor(basisPoints / 100);
	const fraction = String(basisPoints % 100)
		.padStart(2, "0")
		.replace(/0+$/, "");
	return fraction ? `${whole}.${fraction}%` : `${whole}%`;
}

/** Basis points as a field shows them: 2000 is "20", 1750 is "17.5". */
export function percentField(basisPoints: number): string {
	return percentText(basisPoints).replace("%", "");
}

/** The words a document is printed in: the parts every one has. */
export interface DocumentWords {
	title: "Invoice" | "Estimate";
	number: string;
	organisationName: string;
	details: Pick<InvoiceDetails, "legalName" | "address" | "taxNumber">;
	clientName: string;
	facts: [string, string][];
	subject: string | null;
	notes: string | null;
	currency: string;
	discountBasisPoints: number;
	lines: (PricedLine & { description: string; quantityMilli: number; unitPriceMinor: number })[];
	taxes: readonly TaxRow[];
	/** Rows after the total: paid, written off, balance due. */
	after?: [string, number][];
	locale: string;
}

/**
 * A document in words, for the page and for the PDF alike: every amount
 * formatted once, here.
 */
export function printedDocument(words: DocumentWords): PrintedDocument {
	const { currency, locale } = words;
	const money = (minor: number) => formatMoney(minor, currency, locale);
	const totals = totalsOf(words.lines, words.discountBasisPoints, words.taxes);
	const taxById = new Map(words.taxes.map((tax) => [tax.id, tax]));
	const rows: [string, string][] = [["Subtotal", money(totals.subtotalMinor)]];
	if (totals.discountMinor > 0 || words.discountBasisPoints > 0) {
		rows.push([
			`Discount (${percentText(words.discountBasisPoints)})`,
			money(-totals.discountMinor),
		]);
	}
	for (const tax of totals.taxes) {
		const row = taxById.get(tax.id);
		const name = row ? `${row.name} (${percentText(row.rateBasisPoints)})` : "Tax";
		rows.push([name, money(tax.amountMinor)]);
	}
	rows.push([`Total (${currency})`, money(totals.totalMinor)]);
	for (const [label, minor] of words.after ?? []) rows.push([label, money(minor)]);

	const from = [
		words.details.legalName ?? words.organisationName,
		...(words.details.address ?? "").split(/\r?\n/).filter((line) => line.trim() !== ""),
		...(words.details.taxNumber ? [`Tax number ${words.details.taxNumber}`] : []),
	];
	return {
		title: words.title,
		number: words.number,
		from,
		to: [words.clientName],
		facts: words.facts,
		subject: words.subject,
		lines: words.lines.map((line) => ({
			description: line.description,
			quantity: quantityText(line.quantityMilli),
			unitPrice: money(line.unitPriceMinor),
			amount: money(line.amountMinor),
		})),
		totals: rows,
		notes: words.notes,
	};
}
