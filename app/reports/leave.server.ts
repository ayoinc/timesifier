import { and, gte, inArray, lte } from "drizzle-orm";

import { halfDaysByDay } from "~/leave/days";
import { HOLIDAY_KIND, LeaveStatus } from "~/leave/kinds";
import { leaveKindsOf, publicHolidaysOf } from "~/leave/leave.server";
import { maySeeLeaveKindOf } from "~/organisations/access";
import { timetablesOf } from "~/schedules/schedules.server";
import type { Day } from "~/time/calendar";

import type { Person, ReportRequest } from "./reports.server";

/**
 * The Leave view of Reports (TS-084): for the leave year, each person's
 * allowance of each kind of leave, what they have taken, what is booked,
 * what waits for a decision, and what remains. The leave year is the
 * calendar year (TS-061). Taken is approved leave on days up to today;
 * booked is approved leave after it; remaining is the allowance less
 * approved and pending leave, as Time off's balance counts it. All figures
 * are half days of working days. The page and its CSV read this one function,
 * so they hold the same figures.
 *
 * Which kind of leave a person is on is shown only where `maySeeLeaveKindOf`
 * allows: to the person, the managers of their teams, owners and admins. So
 * the view lists those people alone, and Finance sees its own.
 */

export interface LeaveBalanceLine {
	personId: string;
	person: string;
	address: string | null;
	email: string;
	kindId: string;
	kind: string;
	/** Half days a year, or null for a kind with no allowance. */
	allowance: number | null;
	taken: number;
	booked: number;
	pending: number;
	/** The allowance less approved and pending leave; null with no allowance. */
	remaining: number | null;
}

/** The people of `request` whose leave the viewer may see by kind. */
export function leavePeopleOf(request: Pick<ReportRequest, "choices" | "access">): Person[] {
	return request.choices.filter((p) => maySeeLeaveKindOf(request.access, p.id));
}

/**
 * One line for each person and kind of leave in `year`, people by name, kinds
 * in their order. A kind switched off is listed only for a person who has
 * leave of it in the year. `today` divides taken from booked.
 */
export async function leaveBalances(
	request: Pick<ReportRequest, "scope" | "choices" | "access" | "query">,
	year: number,
	today: Day,
): Promise<LeaveBalanceLine[]> {
	const { scope } = request;
	const people = leavePeopleOf(request).filter(
		(p) => request.query.person === undefined || p.id === request.query.person,
	);
	if (people.length === 0) return [];
	const first = `${year}-01-01`;
	const last = `${year}-12-31`;
	const [kinds, timetables, holidays, rows] = await Promise.all([
		leaveKindsOf(scope),
		timetablesOf(
			scope,
			people.map((p) => p.id),
		),
		publicHolidaysOf(scope, { first, last }),
		scope.leaveRequests.select((r) =>
			and(
				inArray(
					r.userId,
					people.map((p) => p.id),
				),
				inArray(r.status, ["approved", "pending"]),
				lte(r.startsOn, last),
				gte(r.endsOn, first),
			),
		),
	]);
	const holidaysOn = kinds.find((k) => k.key === HOLIDAY_KIND)?.enabled ?? true;
	const holidaysByDay = new Map(holidaysOn ? holidays.map((h) => [h.day, h.name]) : []);
	const counted = kinds.filter((k) => k.key !== HOLIDAY_KIND);

	return people.flatMap((person) => {
		const theirs = rows.filter((r) => r.userId === person.id);
		const calendar = { timetable: timetables(person.id), holidays: holidaysByDay };
		return counted
			.filter((kind) => kind.enabled || theirs.some((r) => r.kindId === kind.id))
			.map((kind) => {
				let taken = 0;
				let booked = 0;
				let pending = 0;
				for (const request of theirs) {
					if (request.kindId !== kind.id) continue;
					const status = LeaveStatus.parse(request.status);
					for (const [day, halves] of halfDaysByDay(request, calendar)) {
						if (day < first || day > last) continue;
						if (status === "pending") pending += halves;
						else if (day <= today) taken += halves;
						else booked += halves;
					}
				}
				const allowance = kind.allowanceHalfDays;
				return {
					personId: person.id,
					person: person.name,
					address: person.address,
					email: person.email,
					kindId: kind.id,
					kind: kind.name,
					allowance,
					taken,
					booked,
					pending,
					remaining: allowance === null ? null : allowance - taken - booked - pending,
				};
			});
	});
}

/** The figures of `lines` added up, as the foot of the view and of its CSV show them. */
export function leaveTotals(lines: readonly LeaveBalanceLine[]) {
	return lines.reduce(
		(sum, line) => ({
			taken: sum.taken + line.taken,
			booked: sum.booked + line.booked,
			pending: sum.pending + line.pending,
		}),
		{ taken: 0, booked: 0, pending: 0 },
	);
}
