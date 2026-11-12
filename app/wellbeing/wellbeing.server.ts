import { and, eq, gte, isNotNull, lte } from "drizzle-orm";

import type { OrganisationScope } from "~/db";

// Anonymised wellbeing signals for one organisation (TS-099). Two shares of
// its people, shown to its owners and to nobody else, the platform included:
// those regularly over their hours, and those who have taken no leave. No name
// is ever shown, and below `MINIMUM_GROUP` people nothing is shown at all, so
// that no share can point at one person.

/** The fewest people a share is shown for. */
export const MINIMUM_GROUP = 5;
/** Weeks looked back over for hours. */
export const WEEKS = 4;
/** Weeks over the working week that make "regularly". */
export const REGULARLY = 3;
/** Days looked back over for leave. */
export const LEAVE_DAYS = 182;

const DAY = 86_400_000;
const WEEK = 7 * DAY;

export type WellbeingSignals =
	| { shown: false; people: number }
	| {
			shown: true;
			people: number;
			/** People over the working week in at least `REGULARLY` of the last `WEEKS` weeks, as a share. */
			overHours: number;
			/** People with no approved leave in the last `LEAVE_DAYS` days, as a share. */
			noLeave: number;
	  };

/** The share as a whole percentage, rounded to the nearest 10 so a small change in one person does not show. */
export function roughShare(count: number, of: number): number {
	return of === 0 ? 0 : Math.round((count / of) * 10) * 10;
}

/**
 * The signals at `now`. Weeks are the last four whole periods of seven days
 * before `now`; a person's week is over when the time they tracked in it
 * passes the organisation's working week.
 */
export async function wellbeingSignals(
	scope: OrganisationScope,
	now: Date,
): Promise<WellbeingSignals> {
	const members = await scope.memberships.select();
	const people = members.length;
	if (people < MINIMUM_GROUP) return { shown: false, people };

	const from = new Date(now.getTime() - WEEKS * WEEK);
	const leaveFrom = new Date(now.getTime() - LEAVE_DAYS * DAY).toISOString().slice(0, 10);
	const today = now.toISOString().slice(0, 10);
	const [days, entries, leave] = await Promise.all([
		scope.workingDays.select(),
		scope.timeEntries.select((e) => and(gte(e.startedAt, from), isNotNull(e.endedAt))),
		scope.leaveRequests.select((l) =>
			and(eq(l.status, "approved"), lte(l.startsOn, today), gte(l.endsOn, leaveFrom)),
		),
	]);
	const weekMinutes = days.reduce((total, day) => total + day.minutes, 0);

	const minutes = new Map<string, number[]>();
	for (const entry of entries) {
		if (!entry.endedAt) continue;
		const week = Math.floor((now.getTime() - entry.startedAt.getTime()) / WEEK);
		if (week < 0 || week >= WEEKS) continue;
		const weeks = minutes.get(entry.userId) ?? Array.from({ length: WEEKS }, () => 0);
		weeks[week] =
			(weeks[week] ?? 0) + (entry.endedAt.getTime() - entry.startedAt.getTime()) / 60_000;
		minutes.set(entry.userId, weeks);
	}
	const memberIds = new Set(members.map((m) => m.userId));
	const over =
		weekMinutes === 0
			? 0
			: [...minutes.entries()].filter(
					([userId, weeks]) =>
						memberIds.has(userId) &&
						weeks.filter((total) => total > weekMinutes).length >= REGULARLY,
				).length;
	const rested = new Set(leave.map((l) => l.userId).filter((userId) => memberIds.has(userId)));

	return {
		shown: true,
		people,
		overHours: roughShare(over, people),
		noLeave: roughShare(people - rested.size, people),
	};
}
