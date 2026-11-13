import { env } from "cloudflare:workers";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { among, type OrganisationScope, users } from "~/db";
import { type Access, timeScopeOf } from "~/organisations/access";
import { addressLine, nameOrEmail } from "~/organisations/people";
import { Role } from "~/organisations/roles";
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

/** A membership as the Members page lists it. */
export interface Member {
	/** The membership's id. */
	id: string;
	userId: string;
	role: Role;
	user: { name: string | null; email: string };
}

/**
 * Everyone in the organisation with their role, in the order they joined:
 * what the Members page lists. Read here, through the organisation's scope,
 * and not from Better Auth's `list-members`, which reads at most 100 members
 * and names their accounts in a parameter each (TS-112).
 */
export async function membersByJoining(scope: OrganisationScope): Promise<Member[]> {
	const memberships = await scope.memberships.select(undefined, {
		orderBy: (m) => [asc(m.createdAt), asc(m.id)],
	});
	const accounts = await drizzle(env.DB)
		.select({ id: users.id, name: users.name, email: users.email })
		.from(users)
		.where(
			among(
				users.id,
				memberships.map((m) => m.userId),
			),
		);
	const byId = new Map(accounts.map(({ id, ...user }) => [id, user]));
	return memberships.flatMap((m) => {
		const user = byId.get(m.userId);
		return user ? [{ id: m.id, userId: m.userId, role: Role.parse(m.role), user }] : [];
	});
}
