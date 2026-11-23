import { env } from "cloudflare:workers";
import { and, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { type OrganisationScope, organisations } from "~/db";
import { notFound } from "~/organisations/membership.server";
import { addDays, dayOf } from "~/time/calendar";
import { LEAVE_DAYS, MINIMUM_GROUP, REGULARLY, WEEKS } from "./wellbeing";

// Anonymised wellbeing signals for one organisation (TS-099). Two shares of
// its people, shown to its owners and to nobody else, the platform included:
// those regularly over their hours, and those who have taken no leave. No name
// is ever shown, and below `MINIMUM_GROUP` people nothing is shown at all, so
// that no share can point at one person.

const WEEK_DAYS = 7;
const MS_A_MINUTE = 60_000;

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
 * The signals at `now`. Days are the organisation's: today is the day `now`
 * falls on in its zone. Weeks are the last four whole weeks of seven days
 * before today. An entry belongs whole to the day stored with it, in its
 * person's zone (TS-111), and a person's week is over when the finished time
 * on its days passes the organisation's working week. The time is added up in
 * SQL, by person and week, through the index on `(organisation_id, spent_on)`
 * (TS-113, D7).
 */
export async function wellbeingSignals(
	scope: OrganisationScope,
	now: Date,
): Promise<WellbeingSignals> {
	const [members, [organisation]] = await Promise.all([
		scope.memberships.select(),
		drizzle(env.DB)
			.select({ timeZone: organisations.timeZone })
			.from(organisations)
			.where(eq(organisations.id, scope.organisationId)),
	]);
	const people = members.length;
	if (people < MINIMUM_GROUP) return { shown: false, people };
	// The organisation was read for the membership on this request; gone since, it is the 404.
	if (!organisation) throw notFound();

	const today = dayOf(now, organisation.timeZone);
	const last = addDays(today, -1);
	const first = addDays(today, -WEEKS * WEEK_DAYS);
	const leaveFrom = addDays(today, -LEAVE_DAYS);
	const [days, weeks, leave] = await Promise.all([
		scope.workingDays.select(),
		scope.timeEntries.sums(
			(e) => ({
				userId: e.userId,
				// 0 for the week that ends yesterday, 3 for the week that starts on `first`.
				week: sql`cast((julianday(${last}) - julianday(${e.spentOn})) / ${WEEK_DAYS} as integer)`,
			}),
			(e) => ({ ms: sql<number>`${e.endedAt} - ${e.startedAt}` }),
			[["userId", "week"]],
			(e) => and(gte(e.spentOn, first), lte(e.spentOn, last), isNotNull(e.endedAt)),
		),
		scope.leaveRequests.select((l) =>
			and(eq(l.status, "approved"), lte(l.startsOn, today), gte(l.endsOn, leaveFrom)),
		),
	]);
	const weekMinutes = days.reduce((total, day) => total + day.minutes, 0);

	const memberIds = new Set(members.map((m) => m.userId));
	const weeksOver = new Map<string, number>();
	for (const { userId, ms } of weeks) {
		const id = String(userId);
		if (!memberIds.has(id) || ms / MS_A_MINUTE <= weekMinutes) continue;
		weeksOver.set(id, (weeksOver.get(id) ?? 0) + 1);
	}
	const over =
		weekMinutes === 0 ? 0 : [...weeksOver.values()].filter((count) => count >= REGULARLY).length;
	const rested = new Set(leave.map((l) => l.userId).filter((userId) => memberIds.has(userId)));

	return {
		shown: true,
		people,
		overHours: roughShare(over, people),
		noLeave: roughShare(people - rested.size, people),
	};
}
