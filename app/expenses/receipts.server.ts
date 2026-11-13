import { env } from "cloudflare:workers";

import {
	isReceiptType,
	looksLike,
	RECEIPT_MAX_BYTES,
	RECEIPT_PROBLEM,
	type ReceiptType,
} from "./expenses";

/**
 * Receipts in R2 (TS-070, B9; docs/security.md, "Receipts"). The only code
 * that uses the `RECEIPTS` binding. A key is built here from the organisation
 * and the expense, never taken from a request, so one organisation's receipt
 * cannot be named from another's.
 */

/** Where every receipt of `organisationId` is kept: the prefix of each of its keys. */
export function receiptPrefix(organisationId: string): string {
	return `org/${organisationId}/receipts/`;
}

/** Where the receipt of `expenseId` in `organisationId` is kept. */
export function receiptKey(organisationId: string, expenseId: string): string {
	return `${receiptPrefix(organisationId)}${expenseId}`;
}

/** A receipt that has been checked and read, ready to be stored. */
export interface CheckedReceipt {
	name: string;
	type: ReceiptType;
	bytes: Uint8Array;
}

/** The longest file name kept, after unsafe characters are removed. */
const NAME_MAX_LENGTH = 120;

/**
 * The file's name as it is kept and later offered: its last path part, with
 * control characters, quotes and the characters a header or a path would
 * read as its own removed. Never empty.
 */
function cleanName(name: string): string {
	const last = name.split(/[\\/]/).at(-1) ?? "";
	const clean = last
		.replace(/[\p{Cc}"\\;]/gu, "")
		.trim()
		.slice(0, NAME_MAX_LENGTH);
	return clean || "receipt";
}

/**
 * The uploaded file checked: a PDF, PNG or JPEG by its first bytes and by the
 * type the browser gave, of at most 10 MB. A file input left empty sends an
 * empty file with no name: that is no receipt, and null. A file refused is
 * the sentence to tell the person.
 */
export async function checkReceipt(
	file: File | null | undefined,
): Promise<{ ok: true; receipt: CheckedReceipt | null } | { ok: false; problem: string }> {
	if (!file || (file.size === 0 && file.name === "")) return { ok: true, receipt: null };
	if (file.size === 0 || file.size > RECEIPT_MAX_BYTES)
		return { ok: false, problem: RECEIPT_PROBLEM };
	const type = file.type.toLowerCase();
	if (!isReceiptType(type)) return { ok: false, problem: RECEIPT_PROBLEM };
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (!looksLike(type, bytes)) return { ok: false, problem: RECEIPT_PROBLEM };
	return { ok: true, receipt: { name: cleanName(file.name), type, bytes } };
}

/** Stores `receipt` as the receipt of `expenseId`, replacing any before it. */
export async function putReceipt(
	organisationId: string,
	expenseId: string,
	receipt: CheckedReceipt,
): Promise<void> {
	await env.RECEIPTS.put(receiptKey(organisationId, expenseId), receipt.bytes, {
		httpMetadata: { contentType: receipt.type },
	});
}

/** The stored receipt of `expenseId`, or null when there is none. */
export function getReceipt(organisationId: string, expenseId: string) {
	return env.RECEIPTS.get(receiptKey(organisationId, expenseId));
}

/** Removes the receipt of `expenseId`, if there is one. */
export async function deleteReceipt(organisationId: string, expenseId: string): Promise<void> {
	await env.RECEIPTS.delete(receiptKey(organisationId, expenseId));
}

/**
 * Removes every receipt of `organisationId`, a page of keys at a time (R2
 * lists at most 1,000 keys a call and deletes at most 1,000 a call). Run
 * before the organisation's row goes, so a failure, which throws, leaves the
 * organisation in place for a retry to finish (docs/security.md, "Receipts").
 */
export async function deleteOrganisationReceipts(organisationId: string): Promise<void> {
	const prefix = receiptPrefix(organisationId);
	let cursor: string | undefined;
	do {
		const page = await env.RECEIPTS.list({ prefix, cursor });
		if (page.objects.length > 0) await env.RECEIPTS.delete(page.objects.map(({ key }) => key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}
