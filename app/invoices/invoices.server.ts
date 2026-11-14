import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import { recordStatement, recordStatementWhen } from "~/activity/activity.server";
import { among, type OrganisationScope, type TenantRow, uuidv7 } from "~/db";
import { lineAmount } from "~/money/money";
import { addDays, type Day } from "~/time/calendar";

import {
	defaultTaxIds,
	ensureInvoiceSettings,
	inOneBatch,
	invoiceDetailsOf,
	nextNumber,
	raiseSequence,
	storedTotals,
	type TaxRow,
	taxesOf,
	totalsOf,
} from "./documents.server";
import type { DraftLine } from "./lines";
import { balanceOf, OWING, type Settled } from "./status";

/**
 * Invoices (TS-073, TS-074): a draft made from tracked time and expenses or
 * from nothing, its lines, issuing it, voiding it and deleting it. Owners,
 * admins and Finance alone reach these (`mayInvoice`): every route that calls
 * them is under Invoices, which no one else is shown.
 *
 * Every write is one D1 batch with its activity record, and the database
 * holds the rules a race could break: a number is taken in the batch that
 * stores the invoice (`nextNumber`), an entry is on at most one line (a unique
 * index), an issued invoice's lines do not change and a payment is never more
 * than is owed (triggers in migration 0009).
 */

export type InvoiceRow = TenantRow<"invoices">;
export type InvoiceLineRow = TenantRow<"invoiceLines">;
export type PaymentRow = TenantRow<"payments">;

/** What a write answered: done, refused with a sentence, or nothing of that id here. */
export type Result<T = { id: string }> = ({ ok: true } & T) | { ok: false; problem: string } | null;

export const NOT_A_DRAFT = "That invoice has been issued, so its lines and details are fixed.";
export const NOTHING_TO_INVOICE =
	"There is nothing to invoice for that client, range and projects.";
export const INVOICED_MEANWHILE =
	"Some of that time or those expenses were put on another invoice meanwhile. Look again.";

/** The invoice of this organisation with this id, or null. */
export async function findInvoice(scope: OrganisationScope, id: string) {
	const [row] = await scope.invoices.select((i) => eq(i.id, id), { limit: 1 });
	return row ?? null;
}

/** An invoice's lines, in order. */
export function linesOf(scope: OrganisationScope, invoiceId: string) {
	return scope.invoiceLines.select((l) => eq(l.invoiceId, invoiceId), {
		orderBy: (l) => [asc(l.position)],
	});
}

/** What has been paid and written off on each of `invoiceIds`. */
export async function settledOf(
	scope: OrganisationScope,
	invoiceIds: readonly string[],
): Promise<Map<string, Settled>> {
	const settled = new Map<string, Settled>();
	if (invoiceIds.length === 0) return settled;
	const rows = await scope.payments.select((p) => among(p.invoiceId, invoiceIds));
	for (const row of rows) {
		const sum = settled.get(row.invoiceId) ?? { paidMinor: 0, writtenOffMinor: 0 };
		if (row.kind === "write_off") sum.writtenOffMinor += row.amountMinor;
		else sum.paidMinor += row.amountMinor;
		settled.set(row.invoiceId, sum);
	}
	return settled;
}

/** The statement that stores an invoice's totals from its lines and taxes as they will stand. */
function totalsStatement(
	scope: OrganisationScope,
	invoice: { id: string; discountBasisPoints: number },
	lines: readonly { amountMinor: number; taxId: string | null; secondTaxId: string | null }[],
	taxes: readonly TaxRow[],
) {
	return scope.invoices.statements.update(
		storedTotals(totalsOf(lines, invoice.discountBasisPoints, taxes)),
		(i) => and(eq(i.id, invoice.id), eq(i.status, "draft")),
	).query;
}

/** The new draft's lines and what they bill for, as statements for the batch that stores it. */
function lineStatements(
	scope: OrganisationScope,
	invoiceId: string,
	lines: readonly DraftLine[],
	taxIds: [string | null, string | null],
	firstPosition = 0,
): BatchItem<"sqlite">[] {
	const items: BatchItem<"sqlite">[] = [];
	lines.forEach((line, index) => {
		const id = uuidv7();
		items.push(
			scope.invoiceLines.statements.insert({
				id,
				invoiceId,
				position: firstPosition + index,
				kind: line.kind,
				description: line.description,
				projectId: line.projectId,
				quantityMilli: line.quantityMilli,
				unitPriceMinor: line.unitPriceMinor,
				amountMinor: line.amountMinor,
				taxId: taxIds[0],
				secondTaxId: taxIds[0] ? taxIds[1] : null,
			}).query,
		);
		const sources = [
			...line.timeEntryIds.map((timeEntryId) => ({ lineId: id, timeEntryId })),
			...line.expenseIds.map((expenseId) => ({ lineId: id, expenseId })),
		];
		// D1 limits the values bound to one statement, so sources go in groups.
		for (let at = 0; at < sources.length; at += 25) {
			items.push(scope.invoiceLineSources.statements.insert(sources.slice(at, at + 25)).query);
		}
	});
	return items;
}

/** What a new draft is. */
export interface NewInvoice {
	clientId: string;
	currency: string;
	issuedOn: Day;
	lines: readonly DraftLine[];
	subject?: string | null;
	notes?: string | null;
	poNumber?: string | null;
	retainerId?: string | null;
	recurringInvoiceId?: string | null;
	estimateId?: string | null;
	paymentTermsDays?: number;
	/** The taxes each line bears; the organisation's active ones when not given. */
	taxIds?: [string | null, string | null];
	/** Per line, when lines come with their own taxes (an estimate's). */
	lineTaxes?: readonly [string | null, string | null][];
	discountBasisPoints?: number;
}

/**
 * Saves a draft with the next number of the organisation's sequence, its
 * lines, and the entries and expenses they bill for marked as invoiced on it.
 * Refused when any of those was put on another invoice meanwhile.
 */
export async function createDraft(
	scope: OrganisationScope,
	actor: string | null,
	draft: NewInvoice,
	source: "web" | "system" = "web",
): Promise<{ ok: true; id: string } | { ok: false; problem: string }> {
	if (draft.lines.length === 0) return { ok: false, problem: NOTHING_TO_INVOICE };
	const [details, taxes, taxIds] = await Promise.all([
		invoiceDetailsOf(scope),
		taxesOf(scope),
		draft.taxIds ? Promise.resolve(draft.taxIds) : defaultTaxIds(scope),
	]);
	await ensureInvoiceSettings(scope);
	const id = uuidv7();
	const terms = draft.paymentTermsDays ?? details.paymentTermsDays;
	const discountBasisPoints = draft.discountBasisPoints ?? 0;
	const lineTaxes = draft.lines.map((_, index) => draft.lineTaxes?.[index] ?? taxIds);
	const totals = totalsOf(
		draft.lines.map((line, index) => ({
			amountMinor: line.amountMinor,
			taxId: lineTaxes[index]?.[0] ?? null,
			secondTaxId: lineTaxes[index]?.[0] ? (lineTaxes[index]?.[1] ?? null) : null,
		})),
		discountBasisPoints,
		taxes,
	);
	const items: BatchItem<"sqlite">[] = [
		scope.invoices.statements.insert({
			id,
			number: nextNumber(scope, "invoice"),
			clientId: draft.clientId,
			status: "draft",
			currency: draft.currency,
			issuedOn: draft.issuedOn,
			dueOn: addDays(draft.issuedOn, terms),
			poNumber: draft.poNumber ?? null,
			subject: draft.subject ?? null,
			notes: draft.notes ?? details.defaultNotes,
			discountBasisPoints,
			...storedTotals(totals),
			retainerId: draft.retainerId ?? null,
			recurringInvoiceId: draft.recurringInvoiceId ?? null,
			estimateId: draft.estimateId ?? null,
		}).query,
		raiseSequence(scope, "invoice"),
	];
	draft.lines.forEach((line, index) => {
		items.push(...lineStatements(scope, id, [line], lineTaxes[index] ?? [null, null], index));
	});
	// An estimate's invoice: the estimate points at it in the same batch.
	if (draft.estimateId) {
		const estimateId = draft.estimateId;
		items.push(
			scope.estimates.statements.update({ invoiceId: id }, (e) =>
				and(eq(e.id, estimateId), isNull(e.invoiceId)),
			).query,
		);
	}
	items.push(
		recordStatement(
			scope,
			actor,
			"invoice.created",
			{ type: "invoice", id },
			{ after: { lines: draft.lines.length, totalMinor: totals.totalMinor } },
			source,
		).query,
	);
	try {
		await inOneBatch(items);
	} catch (error) {
		if (String(error).includes("UNIQUE constraint failed: invoice_line_sources")) {
			return { ok: false, problem: INVOICED_MEANWHILE };
		}
		throw error;
	}
	return { ok: true, id };
}

/** Refuses anything but a draft of this organisation. */
async function draftOf(scope: OrganisationScope, id: string) {
	const invoice = await findInvoice(scope, id);
	if (!invoice) return null;
	if (invoice.status !== "draft") return { ok: false as const, problem: NOT_A_DRAFT };
	return { ok: true as const, invoice };
}

/** What a person may change on a draft's details. */
export interface DraftDetails {
	issuedOn: Day;
	dueOn: Day;
	poNumber: string | null;
	subject: string | null;
	notes: string | null;
	discountBasisPoints: number;
}

/** Changes a draft's dates, PO number, subject, notes and discount, and its totals with them. */
export async function changeDraft(
	scope: OrganisationScope,
	actor: string,
	id: string,
	details: DraftDetails,
): Promise<Result> {
	const found = await draftOf(scope, id);
	if (!found?.ok) return found;
	if (details.dueOn < details.issuedOn) {
		return { ok: false, problem: "The due date cannot be before the issue date." };
	}
	const [lines, taxes] = await Promise.all([linesOf(scope, id), taxesOf(scope)]);
	await scope.batch([
		scope.invoices.statements.update(
			{
				...details,
				...storedTotals(totalsOf(lines, details.discountBasisPoints, taxes)),
			},
			(i) => and(eq(i.id, id), eq(i.status, "draft")),
		),
		recordStatement(
			scope,
			actor,
			"invoice.updated",
			{ type: "invoice", id },
			{
				before: {
					discountBasisPoints: found.invoice.discountBasisPoints,
					dueOn: found.invoice.dueOn,
				},
				after: { discountBasisPoints: details.discountBasisPoints, dueOn: details.dueOn },
			},
		),
	]);
	return { ok: true, id };
}

/** A line as a person writes it. */
export interface LineInput {
	description: string;
	quantityMilli: number;
	unitPriceMinor: number;
	taxId: string | null;
	secondTaxId: string | null;
}

/** Whether both of a line's taxes are the organisation's, the second only after a first and not the same. */
async function taxesAllowed(scope: OrganisationScope, line: LineInput): Promise<boolean> {
	const ids = [line.taxId, line.secondTaxId].filter((id): id is string => id !== null);
	if (line.secondTaxId !== null && (line.taxId === null || line.taxId === line.secondTaxId)) {
		return false;
	}
	if (ids.length === 0) return true;
	const found = await scope.taxes.select((t) => among(t.id, ids));
	return found.length === ids.length;
}

export const TAX_NOT_OFFERED = "Choose the organisation's taxes, each once.";

/**
 * Adds a free line to a draft. It changes the total and the invoiced state
 * of nothing.
 */
export async function addLine(
	scope: OrganisationScope,
	actor: string,
	invoiceId: string,
	line: LineInput,
): Promise<Result> {
	const found = await draftOf(scope, invoiceId);
	if (!found?.ok) return found;
	if (!(await taxesAllowed(scope, line))) return { ok: false, problem: TAX_NOT_OFFERED };
	const [lines, taxes] = await Promise.all([linesOf(scope, invoiceId), taxesOf(scope)]);
	const amountMinor = lineAmount(line.quantityMilli, line.unitPriceMinor);
	const added = { ...line, amountMinor };
	await scope.batch([
		scope.invoiceLines.statements.insert({
			invoiceId,
			position: (lines.at(-1)?.position ?? -1) + 1,
			kind: "manual",
			projectId: null,
			...added,
		}),
		{ query: totalsStatement(scope, found.invoice, [...lines, added], taxes) },
		recordStatement(
			scope,
			actor,
			"invoice.updated",
			{ type: "invoice", id: invoiceId },
			{
				after: { line: "added" },
			},
		),
	]);
	return { ok: true, id: invoiceId };
}

/**
 * Changes a line of a draft. Its amount is its quantity times its price,
 * unless neither changed: then a time line keeps the share of the time's
 * worth it was given. What it bills for stays invoiced on it.
 */
export async function changeLine(
	scope: OrganisationScope,
	actor: string,
	invoiceId: string,
	lineId: string,
	line: LineInput,
): Promise<Result> {
	const found = await draftOf(scope, invoiceId);
	if (!found?.ok) return found;
	const [lines, taxes] = await Promise.all([linesOf(scope, invoiceId), taxesOf(scope)]);
	const current = lines.find((l) => l.id === lineId);
	if (!current) return null;
	if (!(await taxesAllowed(scope, line))) return { ok: false, problem: TAX_NOT_OFFERED };
	const priced =
		current.quantityMilli === line.quantityMilli && current.unitPriceMinor === line.unitPriceMinor;
	const changed = {
		...line,
		amountMinor: priced ? current.amountMinor : lineAmount(line.quantityMilli, line.unitPriceMinor),
	};
	await scope.batch([
		scope.invoiceLines.statements.update(changed, (l) =>
			and(eq(l.id, lineId), eq(l.invoiceId, invoiceId)),
		),
		{
			query: totalsStatement(
				scope,
				found.invoice,
				lines.map((l) => (l.id === lineId ? changed : l)),
				taxes,
			),
		},
		recordStatement(
			scope,
			actor,
			"invoice.updated",
			{ type: "invoice", id: invoiceId },
			{
				before: { amountMinor: current.amountMinor },
				after: { amountMinor: changed.amountMinor },
			},
		),
	]);
	return { ok: true, id: invoiceId };
}

/** Deletes a line of a draft, which lets go of the time and expenses it billed for. */
export async function deleteLine(
	scope: OrganisationScope,
	actor: string,
	invoiceId: string,
	lineId: string,
): Promise<Result> {
	const found = await draftOf(scope, invoiceId);
	if (!found?.ok) return found;
	const [lines, taxes] = await Promise.all([linesOf(scope, invoiceId), taxesOf(scope)]);
	const current = lines.find((l) => l.id === lineId);
	if (!current) return null;
	await scope.batch([
		scope.invoiceLineSources.statements.delete((s) => eq(s.lineId, lineId)),
		scope.invoiceLines.statements.delete((l) => and(eq(l.id, lineId), eq(l.invoiceId, invoiceId))),
		{
			query: totalsStatement(
				scope,
				found.invoice,
				lines.filter((l) => l.id !== lineId),
				taxes,
			),
		},
		recordStatement(
			scope,
			actor,
			"invoice.updated",
			{ type: "invoice", id: invoiceId },
			{
				before: { line: "removed", amountMinor: current.amountMinor },
			},
		),
	]);
	return { ok: true, id: invoiceId };
}

/**
 * Deletes a draft, which lets go of everything on it. Its number is not
 * given again: the sequence only moves on.
 */
export async function deleteDraft(
	scope: OrganisationScope,
	actor: string,
	id: string,
): Promise<Result<{ number: string }>> {
	const found = await draftOf(scope, id);
	if (!found?.ok) return found;
	const lineIds = (await linesOf(scope, id)).map((l) => l.id);
	await inOneBatch([
		// Recorded first, while it is still a draft: two deletes at once record one.
		recordStatementWhen(
			scope,
			scope.invoices.exists((i) => and(eq(i.id, id), eq(i.status, "draft"))),
			actor,
			"invoice.deleted",
			{ type: "invoice", id },
			{
				before: { number: found.invoice.number },
			},
		).query,
		...(lineIds.length > 0
			? [scope.invoiceLineSources.statements.delete((s) => among(s.lineId, lineIds)).query]
			: []),
		scope.estimates.statements.update({ invoiceId: null }, (e) => eq(e.invoiceId, id)).query,
		scope.invoiceLines.statements.delete((l) => eq(l.invoiceId, id)).query,
		scope.invoices.statements.delete((i) => and(eq(i.id, id), eq(i.status, "draft"))).query,
	]);
	return { ok: true, number: found.invoice.number };
}

/**
 * Issues a draft: it becomes open, and its number, issue date, due date and
 * lines are fixed from now on.
 */
export async function issueInvoice(
	scope: OrganisationScope,
	actor: string | null,
	id: string,
	source: "web" | "system" = "web",
): Promise<Result<{ number: string }>> {
	const found = await draftOf(scope, id);
	if (!found?.ok) return found;
	const lines = await linesOf(scope, id);
	if (lines.length === 0) return { ok: false, problem: "Add a line before issuing the invoice." };
	const status = found.invoice.totalMinor === 0 ? "paid" : "sent";
	await scope.batch([
		// Recorded first, while the invoice is still a draft: two issues at once record one.
		recordStatementWhen(
			scope,
			scope.invoices.exists((i) => and(eq(i.id, id), eq(i.status, "draft"))),
			actor,
			"invoice.updated",
			{ type: "invoice", id },
			{ before: { status: "draft" }, after: { status: "open", number: found.invoice.number } },
			source,
		),
		scope.invoices.statements.update({ status }, (i) => and(eq(i.id, id), eq(i.status, "draft"))),
	]);
	return { ok: true, number: found.invoice.number };
}

/**
 * Voids an issued invoice that has no payments: it stays, with its number,
 * marked void, and the time and expenses on it are let go to be invoiced
 * again.
 */
export async function voidInvoice(
	scope: OrganisationScope,
	actor: string,
	id: string,
	now: Date,
): Promise<Result<{ number: string }>> {
	const invoice = await findInvoice(scope, id);
	if (!invoice) return null;
	if (invoice.status === "draft") {
		return { ok: false, problem: "A draft is deleted, not voided." };
	}
	if (invoice.status === "void") return { ok: false, problem: "That invoice is already void." };
	const settled = (await settledOf(scope, [id])).get(id);
	if (settled && settled.paidMinor + settled.writtenOffMinor > 0) {
		return {
			ok: false,
			problem: "That invoice has payments or write-offs. Delete them before voiding it.",
		};
	}
	const lineIds = (await linesOf(scope, id)).map((l) => l.id);
	await inOneBatch([
		// Recorded first, while the invoice is still issued: two voids at once record one.
		recordStatementWhen(
			scope,
			scope.invoices.exists((i) => and(eq(i.id, id), inArray(i.status, [...OWING, "paid"]))),
			actor,
			"invoice.voided",
			{ type: "invoice", id },
			{
				before: { status: invoice.status },
				after: { status: "void" },
			},
		).query,
		...(lineIds.length > 0
			? [scope.invoiceLineSources.statements.delete((s) => among(s.lineId, lineIds)).query]
			: []),
		scope.invoices.statements.update({ status: "void", voidedAt: now }, (i) =>
			and(eq(i.id, id), inArray(i.status, [...OWING, "paid"])),
		).query,
	]);
	return { ok: true, number: invoice.number };
}

/** The settled status of an invoice, worked out in SQL from its payments so two writes cannot disagree. */
export function settleStatement(scope: OrganisationScope, invoiceId: string) {
	const paid = sql`coalesce(${scope.payments.value(
		(p) => sql<number>`sum(${p.amountMinor})`,
		(p) => eq(p.invoiceId, invoiceId),
	)}, 0)`;
	return scope.invoices.statements.update(
		{
			status: sql`case when total_minor - ${paid} <= 0 then 'paid' when ${paid} > 0 then 'partially_paid' else 'sent' end`,
		},
		(i) => and(eq(i.id, invoiceId), inArray(i.status, [...OWING, "paid"])),
	).query;
}

/**
 * The statements that bring a retainer's balance and its funds invoice into
 * line after a change to the invoice's payments: a funds invoice paid in full
 * adds what was paid on it (not what was written off) to the retainer once; one that is no longer paid takes it
 * back. The balance is the sum of the movements, and the table refuses one
 * below 0, so a deposit already drawn on cannot be taken back.
 */
export function retainerStatements(
	scope: OrganisationScope,
	invoice: { id: string; retainerId: string | null },
	today: Day,
): BatchItem<"sqlite">[] {
	if (!invoice.retainerId) return [];
	const id = invoice.id;
	const paid = scope.invoices.exists((i) => and(eq(i.id, id), eq(i.status, "paid")));
	// What was received: payments only. A write-off settles the invoice but
	// brings in no money, so it adds nothing to the retainer.
	const received = sql<number>`coalesce(${scope.payments.value(
		(p) => sql<number>`sum(${p.amountMinor})`,
		(p) => and(eq(p.invoiceId, id), eq(p.kind, "payment")),
	)}, 0)`;
	return [
		scope.retainerMovements.statements.insertWhen(
			{
				id: uuidv7(),
				retainerId: invoice.retainerId,
				kind: "deposit",
				amountMinor: received,
				invoiceId: id,
				occurredOn: today,
				createdAt: new Date(),
			},
			sql`${paid} and ${received} > 0
				and not ${scope.retainerMovements.exists((m) => and(eq(m.invoiceId, id), eq(m.kind, "deposit")))}`,
		).query,
		scope.retainerMovements.statements.delete((m) =>
			and(eq(m.invoiceId, id), eq(m.kind, "deposit"), sql`not ${paid}`),
		).query,
		balanceStatement(scope, invoice.retainerId),
	];
}

/** The statement that sets a retainer's balance to the sum of its movements. */
export function balanceStatement(scope: OrganisationScope, retainerId: string) {
	const moved = scope.retainerMovements.value(
		(m) =>
			sql<number>`sum(case ${m.kind} when 'deposit' then ${m.amountMinor} else -${m.amountMinor} end)`,
		(m) => eq(m.retainerId, retainerId),
	);
	return scope.retainers.statements.update(
		{ balanceMinor: sql`coalesce(${moved}, 0)`, updatedAt: new Date() },
		(r) => eq(r.id, retainerId),
	).query;
}

/** A payment or a write-off as a person records it. */
export interface PaymentInput {
	kind: "payment" | "write_off";
	amountMinor: number;
	paidOn: Day;
	method: "bank_transfer" | "card" | "cash" | "cheque" | "other" | null;
	note: string | null;
}

export const MORE_THAN_OWED = "That is more than is owed on this invoice.";

/**
 * Records a payment or a write-off against an issued invoice. It is refused
 * when it is more than the balance, which stays at 0 or above.
 */
export async function recordPayment(
	scope: OrganisationScope,
	actor: string,
	invoiceId: string,
	input: PaymentInput,
	today: Day,
): Promise<Result> {
	const invoice = await findInvoice(scope, invoiceId);
	if (!invoice) return null;
	if (!OWING.includes(invoice.status as never)) {
		return {
			ok: false,
			problem:
				invoice.status === "draft"
					? "Issue the invoice before recording a payment."
					: "Nothing is owed on that invoice.",
		};
	}
	const settled = (await settledOf(scope, [invoiceId])).get(invoiceId) ?? {
		paidMinor: 0,
		writtenOffMinor: 0,
	};
	if (input.amountMinor > balanceOf(invoice.totalMinor, settled)) {
		return { ok: false, problem: MORE_THAN_OWED };
	}
	const id = uuidv7();
	try {
		await inOneBatch([
			scope.payments.statements.insert({
				id,
				invoiceId,
				kind: input.kind,
				amountMinor: input.amountMinor,
				paidOn: input.paidOn,
				method: input.kind === "payment" ? input.method : null,
				note: input.note,
				recordedBy: actor,
			}).query,
			settleStatement(scope, invoiceId),
			...retainerStatements(scope, invoice, today),
			recordStatement(
				scope,
				actor,
				"payment.recorded",
				{ type: "payment", id },
				{
					after: { invoice: invoice.number, kind: input.kind, amountMinor: input.amountMinor },
				},
			).query,
		]);
	} catch (error) {
		if (String(error).includes("a payment is at most"))
			return { ok: false, problem: MORE_THAN_OWED };
		throw error;
	}
	return { ok: true, id: invoiceId };
}

/** The note a payment drawn from a retainer carries, which deleting it reads to give the funds back. */
export const DRAWN_FROM_RETAINER = "Drawn from retainer";

/**
 * Deletes a payment or a write-off, which leaves its amount owed again. One
 * drawn from a retainer gives the funds back to it; a funds invoice that is
 * no longer paid takes its deposit back, refused when that has been drawn on.
 */
export async function deletePayment(
	scope: OrganisationScope,
	actor: string,
	invoiceId: string,
	paymentId: string,
	today: Day,
): Promise<Result> {
	const invoice = await findInvoice(scope, invoiceId);
	if (!invoice) return null;
	const [payment] = await scope.payments.select(
		(p) => and(eq(p.id, paymentId), eq(p.invoiceId, invoiceId)),
		{ limit: 1 },
	);
	if (!payment) return null;
	const items: BatchItem<"sqlite">[] = [
		scope.payments.statements.delete((p) => eq(p.id, paymentId)).query,
		settleStatement(scope, invoiceId),
		...retainerStatements(scope, invoice, today),
	];
	if (payment.note === DRAWN_FROM_RETAINER) {
		const [draw] = await scope.retainerMovements.select(
			(m) =>
				and(eq(m.invoiceId, invoiceId), eq(m.kind, "draw"), eq(m.amountMinor, payment.amountMinor)),
			{ orderBy: (m) => [desc(m.createdAt)], limit: 1 },
		);
		if (draw) {
			items.push(scope.retainerMovements.statements.delete((m) => eq(m.id, draw.id)).query);
			items.push(balanceStatement(scope, draw.retainerId));
		}
	}
	items.push(
		recordStatement(
			scope,
			actor,
			"payment.deleted",
			{ type: "payment", id: paymentId },
			{
				before: { invoice: invoice.number, kind: payment.kind, amountMinor: payment.amountMinor },
			},
		).query,
	);
	try {
		await inOneBatch(items);
	} catch (error) {
		if (String(error).includes("retainers_balance_not_negative")) {
			return {
				ok: false,
				problem:
					"That payment funded a retainer that has since been drawn on, so it cannot be deleted.",
			};
		}
		throw error;
	}
	return { ok: true, id: invoiceId };
}

/** The lines of `invoiceIds` with the ids of what each bills for. */
export async function sourcesOfLines(scope: OrganisationScope, lineIds: readonly string[]) {
	if (lineIds.length === 0) return [];
	return scope.invoiceLineSources.select((s) => among(s.lineId, lineIds));
}
