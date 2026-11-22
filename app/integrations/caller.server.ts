import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { among, type OrganisationScope, organisationScope, organisations, users } from "~/db";
import type { Access } from "~/organisations/access";
import { Role } from "~/organisations/roles";
import type { Viewer } from "~/shell/destinations";

/**
 * Who something that arrives without a session acts as (TS-081, TS-087,
 * TS-089): the person who made the API token, the webhook or the calendar
 * feed, with their role and teams as they are now. Each request reads them
 * again, so a token whose maker is made a member reaches what a member
 * reaches, and one whose maker has left reaches nothing.
 */
export interface Caller {
	scope: OrganisationScope;
	organisation: {
		id: string;
		name: string;
		slug: string;
		timeZone: string;
		weekStartsOn: number;
		clientsEnabled: boolean;
	};
	user: { id: string; name: string; email: string; timeZone: string | null };
	role: Role;
	managesTeams: boolean;
	access: Access;
}

/** The zone a person's days are counted in: their own, or their organisation's. */
export function zoneOfCaller({
	user,
	organisation,
}: Pick<Caller, "user" | "organisation">): string {
	return user.timeZone ?? organisation.timeZone;
}

/** What decides the destinations, and so the pages, the caller may reach. */
export function viewerOfCaller({ role, managesTeams, organisation }: Caller): Viewer {
	return { role, managesTeams, clientsEnabled: organisation.clientsEnabled };
}

/** `userId` in organisation `organisationId`, or null when they are not a member of it. */
export async function callerOf(organisationId: string, userId: string): Promise<Caller | null> {
	const db = drizzle(env.DB);
	const scope = organisationScope(env.DB, organisationId);
	const [[organisation], [user], [membership], managing] = await Promise.all([
		db
			.select({
				id: organisations.id,
				name: organisations.name,
				slug: organisations.slug,
				timeZone: organisations.timeZone,
				weekStartsOn: organisations.weekStartsOn,
				clientsEnabled: organisations.clientsEnabled,
			})
			.from(organisations)
			.where(eq(organisations.id, organisationId))
			.limit(1),
		db
			.select({ id: users.id, name: users.name, email: users.email, timeZone: users.timeZone })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1),
		scope.memberships.select((m) => eq(m.userId, userId), { limit: 1 }),
		scope.teamMembers.select((t) => eq(t.userId, userId)),
	]);
	const role = Role.safeParse(membership?.role);
	if (!organisation || !user || !role.success) return null;
	const managed = managing.filter((place) => place.isManager).map((place) => place.teamId);
	const people =
		managed.length === 0 ? [] : await scope.teamMembers.select((t) => among(t.teamId, managed));
	return {
		scope,
		organisation,
		user,
		role: role.data,
		managesTeams: managed.length > 0,
		access: { userId, role: role.data, managed: new Set(people.map((place) => place.userId)) },
	};
}
