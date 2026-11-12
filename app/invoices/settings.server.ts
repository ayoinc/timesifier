import { eq, isNull } from "drizzle-orm";

import { type OrganisationScope, uuidv7 } from "~/db";

import { ensureInvoiceSettings, type InvoiceDetails } from "./documents.server";
import type { Result } from "./invoices.server";

/**
 * The organisation's invoicing settings (TS-074): its legal name, address and
 * tax number, default payment terms and notes, late reminders, and its taxes,
 * at most two of them active, each simple or compound.
 */

/** The most taxes active at once: a line bears at most two. */
export const MOST_ACTIVE_TAXES = 2;

/** Saves the organisation's invoicing details. */
export async function saveInvoiceDetails(
	scope: OrganisationScope,
	details: InvoiceDetails,
): Promise<void> {
	await ensureInvoiceSettings(scope);
	await scope.invoiceSettings.update({ ...details, updatedAt: new Date() }, (s) =>
		eq(s.organisationId, scope.organisationId),
	);
}

/** A tax as a person sets it. */
export interface TaxInput {
	name: string;
	rateBasisPoints: number;
	compound: boolean;
}

export const TOO_MANY_TAXES = `An organisation has at most ${MOST_ACTIVE_TAXES} taxes at once. Archive one first.`;

/** Adds a tax, refused when two are active already. */
export async function addTax(scope: OrganisationScope, tax: TaxInput): Promise<Result> {
	const active = await scope.taxes.select((t) => isNull(t.archivedAt));
	if (active.length >= MOST_ACTIVE_TAXES) return { ok: false, problem: TOO_MANY_TAXES };
	const id = uuidv7();
	await scope.taxes.insert({ id, ...tax });
	return { ok: true, id };
}

/**
 * Changes a tax's name, rate or kind. Invoices already issued keep their
 * totals, which are stored; drafts take the new rate the next time they change.
 */
export async function changeTax(
	scope: OrganisationScope,
	id: string,
	tax: TaxInput,
): Promise<Result> {
	const changed = await scope.taxes.update({ ...tax, updatedAt: new Date() }, (t) => eq(t.id, id));
	return changed.length > 0 ? { ok: true, id } : null;
}

/** Archives or restores a tax. It is never deleted: issued invoices name it. */
export async function setTaxArchived(
	scope: OrganisationScope,
	id: string,
	archived: boolean,
): Promise<Result> {
	if (!archived) {
		const active = await scope.taxes.select((t) => isNull(t.archivedAt));
		if (active.length >= MOST_ACTIVE_TAXES) return { ok: false, problem: TOO_MANY_TAXES };
	}
	const changed = await scope.taxes.update({ archivedAt: archived ? new Date() : null }, (t) =>
		eq(t.id, id),
	);
	return changed.length > 0 ? { ok: true, id } : null;
}
