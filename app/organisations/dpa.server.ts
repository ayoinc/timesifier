import { env } from "cloudflare:workers";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { record } from "~/activity/activity.server";
import { organisationScope, organisations } from "~/db";
import { DPA_VERSION } from "~/landing/trust";

// The data processing agreement an organisation's owner accepted (TS-105,
// docs/decisions.md entry 60). The only code that writes the three columns.
// An owner accepts it when they create the organisation (the gate in
// `app/auth/organisations.server.ts` refuses a creation that does not name this
// version), or, for an organisation that holds another version or none, once in
// Workspace settings. Nothing waits on it: work goes on either way.

/** Whether the organisation's owners have yet to accept this version. */
export async function dpaToAccept(organisationId: string): Promise<boolean> {
	const [row] = await drizzle(env.DB)
		.select({ version: organisations.dpaVersion })
		.from(organisations)
		.where(eq(organisations.id, organisationId));
	return row?.version !== DPA_VERSION.date;
}

/**
 * Records that `userId`, an owner, accepted this version for the organisation,
 * and says so in its activity log. Only while it holds another version or
 * none: of two owners accepting at once, one is recorded. Whether this
 * acceptance was the one recorded.
 */
export async function acceptDpa(
	organisationId: string,
	userId: string,
	now: Date,
): Promise<boolean> {
	const accepted = await drizzle(env.DB)
		.update(organisations)
		.set({
			dpaVersion: DPA_VERSION.date,
			dpaAcceptedAt: now,
			dpaAcceptedBy: userId,
			updatedAt: now,
		})
		.where(
			and(
				eq(organisations.id, organisationId),
				or(isNull(organisations.dpaVersion), ne(organisations.dpaVersion, DPA_VERSION.date)),
			),
		)
		.returning({ id: organisations.id });
	if (accepted.length === 0) return false;
	await record(
		organisationScope(env.DB, organisationId),
		userId,
		"dpa.accepted",
		{ type: "organisation", id: organisationId, ownerId: null },
		{ after: { dpaVersion: DPA_VERSION.date } },
	);
	return true;
}
