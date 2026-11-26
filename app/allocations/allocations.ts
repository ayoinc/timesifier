import { z } from "zod";

import { dayStatus, type LeaveCalendar } from "~/leave/days";
import { periodContaining } from "~/periods/periods";
import { addDays, type Day } from "~/time/calendar";
import { formatDuration } from "~/time/format";

// A person's time share of a project (TS-116, docs/decisions.md entry 78): so
// many days or hours a week, or a percentage of their schedule, on a project
// or on one of its work packages, from a day to a day or on. What it plans on
// a day is read from the person's work schedule on that day (TS-097), less
// public holidays and approved leave, so a schedule changed later moves the
// plan with it and nothing stored goes stale. Nothing here runs only on the
// server.

export const ALLOCATION_UNITS = ["days", "hours", "percent"] as const;
export const AllocationUnit = z.enum(ALLOCATION_UNITS);
export type AllocationUnit = z.infer<typeof AllocationUnit>;

/** The unit as a field's option, after the amount: "2.5 days a week". */
export const UNIT_LABELS: Record<AllocationUnit, string> = {
	days: "days a week",
	hours: "hours a week",
	percent: "% of their schedule",
};

/** The most of each unit, in hundredths: 7 days, 168 hours, 100 %. The table's check holds the same. */
export const UNIT_MAX: Record<AllocationUnit, number> = {
	days: 700,
	hours: 16_800,
	percent: 10_000,
};

/**
 * Over-allocated is more than 105 % of what the person has available in the
 * week; under-allocated is less than 80 %. Between them is fully allocated:
 * the 5 % above covers rounding and a short overrun, and the 20 % below the
 * meetings, admin and support that no project carries.
 */
export const OVER_SHARE = 1.05;
export const UNDER_SHARE = 0.8;

/** A time share as the rules read it. `amount` is in hundredths of `unit`. */
export interface Share {
	id: string;
	userId: string;
	projectId: string;
	workPackageId: string | null;
	startsOn: Day;
	endsOn: Day | null;
	amount: number;
	unit: AllocationUnit;
}

/** Whether `share` runs on `day`. */
export function sharesDay(share: Pick<Share, "startsOn" | "endsOn">, day: Day): boolean {
	return share.startsOn <= day && (share.endsOn === null || day <= share.endsOn);
}

/** Whether two stretches of days share a day; an open one runs to the end of time. */
export function overlap(
	a: Pick<Share, "startsOn" | "endsOn">,
	b: Pick<Share, "startsOn" | "endsOn">,
): boolean {
	return a.startsOn <= (b.endsOn ?? "9999-12-31") && b.startsOn <= (a.endsOn ?? "9999-12-31");
}

/** The amount in words: "2.5 days a week", "22:30 a week", "50% of their schedule". */
export function amountText(share: Pick<Share, "amount" | "unit">): string {
	switch (share.unit) {
		case "days": {
			const days = share.amount / 100;
			return `${trimmed(days)} ${days === 1 ? "day" : "days"} a week`;
		}
		case "hours":
			return `${formatDuration(share.amount * 36)} a week`;
		case "percent":
			return `${trimmed(share.amount / 100)}% of their schedule`;
	}
}

/** The amount as its field shows it: "2.5", "22:30", "50". */
export function amountField(share: Pick<Share, "amount" | "unit">): string {
	return share.unit === "hours" ? formatDuration(share.amount * 36) : trimmed(share.amount / 100);
}

function trimmed(value: number): string {
	return String(Math.round(value * 100) / 100);
}

/**
 * The amount typed for `unit` in hundredths: "2.5" days is 250, "22:30" or
 * "22.5" hours is 2250, "50" % is 5000. Null for anything else, nothing more
 * than none, or more than the unit holds.
 */
export function parseAmount(text: string, unit: AllocationUnit): number | null {
	const typed = text.trim().replace(/%$/, "").trim();
	let hundredths: number;
	const clock = /^(\d{1,3}):([0-5]\d)$/.exec(typed);
	if (clock && unit === "hours") {
		// A hundredth of an hour is 36 seconds, so the minutes are a multiple of 3.
		const minutes = Number(clock[1]) * 60 + Number(clock[2]);
		if (minutes % 3 !== 0) return null;
		hundredths = (minutes * 5) / 3;
	} else if (/^\d{1,5}(\.\d{1,2})?$/.test(typed)) {
		hundredths = Math.round(Number(typed) * 100);
	} else return null;
	if (hundredths <= 0 || hundredths > UNIT_MAX[unit]) return null;
	return hundredths;
}

/** The days of the week `day` is in, for an organisation whose weeks start on `weekStartsOn`. */
function weekOf(day: Day, weekStartsOn: number): Day[] {
	const { startsOn } = periodContaining(day, weekStartsOn);
	return [0, 1, 2, 3, 4, 5, 6].map((n) => addDays(startsOn, n));
}

/**
 * What part of each day's available time `share` takes on `day`: its
 * percentage; its days over the days the person's schedule works that week;
 * its hours over the minutes the schedule sets that week. A day is that
 * day's scheduled length, so a part-time schedule's two days are two of its
 * days. 0 in a week the schedule does not work.
 */
export function shareOfDay(
	share: Pick<Share, "amount" | "unit">,
	calendar: Pick<LeaveCalendar, "timetable">,
	day: Day,
	weekStartsOn: number,
): number {
	if (share.unit === "percent") return share.amount / 10_000;
	const week = weekOf(day, weekStartsOn).map((d) => calendar.timetable(d).minutes);
	if (share.unit === "days") {
		const worked = week.filter((minutes) => minutes > 0).length;
		return worked === 0 ? 0 : share.amount / 100 / worked;
	}
	const scheduled = week.reduce((sum, minutes) => sum + minutes, 0);
	return scheduled === 0 ? 0 : (share.amount * 0.6) / scheduled;
}

/**
 * The whole minutes `share` plans on `day`: the share's part of what the
 * person has available that day, their schedule's minutes less a public
 * holiday or approved leave (half for a half day). 0 on a day it does not run.
 */
export function plannedOn(
	share: Share,
	calendar: LeaveCalendar,
	day: Day,
	weekStartsOn: number,
): number {
	if (!sharesDay(share, day)) return 0;
	const available = dayStatus(calendar, day).expectedMinutes;
	if (available === 0) return 0;
	return Math.round(available * shareOfDay(share, calendar, day, weekStartsOn));
}

/** The minutes `share` plans over `days`: the sum of its days. */
export function plannedOver(
	share: Share,
	calendar: LeaveCalendar,
	days: readonly Day[],
	weekStartsOn: number,
): number {
	return days.reduce((sum, day) => sum + plannedOn(share, calendar, day, weekStartsOn), 0);
}

/** The minutes the person has available over `days`: their schedule less holidays and leave. */
export function availableOver(calendar: LeaveCalendar, days: readonly Day[]): number {
	return days.reduce((sum, day) => sum + dayStatus(calendar, day).expectedMinutes, 0);
}

export type LoadKind = "over" | "under" | "full" | "none";

/** How a person's plan sits on what they have available, with the words that say it. */
export interface Load {
	kind: LoadKind;
	words: string;
}

/**
 * Whether `planned` minutes over- or under-allocate a person who has
 * `available`: over above `OVER_SHARE` of it, under below `UNDER_SHARE`, and
 * "Nothing available" in a stretch of leave, holidays and days off.
 */
export function loadOf(planned: number, available: number): Load {
	if (available <= 0) {
		return planned > 0
			? { kind: "over", words: `Over-allocated by ${formatDuration(planned * 60)}` }
			: { kind: "none", words: "Nothing available" };
	}
	if (planned > available * OVER_SHARE) {
		return {
			kind: "over",
			words: `Over-allocated by ${formatDuration((planned - available) * 60)}`,
		};
	}
	if (planned < available * UNDER_SHARE) {
		return {
			kind: "under",
			words:
				planned === 0
					? "Under-allocated: nothing planned"
					: `Under-allocated: ${formatDuration((available - planned) * 60)} free`,
		};
	}
	return { kind: "full", words: "Fully allocated" };
}

/** A line's plan beside its time, as a row of the Timesheet says it: "WP2: 22:30 planned, 18:00 tracked". */
export function planLine(name: string, plannedMinutes: number, trackedSeconds: number): string {
	return `${name}: ${formatDuration(plannedMinutes * 60)} planned, ${formatDuration(trackedSeconds)} tracked`;
}

/** The key of a line of work: a project, or one of its work packages. */
export function shareLine(share: Pick<Share, "projectId" | "workPackageId">): string {
	return share.workPackageId ? `${share.projectId}:${share.workPackageId}` : share.projectId;
}

/** Why a time share was refused, in words. */
export type ShareProblem =
	| "not-member"
	| "overlaps"
	| "ends-before-start"
	| "amount"
	| "work-package";

export const SHARE_PROBLEMS: Record<ShareProblem, string> = {
	"not-member": "They are not a member of the organisation.",
	overlaps:
		"They already have a time share of this on one of those days. End it the day before, or change it from a day.",
	"ends-before-start": "The last day is before the first.",
	amount:
		"Give an amount: up to 7 days a week, 168 hours a week or 100% of their schedule, more than none.",
	"work-package": "That work package is not one of this project's.",
};

/** The intent of the project's Team tab that sets a person's time share. */
export const SHARE_INTENT = "set-share";
/** The intent that changes a time share from a day, or ends it. */
export const CHANGE_SHARE_INTENT = "change-share";
/** The intent that removes a time share. */
export const REMOVE_SHARE_INTENT = "remove-share";
