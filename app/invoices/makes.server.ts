import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { type OrganisationScope, organisations } from "~/db";
import { hasClients, WorkModel } from "~/workspace/work-model";

/**
 * Under Internal work nothing is billed (TS-115a, decision 67): the invoices
 * and estimates an organisation already holds stay reachable, and no new one
 * is made, by a person, a recurring invoice, a retainer or an estimate.
 */
export const NOTHING_BILLED_INTERNALLY =
	"Under Internal work nothing is billed, so no new invoice or estimate is made.";

/** Whether the organisation of `scope` makes new invoices and estimates: it has clients. */
export async function makesBilling(scope: OrganisationScope): Promise<boolean> {
	const [organisation] = await drizzle(env.DB)
		.select({ workModel: organisations.workModel })
		.from(organisations)
		.where(eq(organisations.id, scope.organisationId))
		.limit(1);
	return hasClients(WorkModel.catch("client_projects").parse(organisation?.workModel));
}
