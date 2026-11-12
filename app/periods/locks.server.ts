import type { OrganisationScope } from "~/db";
import { lockReasonsOn } from "~/locks/locks.server";
import type { Day } from "~/time/calendar";

/**
 * The days among `days` on which `userId`'s entries are locked: days on or
 * before the organisation's lock date (TS-065), and days in a period of
 * theirs that is submitted or approved (TS-046). An entry belongs to the
 * local day it starts in, in its person's zone, so a change to an entry is
 * refused when the day it starts on, before or after the change, is here.
 * Each writer of entries asks this first: the timer, the Day view and the
 * week's grid. Why each day is locked is `lockReasonsOn`.
 */
export async function lockedDays(
	scope: OrganisationScope,
	userId: string,
	days: readonly Day[],
): Promise<Set<Day>> {
	return new Set((await lockReasonsOn(scope, userId, days)).keys());
}
