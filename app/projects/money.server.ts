import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { BillingType } from "~/billing/billable";
import { type OrganisationScope, organisations } from "~/db";
import type { PricedProject, RateMode } from "~/rates/price";
import type { RateRow } from "~/rates/rates";

/**
 * What pricing an organisation's time reads from the database (TS-067): its
 * currency and budget setting, each project as `priceTime` takes it, and its
 * billable rates. A project's currency is its own, else its client's, else
 * the organisation's (B5). Values the Worker did not write are read safely:
 * an unknown billing type or rate mode is taken as the default.
 */

/** The organisation's money settings. */
export interface OrganisationMoney {
	currency: string;
	/** Whether non-billable time counts against hour budgets (B7). */
	budgetCountsNonBillable: boolean;
}

export async function organisationMoney(organisationId: string): Promise<OrganisationMoney> {
	const [row] = await drizzle(env.DB)
		.select({
			currency: organisations.currency,
			budgetCountsNonBillable: organisations.budgetCountsNonBillable,
		})
		.from(organisations)
		.where(eq(organisations.id, organisationId))
		.limit(1);
	return row ?? { currency: "GBP", budgetCountsNonBillable: true };
}

const RATE_MODES: readonly RateMode[] = ["project", "person", "task"];

/** A billing type as stored, or `hourly` for a value the Worker never writes. */
export function billingTypeOf(stored: string): BillingType {
	const parsed = BillingType.safeParse(stored);
	return parsed.success ? parsed.data : "hourly";
}

/** A rate mode as stored, or `project` for a value the Worker never writes. */
export function rateModeOf(stored: string): RateMode {
	return (RATE_MODES as readonly string[]).includes(stored) ? (stored as RateMode) : "project";
}

/** A project row as pricing needs it, with the currency it bills in. */
export function pricedProject(
	project: { id: string; billingType: string; rateMode: string; currency: string | null },
	clientCurrency: string | null,
	organisationCurrency: string,
): PricedProject {
	return {
		id: project.id,
		billingType: billingTypeOf(project.billingType),
		rateMode: rateModeOf(project.rateMode),
		currency: project.currency ?? clientCurrency ?? organisationCurrency,
	};
}

/** Every project of the organisation, priced, by id; and every billable rate. */
export interface Pricing {
	projects: Map<string, PricedProject>;
	rates: RateRow[];
}

export async function pricingOf(
	scope: OrganisationScope,
	organisationCurrency: string,
): Promise<Pricing> {
	const [projects, clients, rates] = await Promise.all([
		scope.projects.select(),
		scope.clients.select(),
		scope.rates.select((r) => eq(r.kind, "billable")),
	]);
	const clientCurrency = new Map(clients.map((c) => [c.id, c.currency]));
	return {
		projects: new Map(
			projects.map((p) => [
				p.id,
				pricedProject(
					p,
					p.clientId ? (clientCurrency.get(p.clientId) ?? null) : null,
					organisationCurrency,
				),
			]),
		),
		rates: rates.map((r) => ({
			kind: "billable",
			userId: r.userId,
			projectId: r.projectId,
			taskId: r.taskId,
			amountMinor: r.amountMinor,
			currency: r.currency,
			effectiveFrom: r.effectiveFrom,
		})),
	};
}
