import type { Membership } from "~/organisations/membership.server";
import { type PeriodDays, periodAfter, periodContaining } from "~/periods/periods";
import { type Day, dayOf } from "~/time/calendar";
import { zoneOfMember } from "~/time/zones.server";

import { dayParam, WEEK_PARAM } from "./words";

export interface ViewedPeriod {
	/** The period on screen. */
	period: PeriodDays;
	/** The period today falls in, for the viewer. */
	current: PeriodDays;
	/** The viewer's today. */
	today: Day;
	/** The zone the viewer's days are counted in. */
	zone: string;
	/** The first days of the periods before and after it; no later one than the current. */
	previous: Day;
	next: Day | null;
}

/**
 * The period a page of Team or Approvals shows: the one holding the day in
 * `?week=`, or the one `fallback` periods from the current when none is given.
 * Days are the viewer's, in their zone; periods start on the organisation's
 * week start. A period after the current one is never shown.
 */
export async function viewedPeriod(
	membership: Membership,
	url: URL,
	fallback = 0,
	now = Date.now(),
): Promise<ViewedPeriod> {
	const zone = await zoneOfMember(membership);
	const today = dayOf(now, zone);
	const weekStartsOn = membership.organisation.weekStartsOn;
	const current = periodContaining(today, weekStartsOn);
	const asked = dayParam(url.searchParams.get(WEEK_PARAM));
	let period = asked ? periodContaining(asked, weekStartsOn) : periodAfter(current, fallback);
	if (period.startsOn > current.startsOn) period = current;
	return {
		period,
		current,
		today,
		zone,
		previous: periodAfter(period, -1).startsOn,
		next: period.startsOn < current.startsOn ? periodAfter(period, 1).startsOn : null,
	};
}
