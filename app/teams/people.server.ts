import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";

import { among, type OrganisationScope, users } from "~/db";
import { type Access, timeScopeOf } from "~/organisations/access";
import { addressLine, nameOrEmail } from "~/organisations/people";
import { zoneOf } from "~/time/zones";

/**
 * The members of an organisation as Team and Approvals list them: each with
 * the name they are shown by and the zone their days are counted in. The
 * memberships come through the organisation's scope; only then are the
 * accounts of those people read.
 */

export interface Person {
	id: string;
	/** Their name, or their address when they have given none (`nameOrEmail`). */
	name: string;
	email: string;
	/** Their address, shown under `name` when they have given no name; null when they have. */
	address: string | null;
	/** The zone their days and periods are counted in. */
	timeZone: string;
}

/**
 * The members of the organisation, or those of them among `only`, sorted by
 * the name they are shown by. A person in `only` who is not a member is left out.
 */
export async function peopleOf(
	scope: OrganisationScope,
	organisation: { timeZone: string },
	only?: Iterable<string>,
): Promise<Person[]> {
	const wanted = only === undefined ? undefined : [...new Set(only)];
	if (wanted?.length === 0) return [];
	const memberships = await scope.memberships.select((m) =>
		wanted ? among(m.userId, wanted) : undefined,
	);
	const ids = memberships.map((m) => m.userId);
	if (ids.length === 0) return [];
	const accounts = await drizzle(env.DB)
		.select({ id: users.id, name: users.name, email: users.email, timeZone: users.timeZone })
		.from(users)
		.where(among(users.id, ids));
	return accounts
		.map((account) => ({
			id: account.id,
			name: nameOrEmail(account),
			email: account.email,
			address: addressLine(account),
			timeZone: zoneOf(account, organisation),
		}))
		.sort((a, b) => a.name.localeCompare(b.name, "en") || a.email.localeCompare(b.email));
}

/**
 * The people whose week `access` is shown on Team: everyone for an owner or
 * admin, the members of the teams they manage for a manager, none otherwise.
 */
export function teamPeopleOf(
	scope: OrganisationScope,
	organisation: { timeZone: string },
	access: Access,
): Promise<Person[]> {
	if (timeScopeOf(access).everyone) return peopleOf(scope, organisation);
	return peopleOf(scope, organisation, access.managed);
}
