import { env } from "cloudflare:workers";
import { and, eq, isNotNull, ne } from "drizzle-orm";

import { among, organisationScope, platformData } from "~/db";
import { deleteReceipt } from "~/expenses/receipts.server";

// Deleting an account on request (TS-099, docs/decisions.md entry 36). The
// line drawn is between the person's own data and the records of the
// organisations they worked in:
//
// - The person's own data goes: their name and address (the `users` row
//   stays, as "Deleted person", under an address that identifies nobody),
//   every session, their sign-in history, their mail choices, their
//   memberships and what hangs on a membership (leave, team places, saved
//   reports, calendar feeds, work requests), and the invitations they sent.
// - An organisation's records stay: time entries and expenses keep their
//   `user_id` and amounts, so reports, invoices and payroll exports still add
//   up, under "Deleted person".
// - Receipts are the exception among those records: a photograph of a
//   receipt may show the person's card, name or address. Each receipt of the
//   person's expenses is deleted, from the bucket and from its expense,
//   unless the expense is on an invoice that was issued (sent, paid or void),
//   which is a financial record the organisation must keep whole.
// - An organisation the person was alone in goes with them, receipts first.
// - Nothing happens while they are the only owner of an organisation with
//   other members: someone else must be made an owner first (TS-021a).

export type Deleted =
	| { ok: true; receiptsDeleted: number; organisationsDeleted: number }
	| { ok: false; blocking: { id: string; name: string }[] };

/** Deletes the receipts of `userId`'s expenses in one organisation that no issued invoice holds. Answers how many. */
async function deletePersonReceipts(organisationId: string, userId: string): Promise<number> {
	const scope = organisationScope(env.DB, organisationId);
	const expenses = await scope.expenses.select((e) =>
		and(eq(e.userId, userId), isNotNull(e.receiptKey)),
	);
	if (expenses.length === 0) return 0;
	const ids = expenses.map((e) => e.id);
	const sources = await scope.invoiceLineSources.select((s) => among(s.expenseId, ids));
	const lineIds = [...new Set(sources.map((s) => s.lineId))];
	const lines =
		lineIds.length === 0 ? [] : await scope.invoiceLines.select((l) => among(l.id, lineIds));
	const invoiceIds = [...new Set(lines.map((l) => l.invoiceId))];
	const issued = new Set(
		invoiceIds.length === 0
			? []
			: (
					await scope.invoices.select((i) => and(among(i.id, invoiceIds), ne(i.status, "draft")))
				).map((i) => i.id),
	);
	const issuedLines = new Set(lines.filter((l) => issued.has(l.invoiceId)).map((l) => l.id));
	const kept = new Set(
		sources
			.filter((s) => issuedLines.has(s.lineId))
			.flatMap((s) => (s.expenseId ? [s.expenseId] : [])),
	);
	const going = ids.filter((id) => !kept.has(id));
	for (const id of going) await deleteReceipt(organisationId, id);
	if (going.length > 0) {
		await scope.expenses.update(
			{ receiptKey: null, receiptName: null, receiptType: null, updatedAt: new Date() },
			(e) => among(e.id, going),
		);
	}
	return going.length;
}

export async function deletePersonAccount(userId: string): Promise<Deleted> {
	const { blocking, alone } = await platformData.organisationsLeftWithoutOwner(env.DB, userId);
	if (blocking.length > 0) return { ok: false, blocking };
	const memberOf = await platformData.membershipOrganisations(env.DB, userId);
	let receiptsDeleted = 0;
	for (const organisationId of memberOf) {
		receiptsDeleted += await deletePersonReceipts(organisationId, userId);
	}
	const deleted = await platformData.deleteAccount(env.DB, userId);
	if (!deleted.ok) return deleted;
	return { ok: true, receiptsDeleted, organisationsDeleted: alone.length };
}
