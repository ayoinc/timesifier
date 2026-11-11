/**
 * A cap on how often one thing may happen in any stretch of time: codes sent
 * to one address in an hour, invitations sent by one person in a day.
 *
 * Better Auth's rate limit cannot hold these. It counts by client address and
 * path, and it deletes its rows after its longest window, a minute.
 *
 * Each use is a row in `verifications`, the table Better Auth keeps its own
 * short-lived values in: `identifier` is the cap's key and `expires_at` is
 * when the use stops counting. Better Auth deletes the expired rows of that
 * table whenever it looks a value up, so these are cleaned up with its own.
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { uuidv7 } from "~/db";

export type Cap = {
	/** Uses allowed in any stretch of `seconds`. */
	max: number;
	seconds: number;
};

/**
 * Takes one use of `key`, and says whether there was one to take.
 *
 * The count and the insert are one statement, so requests arriving together
 * cannot all find the last use free.
 */
export async function takeOne(
	db: D1Database,
	key: string,
	{ max, seconds }: Cap,
): Promise<boolean> {
	const now = Date.now();
	const identifier = `quota:${key}`;
	const { meta } = await drizzle(db).run(sql`
		insert into verifications (id, identifier, value, expires_at, created_at, updated_at)
		select ${uuidv7()}, ${identifier}, '', ${now + seconds * 1000}, ${now}, ${now}
		where (
			select count(*) from verifications where identifier = ${identifier} and expires_at > ${now}
		) < ${max}
	`);
	return meta.changes === 1;
}
