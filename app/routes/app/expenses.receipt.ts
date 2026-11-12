import { env } from "cloudflare:workers";

import { organisationScope } from "~/db";
import { findExpense } from "~/expenses/expenses.server";
import { EXPENSE_PARAM } from "~/expenses/paths";
import { getReceipt } from "~/expenses/receipts.server";
import { maySeeExpensesOf } from "~/organisations/access";
import { accessOf } from "~/organisations/access.server";
import { membershipContext, notFound } from "~/organisations/membership.server";

import type { Route } from "./+types/expenses.receipt";

// An expense's receipt (TS-070; docs/security.md, "Receipts"), below Expenses,
// so the organisation layout answers 404 to anybody who is not a member. Here
// the expense is looked up in this organisation alone, and it is served only to
// a person who may see its person's expenses: their own, their managers', and
// owners', admins' and Finance's. Anybody else, and an expense with no receipt
// or none at all, gets the same 404. The file's key is built from the row.

export async function loader({ params, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const { organisation } = membership;
	const expense = await findExpense(
		organisationScope(env.DB, organisation.id),
		params[EXPENSE_PARAM],
	);
	if (!expense || expense.receiptKey === null || expense.receiptType === null) throw notFound();
	if (!maySeeExpensesOf(await accessOf(membership), expense.userId)) throw notFound();
	const file = await getReceipt(organisation.id, expense.id);
	if (!file) throw notFound();

	const name = expense.receiptName ?? "receipt";
	// A plain-ASCII name for old browsers, and the name as it was for the rest.
	const ascii = name.replace(/[^\x20-\x7e]/g, "_");
	return new Response(file.body, {
		headers: {
			"Content-Type": expense.receiptType,
			"Content-Length": String(file.size),
			"Content-Disposition": `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
			"Cache-Control": "private, no-store",
		},
	});
}
