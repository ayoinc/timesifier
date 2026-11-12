import { env } from "cloudflare:workers";
import type { RouterContextProvider } from "react-router";

import { type OrganisationScope, organisationScope } from "~/db";
import { type Membership, membershipContext } from "~/organisations/membership.server";
import { organisationMoney } from "~/projects/money.server";
import { negotiateLocale } from "~/shell/locale";
import { type Day, dayOf } from "~/time/calendar";

/**
 * What every page of Invoices and Estimates reads first: the membership the
 * organisation layout checked, the organisation's scope, its currency, the
 * day it is in its time zone, and the locale amounts are written in, chosen
 * from the request as the root loader chooses it.
 */
export interface Billing {
	membership: Membership;
	scope: OrganisationScope;
	organisation: { name: string; slug: string; timeZone: string; currency: string };
	now: number;
	today: Day;
	locale: string;
}

export async function billingOf(
	context: Readonly<RouterContextProvider>,
	request: Request,
): Promise<Billing> {
	const membership = context.get(membershipContext);
	const { organisation } = membership;
	const { currency } = await organisationMoney(organisation.id);
	const now = Date.now();
	return {
		membership,
		scope: organisationScope(env.DB, organisation.id),
		organisation: {
			name: organisation.name,
			slug: organisation.slug,
			timeZone: organisation.timeZone,
			currency,
		},
		now,
		today: dayOf(now, organisation.timeZone),
		locale: negotiateLocale(request.headers.get("Accept-Language")),
	};
}
