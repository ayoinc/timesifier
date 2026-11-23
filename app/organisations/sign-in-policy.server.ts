import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { record } from "~/activity/activity.server";
import { configuredProviders, PROVIDER_NAMES } from "~/auth/providers";
import { organisationScope, organisations } from "~/db";
import { isAdministrator } from "./access";
import type { Membership } from "./membership.server";
import {
	type ChosenPolicy,
	isExempt,
	meetsPolicy,
	policyColumns,
	policySummary,
	policyWords,
	type SessionMethod,
	samePolicy,
	TENANT_LABELS,
} from "./sign-in-policy";

export type PolicyOutcome = { ok: true; said: string } | { ok: false; problem: string };

/**
 * Changes the organisation's sign-in policy (TS-104 slice 104b), for an owner
 * or an admin, and records the change in its activity log, before and after.
 *
 * - A provider this deployment does not offer cannot be required: nobody but
 *   the owners could open the organisation.
 * - The person changing it cannot lock themselves out: an admin, who is held
 *   to the policy, must be signed in with a session it takes. Owners are
 *   exempt, so they may require a provider they have not signed in with.
 */
export async function changeSignInPolicy(
	membership: Membership,
	session: SessionMethod,
	next: ChosenPolicy,
): Promise<PolicyOutcome> {
	const { organisation, role, user } = membership;
	if (!isAdministrator(role)) {
		return { ok: false, problem: "Only owners and admins change how people sign in." };
	}
	const current = organisation.signIn;
	if (samePolicy(current, next)) return { ok: true, said: policyWords(next) };
	if (next.kind === "company") {
		const name = PROVIDER_NAMES[next.provider];
		if (!configuredProviders(env).includes(next.provider)) {
			return {
				ok: false,
				problem: `${name} sign-in isn't available on this site, so nobody could sign in with it.`,
			};
		}
		if (!isExempt(role) && !meetsPolicy(next, session)) {
			return {
				ok: false,
				problem:
					next.tenant === null
						? `Sign in with ${name} yourself first: you'd be locked out of ${organisation.name}.`
						: `Sign in with ${name} at ${TENANT_LABELS[next.provider]} ${next.tenant} yourself first: you'd be locked out of ${organisation.name}.`,
			};
		}
	}
	await drizzle(env.DB)
		.update(organisations)
		.set(policyColumns(next))
		.where(eq(organisations.id, organisation.id));
	await record(
		organisationScope(env.DB, organisation.id),
		user.id,
		"sign_in_policy.changed",
		{ type: "organisation", id: organisation.id, ownerId: null },
		{ before: policySummary(current), after: policySummary(next) },
	);
	return { ok: true, said: policyWords(next) };
}
