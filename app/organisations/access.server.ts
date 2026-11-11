import { env } from "cloudflare:workers";

import { organisationScope } from "~/db";
import { managedPeople } from "~/teams/teams.server";

import type { Access } from "./access";
import type { Membership } from "./membership.server";

/**
 * What the rules in `access.ts` take, for the person behind `membership`,
 * read from the database on this request. A person who manages no team costs
 * no query beyond the membership's own.
 */
export async function accessOf({
	user,
	role,
	organisation,
	managesTeams,
}: Membership): Promise<Access> {
	const managed = managesTeams
		? await managedPeople(organisationScope(env.DB, organisation.id), user.id)
		: new Set<string>();
	return { userId: user.id, role, managed };
}
