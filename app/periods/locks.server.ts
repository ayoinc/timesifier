import { and, eq, gte, inArray, lte } from "drizzle-orm";

import type { OrganisationScope } from "~/db";
import type { Day } from "~/time/calendar";

import { locksEntries, PeriodStatus } from "./periods";

/** The statuses that lock a period's entries, for SQL. */
const LOCKING = PeriodStatus.options.filter(locksEntries);

/**
 * The days among `days` on which `userId`'s entries are locked: days in a
 * period of theirs that is submitted or approved. An entry belongs to the
 * local day it starts in, in its person's zone, so a change to an entry is
 * refused when the day it starts on, before or after the change, is here.
 * Each writer of entries asks this first: the timer, the Day view and the
 * week's grid.
 */
export async function lockedDays(
	scope: OrganisationScope,
	userId: string,
	days: readonly Day[],
): Promise<Set<Day>> {
	if (days.length === 0) return new Set();
	const sorted = [...days].sort();
	const first = sorted[0] as Day;
	const last = sorted.at(-1) as Day;
	const periods = await scope.periods.select((p) =>
		and(
			eq(p.userId, userId),
			inArray(p.status, LOCKING),
			lte(p.startsOn, last),
			gte(p.endsOn, first),
		),
	);
	return new Set(
		days.filter((day) => periods.some(({ startsOn, endsOn }) => startsOn <= day && day <= endsOn)),
	);
}
