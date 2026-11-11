import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users } from "~/db";
import type { Membership } from "~/organisations/membership.server";

import { zoneOf } from "./zones";

/**
 * The zone the days of the person behind `membership` are counted in, read
 * from the database on this request: their own, or their organisation's
 * default until they set one.
 */
export async function zoneOfMember({ user, organisation }: Membership): Promise<string> {
	const [person] = await drizzle(env.DB)
		.select({ timeZone: users.timeZone })
		.from(users)
		.where(eq(users.id, user.id))
		.limit(1);
	return zoneOf({ timeZone: person?.timeZone ?? null }, organisation);
}
