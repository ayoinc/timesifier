import { env } from "cloudflare:workers";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { recordStatement } from "~/activity/activity.server";
import { organisationIdsOf, organisationScope, users } from "~/db";
import type { Membership } from "~/organisations/membership.server";

import { zoneOf } from "./zones";

/** The zone the person behind `membership` has chosen, or null until they have one. */
export async function ownZoneOf({ user }: Pick<Membership, "user">): Promise<string | null> {
	const [person] = await drizzle(env.DB)
		.select({ timeZone: users.timeZone })
		.from(users)
		.where(eq(users.id, user.id))
		.limit(1);
	return person?.timeZone ?? null;
}

/**
 * The zone the days of the person behind `membership` are counted in, read
 * from the database on this request: their own, or their organisation's
 * default until they set one.
 */
export async function zoneOfMember(membership: Membership): Promise<string> {
	return zoneOf({ timeZone: await ownZoneOf(membership) }, membership.organisation);
}

/**
 * Stores `zone`, already checked against `TimeZone`, as the person's own
 * (TS-012a). `onlyIfUnset` is the zone the browser reported, which is stored
 * only while the person has none, so it never replaces one they chose. Each
 * of their organisations records the change, with before and after, in the
 * batch that makes it (TR-11): it moves the days their time counts in.
 */
export async function setTimeZone(
	userId: string,
	zone: string,
	{ onlyIfUnset = false }: { onlyIfUnset?: boolean } = {},
): Promise<void> {
	const db = drizzle(env.DB);
	const [person] = await db
		.select({ timeZone: users.timeZone })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	const before = person?.timeZone ?? null;
	if (before === zone || (onlyIfUnset && before !== null)) return;
	const update = db
		.update(users)
		.set({ timeZone: zone })
		.where(onlyIfUnset ? and(eq(users.id, userId), isNull(users.timeZone)) : eq(users.id, userId));
	const records = (await organisationIdsOf(env.DB, userId)).map(
		(organisationId) =>
			recordStatement(
				organisationScope(env.DB, organisationId),
				userId,
				"user.time_zone_changed",
				{ type: "user", id: userId, ownerId: userId },
				{ before: { timeZone: before }, after: { timeZone: zone } },
			).query,
	);
	await db.batch([update, ...records]);
}
