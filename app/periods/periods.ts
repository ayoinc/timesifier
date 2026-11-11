import * as z from "zod";

import { addDays, bounds, type Day, isoWeekday } from "~/time/calendar";

/**
 * Timesheet periods (TS-046, TS-047). A period is a week of local days that
 * starts on the organisation's `week_starts_on`, in the zone of the person
 * whose period it is. Before its first submission it has no row; a row's
 * `status` says where it stands, and `period_events` holds each step.
 */

/** The day a week starts on, as ISO counts it: 1 is Monday, 7 is Sunday. */
export const WeekStart = z.coerce.number().int().min(1).max(7);

/** A period's days, both included. */
export interface PeriodDays {
	startsOn: Day;
	endsOn: Day;
}

/** The period `day` falls in, for an organisation whose weeks start on `weekStartsOn`. */
export function periodContaining(day: Day, weekStartsOn: number): PeriodDays {
	const back = (isoWeekday(day) - weekStartsOn + 7) % 7;
	const startsOn = addDays(day, -back);
	return { startsOn, endsOn: addDays(startsOn, 6) };
}

/** The period before or after `period`: `step` -1 or 1, or further. */
export function periodAfter(period: PeriodDays, step: number): PeriodDays {
	return { startsOn: addDays(period.startsOn, 7 * step), endsOn: addDays(period.endsOn, 7 * step) };
}

/**
 * The instants of a period in `zone`: from the start of its first day up to,
 * not including, the start of the day after its last. An entry is in the
 * period when it starts in that span.
 */
export function periodBounds(period: PeriodDays, zone: string): { from: number; to: number } {
	return bounds(period.startsOn, period.endsOn, zone);
}

export const PeriodStatus = z.enum(["submitted", "withdrawn", "approved", "returned"]);
export type PeriodStatus = z.infer<typeof PeriodStatus>;

/** The steps of a period's life, as `period_events.action` records them. */
export const PeriodAction = z.enum(["submitted", "withdrawn", "approved", "returned", "reopened"]);
export type PeriodAction = z.infer<typeof PeriodAction>;

/**
 * Whether a period in `status` locks the entries that start on its days: a
 * submitted period until it is withdrawn or decided, and an approved one until
 * it is reopened (TS-046). `null` is a period never submitted.
 */
export function locksEntries(status: PeriodStatus | null): boolean {
	return status === "submitted" || status === "approved";
}

/**
 * What a period in `status` becomes when `action` is taken, or null when the
 * action cannot be taken from there. Who may take it is `access.ts`.
 *
 * - Submitted by its person when never submitted, withdrawn or returned.
 * - Withdrawn by its person while submitted and not yet decided.
 * - Approved or returned while submitted.
 * - Reopened while approved, which returns it to its person with a reason.
 */
export function statusAfter(
	status: PeriodStatus | null,
	action: PeriodAction,
): PeriodStatus | null {
	switch (action) {
		case "submitted":
			return status === null || status === "withdrawn" || status === "returned"
				? "submitted"
				: null;
		case "withdrawn":
			return status === "submitted" ? "withdrawn" : null;
		case "approved":
			return status === "submitted" ? "approved" : null;
		case "returned":
			return status === "submitted" ? "returned" : null;
		case "reopened":
			return status === "approved" ? "returned" : null;
	}
}

/** The longest comment a return or a reopening takes (TS-047). */
export const PERIOD_COMMENT_MAX_LENGTH = 500;
