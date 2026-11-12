import { and, asc, desc, eq, isNull } from "drizzle-orm";

import { recordStatement } from "~/activity/activity.server";
import { type OrganisationScope, uuidv7 } from "~/db";
import type { Day } from "~/time/calendar";

import { inOneBatch } from "./documents.server";
import {
	balanceStatement,
	createDraft,
	DRAWN_FROM_RETAINER,
	findInvoice,
	linesOf,
	type Result,
	settledOf,
	settleStatement,
} from "./invoices.server";
import { balanceOf, OWING } from "./status";

/**
 * Retainers (TS-078): money a client pays ahead, held for them, per client or
 * per client and project. A funds invoice (`invoices.retainer_id`) adds its
 * total once it is paid; drawing pays part or all of a time invoice from the
 * balance. The balance is the sum of the movements and never below 0: the
 * table refuses it (`retainers_balance_not_negative`), and a draw is never
 * more than the balance or than the invoice owes.
 */

/** The retainers of the organisation, with their clients' names. */
export async function retainersOf(scope: OrganisationScope) {
	const [rows, clients, projects] = await Promise.all([
		scope.retainers.select(undefined, { orderBy: (r) => [asc(r.createdAt)] }),
		scope.clients.select(),
		scope.projects.select(),
	]);
	const clientName = new Map(clients.map((c) => [c.id, c.name]));
	const projectName = new Map(projects.map((p) => [p.id, p.name]));
	return rows.map((row) => ({
		...row,
		clientName: clientName.get(row.clientId) ?? "",
		projectName: row.projectId ? (projectName.get(row.projectId) ?? "") : null,
	}));
}

/** A retainer's movements, newest first. */
export function movementsOf(scope: OrganisationScope, retainerId: string) {
	return scope.retainerMovements.select((m) => eq(m.retainerId, retainerId), {
		orderBy: (m) => [desc(m.occurredOn), desc(m.createdAt)],
	});
}

export const RETAINER_EXISTS =
	"That client already has a retainer for that project, or for all its work.";

/** Opens a retainer for a client, or for one of its projects, in the currency it is paid in. */
export async function openRetainer(
	scope: OrganisationScope,
	clientId: string,
	projectId: string | null,
	currency: string,
): Promise<Result> {
	const [client] = await scope.clients.select(
		(c) => and(eq(c.id, clientId), isNull(c.archivedAt)),
		{
			limit: 1,
		},
	);
	if (!client) return { ok: false, problem: "Choose an active client." };
	if (projectId) {
		const [project] = await scope.projects.select(
			(p) => and(eq(p.id, projectId), eq(p.clientId, clientId)),
			{ limit: 1 },
		);
		if (!project) return { ok: false, problem: "Choose one of that client's projects, or none." };
	}
	const held = await scope.retainers.select((r) =>
		and(eq(r.clientId, clientId), projectId ? eq(r.projectId, projectId) : isNull(r.projectId)),
	);
	if (held.length > 0) return { ok: false, problem: RETAINER_EXISTS };
	const [row] = await scope.retainers.insert({ clientId, projectId, currency });
	return row ? { ok: true, id: row.id } : { ok: false, problem: RETAINER_EXISTS };
}

/** Makes a draft funds invoice for `amountMinor`, which adds to the retainer once it is paid. */
export async function invoiceFunds(
	scope: OrganisationScope,
	actor: string,
	retainerId: string,
	amountMinor: number,
	today: Day,
): Promise<Result> {
	const [retainer] = await scope.retainers.select((r) => eq(r.id, retainerId), { limit: 1 });
	if (!retainer) return null;
	return createDraft(scope, actor, {
		clientId: retainer.clientId,
		currency: retainer.currency,
		issuedOn: today,
		retainerId,
		subject: "Retainer funds",
		taxIds: [null, null],
		lines: [
			{
				kind: "manual",
				description: "Retainer funds",
				projectId: retainer.projectId,
				quantityMilli: 1000,
				unitPriceMinor: amountMinor,
				amountMinor,
				timeEntryIds: [],
				expenseIds: [],
			},
		],
	});
}

/** The retainers an issued invoice may draw from: its client's, in its currency, for all work or a project on it. */
export async function retainersFor(scope: OrganisationScope, invoiceId: string) {
	const invoice = await findInvoice(scope, invoiceId);
	if (!invoice || invoice.retainerId) return [];
	const projects = new Set((await linesOf(scope, invoiceId)).map((l) => l.projectId));
	const rows = await scope.retainers.select((r) =>
		and(eq(r.clientId, invoice.clientId), eq(r.currency, invoice.currency)),
	);
	return rows.filter((r) => r.projectId === null || projects.has(r.projectId));
}

export const MORE_THAN_RETAINED = "That is more than the retainer holds or the invoice owes.";

/**
 * Pays `amountMinor` of an issued invoice from a retainer: a draw on the
 * retainer and a payment on the invoice, in one batch, refused when it is
 * more than either holds.
 */
export async function drawFromRetainer(
	scope: OrganisationScope,
	actor: string,
	invoiceId: string,
	retainerId: string,
	amountMinor: number,
	today: Day,
): Promise<Result> {
	const invoice = await findInvoice(scope, invoiceId);
	if (!invoice) return null;
	if (!OWING.includes(invoice.status as never)) {
		return {
			ok: false,
			problem: "Only an issued invoice that is owed something draws from a retainer.",
		};
	}
	const retainer = (await retainersFor(scope, invoiceId)).find((r) => r.id === retainerId);
	if (!retainer)
		return { ok: false, problem: "Choose a retainer of this invoice's client and currency." };
	const settled = (await settledOf(scope, [invoiceId])).get(invoiceId) ?? {
		paidMinor: 0,
		writtenOffMinor: 0,
	};
	if (amountMinor > Math.min(retainer.balanceMinor, balanceOf(invoice.totalMinor, settled))) {
		return { ok: false, problem: MORE_THAN_RETAINED };
	}
	const paymentId = uuidv7();
	try {
		await inOneBatch([
			scope.retainerMovements.statements.insert({
				retainerId,
				kind: "draw",
				amountMinor,
				invoiceId,
				occurredOn: today,
			}).query,
			balanceStatement(scope, retainerId),
			scope.payments.statements.insert({
				id: paymentId,
				invoiceId,
				kind: "payment",
				amountMinor,
				paidOn: today,
				method: "other",
				note: DRAWN_FROM_RETAINER,
				recordedBy: actor,
			}).query,
			settleStatement(scope, invoiceId),
			recordStatement(
				scope,
				actor,
				"payment.recorded",
				{ type: "payment", id: paymentId },
				{
					after: { invoice: invoice.number, kind: "retainer", amountMinor },
				},
			).query,
		]);
	} catch (error) {
		const said = String(error);
		if (said.includes("retainers_balance_not_negative") || said.includes("a payment is at most")) {
			return { ok: false, problem: MORE_THAN_RETAINED };
		}
		throw error;
	}
	return { ok: true, id: invoiceId };
}

/**
 * A retainer's balance after `movements`, applied in order, each refused
 * (left out) when it would take the balance below 0: the rule the table
 * holds, as a function a property test can drive.
 */
export function balanceAfter(
	movements: readonly { kind: "deposit" | "draw"; amountMinor: number }[],
): { balanceMinor: number; refused: number } {
	let balanceMinor = 0;
	let refused = 0;
	for (const { kind, amountMinor } of movements) {
		if (kind === "deposit") balanceMinor += amountMinor;
		else if (amountMinor <= balanceMinor) balanceMinor -= amountMinor;
		else refused++;
	}
	return { balanceMinor, refused };
}
