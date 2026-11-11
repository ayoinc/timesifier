import { env } from "cloudflare:workers";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users } from "~/db";
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
 * only while the person has none, so it never replaces one they chose.
 */
export async function setTimeZone(
	userId: string,
	zone: string,
	{ onlyIfUnset = false }: { onlyIfUnset?: boolean } = {},
): Promise<void> {
	await drizzle(env.DB)
		.update(users)
		.set({ timeZone: zone })
		.where(onlyIfUnset ? and(eq(users.id, userId), isNull(users.timeZone)) : eq(users.id, userId));
}
