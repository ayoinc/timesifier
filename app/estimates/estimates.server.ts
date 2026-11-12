import { env } from "cloudflare:workers";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import * as z from "zod";

import { recordStatement, recordStatementWhen } from "~/activity/activity.server";
import { isKeyedHash, keyedHash } from "~/auth/keyed-hash.server";
import { type OrganisationScope, type TenantRow, uuidv7 } from "~/db";
import {
	ensureInvoiceSettings,
	inOneBatch,
	invoiceDetailsOf,
	nextNumber,
	printedDocument,
	raiseSequence,
	storedTotals,
	taxesOf,
	totalsOf,
} from "~/invoices/documents.server";
import { createDraft, type LineInput, type Result } from "~/invoices/invoices.server";
import type { PrintedDocument } from "~/invoices/pdf";
import { required } from "~/lib/deployment";
import { nameKey } from "~/lib/names";
import { lineAmount } from "~/money/money";
import type { Day } from "~/time/calendar";
import { formatDayWithYear } from "~/time/format";

/**
 * Estimates (TS-077): a quote to a client, priced with the same arithmetic as
 * an invoice (`totalsOf`), numbered from its own sequence. It is sent with a
 * secret link on which the client accepts or declines it without signing in;
 * the decision is recorded once. An owner, admin or Finance may record the
 * decision themselves or take it back. An accepted estimate becomes a draft
 * invoice with the same lines, and may start a fixed-fee project.
 */

export const EstimateStatus = z.enum(["draft", "sent", "accepted", "declined"]);
export type EstimateStatus = z.infer<typeof EstimateStatus>;

export const ESTIMATE_LABELS: Record<EstimateStatus, string> = {
	draft: "Draft",
	sent: "Sent",
	accepted: "Accepted",
	declined: "Declined",
};

export type EstimateRow = TenantRow<"estimates">;

export const DECIDED =
	"That estimate has been decided, so it is fixed. Revert the decision to change it.";

/** The estimate of this organisation with this id, or null. */
export async function findEstimate(scope: OrganisationScope, id: string) {
	const [row] = await scope.estimates.select((e) => eq(e.id, id), { limit: 1 });
	return row ?? null;
}

/** An estimate's lines, in order. */
export function estimateLinesOf(scope: OrganisationScope, id: string) {
	return scope.estimateLines.select((l) => eq(l.estimateId, id), {
		orderBy: (l) => [asc(l.position)],
	});
}

/** The organisation's estimates with their clients' names, newest first. */
export async function listEstimates(scope: OrganisationScope) {
	const [rows, clients] = await Promise.all([
		scope.estimates.select(undefined, { orderBy: (e) => [desc(e.createdAt)] }),
		scope.clients.select(),
	]);
	const clientName = new Map(clients.map((c) => [c.id, c.name]));
	return rows.map((row) => ({ ...row, clientName: clientName.get(row.clientId) ?? "" }));
}

/** What a person sets on an estimate. */
export interface EstimateDetails {
	issuedOn: Day;
	poNumber: string | null;
	subject: string | null;
	notes: string | null;
	discountBasisPoints: number;
}

/** Starts an estimate for a client with the next number of the estimate sequence. */
export async function createEstimate(
	scope: OrganisationScope,
	actor: string,
	input: EstimateDetails & { clientId: string; currency: string },
): Promise<Result> {
	const [client] = await scope.clients.select(
		(c) => and(eq(c.id, input.clientId), isNull(c.archivedAt)),
		{ limit: 1 },
	);
	if (!client) return { ok: false, problem: "Choose an active client." };
	await ensureInvoiceSettings(scope);
	const id = uuidv7();
	await inOneBatch([
		scope.estimates.statements.insert({
			id,
			number: nextNumber(scope, "estimate"),
			status: "draft",
			...input,
		}).query,
		raiseSequence(scope, "estimate"),
		recordStatement(scope, actor, "estimate.created", { type: "estimate", id }).query,
	]);
	return { ok: true, id };
}

/** Refuses an estimate that has been decided. */
async function openEstimate(scope: OrganisationScope, id: string) {
	const estimate = await findEstimate(scope, id);
	if (!estimate) return null;
	if (estimate.status === "accepted" || estimate.status === "declined") {
		return { ok: false as const, problem: DECIDED };
	}
	return { ok: true as const, estimate };
}

/** The statement that stores an estimate's totals from its lines as they will stand. */
async function totalsStatement(
	scope: OrganisationScope,
	estimate: { id: string },
	discountBasisPoints: number,
	lines: readonly { amountMinor: number; taxId: string | null; secondTaxId: string | null }[],
) {
	const taxes = await taxesOf(scope);
	return scope.estimates.statements.update(
		storedTotals(totalsOf(lines, discountBasisPoints, taxes)),
		(e) => and(eq(e.id, estimate.id), inArray(e.status, ["draft", "sent"])),
	);
}

/** Changes an undecided estimate's details, and its totals with them. */
export async function changeEstimate(
	scope: OrganisationScope,
	actor: string,
	id: string,
	details: EstimateDetails,
): Promise<Result> {
	const found = await openEstimate(scope, id);
	if (!found?.ok) return found;
	const lines = await estimateLinesOf(scope, id);
	await scope.batch([
		scope.estimates.statements.update(details, (e) => eq(e.id, id)),
		await totalsStatement(scope, found.estimate, details.discountBasisPoints, lines),
		recordStatement(scope, actor, "estimate.updated", { type: "estimate", id }),
	]);
	return { ok: true, id };
}

/** Adds a line to an undecided estimate. */
export async function addEstimateLine(
	scope: OrganisationScope,
	actor: string,
	id: string,
	line: LineInput,
): Promise<Result> {
	const found = await openEstimate(scope, id);
	if (!found?.ok) return found;
	const lines = await estimateLinesOf(scope, id);
	const added = {
		...line,
		secondTaxId: line.taxId ? line.secondTaxId : null,
		amountMinor: lineAmount(line.quantityMilli, line.unitPriceMinor),
	};
	await scope.batch([
		scope.estimateLines.statements.insert({
			estimateId: id,
			position: (lines.at(-1)?.position ?? -1) + 1,
			...added,
		}),
		await totalsStatement(scope, found.estimate, found.estimate.discountBasisPoints, [
			...lines,
			added,
		]),
		recordStatement(
			scope,
			actor,
			"estimate.updated",
			{ type: "estimate", id },
			{
				after: { line: "added" },
			},
		),
	]);
	return { ok: true, id };
}

/** Removes a line of an undecided estimate. */
export async function removeEstimateLine(
	scope: OrganisationScope,
	actor: string,
	id: string,
	lineId: string,
): Promise<Result> {
	const found = await openEstimate(scope, id);
	if (!found?.ok) return found;
	const lines = await estimateLinesOf(scope, id);
	if (!lines.some((l) => l.id === lineId)) return null;
	await scope.batch([
		scope.estimateLines.statements.delete((l) => and(eq(l.id, lineId), eq(l.estimateId, id))),
		await totalsStatement(
			scope,
			found.estimate,
			found.estimate.discountBasisPoints,
			lines.filter((l) => l.id !== lineId),
		),
		recordStatement(scope, actor, "estimate.updated", { type: "estimate", id }),
	]);
	return { ok: true, id };
}

/** Deletes an estimate that has not become an invoice. */
export async function deleteEstimate(
	scope: OrganisationScope,
	actor: string,
	id: string,
): Promise<Result<{ number: string }>> {
	const estimate = await findEstimate(scope, id);
	if (!estimate) return null;
	if (estimate.invoiceId) {
		return { ok: false, problem: "That estimate has become an invoice, so it stays." };
	}
	await scope.batch([
		scope.estimateLines.statements.delete((l) => eq(l.estimateId, id)),
		scope.estimates.statements.delete((e) => eq(e.id, id)),
		recordStatement(
			scope,
			actor,
			"estimate.deleted",
			{ type: "estimate", id },
			{
				before: { number: estimate.number },
			},
		),
	]);
	return { ok: true, number: estimate.number };
}

/**
 * The statement that marks an estimate sent, when it is a draft; a sent one
 * stays sent with its first time. It goes in the batch that records the send.
 */
export function estimateSentStatement(scope: OrganisationScope, id: string, now: Date) {
	return scope.estimates.statements.update({ status: "sent", sentAt: now }, (e) =>
		and(eq(e.id, id), eq(e.status, "draft")),
	);
}

/** What a decision is. */
export type Decision = "accepted" | "declined";

/**
 * Records the client's decision on the link: once, while the estimate is
 * sent and undecided. A second answer changes nothing and says what the first
 * was.
 */
export async function decideByClient(
	scope: OrganisationScope,
	id: string,
	decision: Decision,
	now: Date,
): Promise<{ recorded: boolean; status: string; decidedAt: Date | null } | null> {
	// The record is written first, only while the estimate is still undecided,
	// so two answers at once record one decision.
	const [, changed] = await scope.batch([
		recordStatementWhen(
			scope,
			scope.estimates.exists((e) => and(eq(e.id, id), eq(e.status, "sent"))),
			null,
			decision === "accepted" ? "estimate.accepted" : "estimate.declined",
			{ type: "estimate", id },
			{ after: { by: "client" } },
			"system",
		),
		scope.estimates.statements.update({ status: decision, decidedAt: now }, (e) =>
			and(eq(e.id, id), eq(e.status, "sent")),
		),
	]);
	if (changed.length > 0) {
		return { recorded: true, status: decision, decidedAt: now };
	}
	const estimate = await findEstimate(scope, id);
	if (!estimate) return null;
	return { recorded: false, status: estimate.status, decidedAt: estimate.decidedAt };
}

/** Records a decision on the client's behalf, from draft or sent. */
export async function recordDecision(
	scope: OrganisationScope,
	actor: string,
	id: string,
	decision: Decision,
	now: Date,
): Promise<Result> {
	const found = await openEstimate(scope, id);
	if (!found?.ok) return found;
	await scope.batch([
		recordStatementWhen(
			scope,
			scope.estimates.exists((e) => and(eq(e.id, id), inArray(e.status, ["draft", "sent"]))),
			actor,
			decision === "accepted" ? "estimate.accepted" : "estimate.declined",
			{ type: "estimate", id },
		),
		scope.estimates.statements.update({ status: decision, decidedAt: now }, (e) =>
			and(eq(e.id, id), inArray(e.status, ["draft", "sent"])),
		),
	]);
	return { ok: true, id };
}

/** Takes a decision back: the estimate is sent and undecided again. Not once it has become an invoice. */
export async function revertDecision(
	scope: OrganisationScope,
	actor: string,
	id: string,
): Promise<Result> {
	const estimate = await findEstimate(scope, id);
	if (!estimate) return null;
	if (estimate.invoiceId) {
		return { ok: false, problem: "That estimate has become an invoice. Delete the draft first." };
	}
	if (estimate.status !== "accepted" && estimate.status !== "declined") {
		return { ok: false, problem: "That estimate has not been decided." };
	}
	await scope.batch([
		recordStatementWhen(
			scope,
			scope.estimates.exists((e) => and(eq(e.id, id), inArray(e.status, ["accepted", "declined"]))),
			actor,
			"estimate.updated",
			{ type: "estimate", id },
			{
				before: { status: estimate.status },
				after: { status: "sent" },
			},
		),
		scope.estimates.statements.update({ status: "sent", decidedAt: null }, (e) =>
			and(eq(e.id, id), inArray(e.status, ["accepted", "declined"])),
		),
	]);
	return { ok: true, id };
}

/** Makes a draft invoice with an accepted estimate's lines, taxes and discount, once. */
export async function invoiceEstimate(
	scope: OrganisationScope,
	actor: string,
	id: string,
	today: Day,
): Promise<Result> {
	const estimate = await findEstimate(scope, id);
	if (!estimate) return null;
	if (estimate.status !== "accepted") {
		return { ok: false, problem: "Only an accepted estimate becomes an invoice." };
	}
	if (estimate.invoiceId) return { ok: false, problem: "That estimate is an invoice already." };
	const lines = await estimateLinesOf(scope, id);
	const created = await createDraft(scope, actor, {
		clientId: estimate.clientId,
		currency: estimate.currency,
		issuedOn: today,
		subject: estimate.subject,
		notes: estimate.notes,
		poNumber: estimate.poNumber,
		discountBasisPoints: estimate.discountBasisPoints,
		estimateId: id,
		lines: lines.map((line) => ({
			kind: "manual",
			description: line.description,
			projectId: null,
			quantityMilli: line.quantityMilli,
			unitPriceMinor: line.unitPriceMinor,
			amountMinor: line.amountMinor,
			timeEntryIds: [],
			expenseIds: [],
		})),
		lineTaxes: lines.map((line) => [line.taxId, line.secondTaxId]),
	});
	if (!created.ok) return created;
	return { ok: true, id: created.id };
}

/**
 * Starts a fixed-fee project for the client from an accepted estimate, its
 * fee the estimate's total before tax. Its name is the estimate's subject, or
 * "Estimate <number>", with the number added when the name is taken.
 */
export async function projectFromEstimate(
	scope: OrganisationScope,
	actor: string,
	id: string,
): Promise<Result<{ name: string }>> {
	const estimate = await findEstimate(scope, id);
	if (!estimate) return null;
	if (estimate.status !== "accepted") {
		return { ok: false, problem: "Only an accepted estimate starts a project." };
	}
	const base = (estimate.subject ?? `Estimate ${estimate.number}`).slice(0, 100).trim();
	const projects = await scope.projects.select();
	const taken = new Set(projects.map((p) => p.nameKey));
	const name = taken.has(nameKey(base)) ? `${base} (${estimate.number})` : base;
	if (taken.has(nameKey(name))) {
		return { ok: false, problem: "A project with this estimate's name already exists." };
	}
	const projectId = uuidv7();
	await scope.batch([
		scope.projects.statements.insert({
			id: projectId,
			name,
			nameKey: nameKey(name),
			clientId: estimate.clientId,
			billingType: "fixed_fee",
			feeMinor: estimate.subtotalMinor - estimate.discountMinor,
			currency: estimate.currency,
		}),
		recordStatement(
			scope,
			actor,
			"project.created",
			{ type: "project", id: projectId },
			{
				after: { name, from: `estimate ${estimate.number}` },
			},
		),
	]);
	return { ok: true, name };
}

/** An estimate in words, for its page, its PDF and the client's link. */
export async function printedEstimate(
	scope: OrganisationScope,
	organisationName: string,
	estimate: EstimateRow,
	locale: string,
): Promise<PrintedDocument> {
	const [lines, taxes, details, [client]] = await Promise.all([
		estimateLinesOf(scope, estimate.id),
		taxesOf(scope),
		invoiceDetailsOf(scope),
		scope.clients.select((c) => eq(c.id, estimate.clientId), { limit: 1 }),
	]);
	const facts: [string, string][] = [["Issued", formatDayWithYear(estimate.issuedOn)]];
	if (estimate.poNumber) facts.push(["PO number", estimate.poNumber]);
	return printedDocument({
		title: "Estimate",
		number: estimate.number,
		organisationName,
		details,
		clientName: client?.name ?? "",
		facts,
		subject: estimate.subject,
		notes: estimate.notes,
		currency: estimate.currency,
		discountBasisPoints: estimate.discountBasisPoints,
		lines,
		taxes,
		locale,
	});
}

/** What the link's proof is made for, so it proves nothing anywhere else. */
const LINK_PURPOSE = "estimate-link";

/** The secret part of an estimate's link: a keyed hash of its id, which only this deployment can make. */
export function estimateToken(id: string): Promise<string> {
	return keyedHash(required(env, "BETTER_AUTH_SECRET"), LINK_PURPOSE, id);
}

/** Whether `token` is the secret part of the link of estimate `id`. */
export function isEstimateToken(id: string, token: string): Promise<boolean> {
	return isKeyedHash(required(env, "BETTER_AUTH_SECRET"), LINK_PURPOSE, id, token);
}
