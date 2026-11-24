import { type Balance, halfDaysByDay, type LeaveCalendar, type LeaveSpan } from "~/leave/days";
import type { LeaveStatus } from "~/leave/kinds";

// `balance` and `halfDaysByYear` as main had them before TS-098b (8e3965bf,
// app/leave/days.ts), copied unchanged but for their names: the yardstick of
// "no contract is today" in ./entitlement.test.ts. `halfDaysByDay`, which they
// call, is unchanged since.

function halfDaysByYearOnMain(
	span: LeaveSpan,
	calendar: Pick<LeaveCalendar, "timetable" | "holidays">,
): Map<number, number> {
	const years = new Map<number, number>();
	for (const [day, halves] of halfDaysByDay(span, calendar)) {
		const year = Number(day.slice(0, 4));
		years.set(year, (years.get(year) ?? 0) + halves);
	}
	return years;
}

export function balanceOnMain(
	allowance: number | null,
	requests: readonly (LeaveSpan & { status: LeaveStatus })[],
	year: number,
	calendar: Pick<LeaveCalendar, "timetable" | "holidays">,
): Balance {
	let approved = 0;
	let pending = 0;
	for (const request of requests) {
		if (request.status !== "approved" && request.status !== "pending") continue;
		const halves = halfDaysByYearOnMain(request, calendar).get(year) ?? 0;
		if (request.status === "approved") approved += halves;
		else pending += halves;
	}
	return {
		year,
		allowance,
		approved,
		pending,
		left: allowance === null ? null : allowance - approved - pending,
	};
}
