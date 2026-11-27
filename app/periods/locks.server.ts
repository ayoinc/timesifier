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
 *
 * `projects` are the projects of the entries the change touches, before and
 * after it: in a week held in parts and returned (TS-117), only the returned
 * parts are open, so a day is locked for a change to a part approved or
 * still waiting.
 */
export async function lockedDays(
	scope: OrganisationScope,
	userId: string,
	days: readonly Day[],
	projects: readonly string[],
): Promise<Set<Day>> {
	return new Set((await lockReasonsOn(scope, userId, days, { touching: { projects } })).keys());
}
