import type { Contract, ContractVersion } from "~/contracts/contracts";
import { covers } from "~/contracts/spans";
import { type ScheduleWeek, versionOn, weekTotal, workedMinutes } from "~/schedules/schedules";
import { addDays, type Day, daysFrom, isoWeekday } from "~/time/calendar";
import { formatDayWithYear } from "~/time/format";

import { halfDaysByDay, type LeaveCalendar, type LeaveSpan } from "./days";
import type { LeaveStatus } from "./kinds";
import { type LeaveYear, leaveYear, leaveYearOf } from "./years";

/**
 * Annual leave from a person's contracts (TS-098b, decision 76;
 * research/contracts-model.md section 3). Nothing here reads the database or
 * a clock.
 *
 * It is counted in minutes, the owner's answer 1: a part-timer's days are not
 * always the same length, and a day of leave takes that day's scheduled
 * minutes. A balance is shown in days where every working day is the same
 * length, and in hours otherwise.
 *
 * A leave year's entitlement is, for each day of the year a contract covers,
 * `leave_days ÷ 5 × the week's minutes of the schedule that holds that day ÷
 * the year's days`, added up and rounded up once to half of the person's
 * average working day, as gov.uk rounds a starter's leave up to the nearest
 * half day. A starter or a leaver gets the days they are covered for; a change
 * mid-year counts each part. A contractor's contract gives none.
 *
 * A day of the year no contract covers counts at the rule from before
 * contracts, the kind's allowance in the person's own working days,
 * `allowance ÷ 2 × the week's minutes ÷ its working days ÷ the year's days`:
 * - before their first contract, where whoever gave it said they worked here
 *   before it (`prior_days_at_allowance`); otherwise those days count nothing,
 *   as for a starter;
 * - between two contracts, as a member still.
 * After their last contract ends, nothing counts. So a contract given part way
 * through a year to someone who worked here before changes nothing before its
 * first day (decision 76).
 *
 * Whoever has no contract whose annual leave is its own keeps the balance
 * they had before: the kind's allowance in half days, `balance` in ./days.
 */

/** How a contract that starts part way through a month counts that month. */
export const STARTER_MONTHS = ["days", "whole"] as const;
export type StarterMonth = (typeof STARTER_MONTHS)[number];

/** The starter month rule in Settings › Leave: gov.uk's two ways of counting a starter's first month. */
export const STARTER_MONTH_LABELS: Record<StarterMonth, string> = {
	days: "From their first day",
	whole: "The whole month they start in",
};

/** The organisation's settings the leave year is counted by. */
export interface LeaveYearSettings {
	/** `MM-DD`, the day the leave year starts. */
	leaveYearStarts: string;
	starterMonth: StarterMonth;
	/** Whether each public holiday on a working day comes out of annual leave (the owner's answer 2). */
	holidaysFromAllowance: boolean;
}

/** Every organisation's settings until an owner or admin changes them: the calendar year, a starter's days, holidays on top. */
export const USUAL_SETTINGS: LeaveYearSettings = {
	leaveYearStarts: "01-01",
	starterMonth: "days",
	holidaysFromAllowance: false,
};

/** What a person's annual leave from their contracts is counted from. */
export interface ContractLeave {
	contracts: readonly Contract[];
	settings: LeaveYearSettings;
	/** The annual kind's allowance in half days, which a version with no leave days of its own gives; null for none. */
	allowanceHalfDays: number | null;
	calendar: Pick<LeaveCalendar, "timetable" | "holidays">;
	/** The person's requests for annual leave. Only the approved and the pending count. */
	requests: readonly (LeaveSpan & { status: LeaveStatus })[];
	/** The person's adjustments of annual leave. */
	adjustments: readonly { leaveYear: number; minutes: number }[];
}

/**
 * Where a day's share of annual leave comes from: the version of a contract,
 * counted in the week of `weekOf`; or the kind's allowance, on a day no
 * contract covers (decision 76).
 */
type DayShare = { from: "contract"; version: ContractVersion; weekOf: Day } | { from: "allowance" };

/**
 * What gives `day` its share of annual leave (decision 76):
 * - the version of the contract that covers it, not a contractor's;
 * - between two contracts, the kind's allowance;
 * - before the first, the kind's allowance where that contract says so; else,
 *   where the organisation counts a starter's month whole, a day of the month
 *   it starts in, with its first terms;
 * - after the last has ended, nothing.
 */
function shareOn(
	contracts: readonly Contract[],
	settings: LeaveYearSettings,
	day: Day,
): DayShare | null {
	const covering = contracts.find((c) => covers(c, day));
	if (covering) {
		return covering.kind === "contractor"
			? null
			: { from: "contract", version: versionOn(covering, day), weekOf: day };
	}
	const first = contracts[0];
	const lastEnds = contracts.at(-1)?.endsOn ?? null;
	if (!first || (lastEnds !== null && day > lastEnds)) return null;
	if (day > first.startsOn) return { from: "allowance" };
	if (first.priorDaysAtAllowance) return { from: "allowance" };
	const terms = first.versions[0];
	if (
		settings.starterMonth === "whole" &&
		first.kind !== "contractor" &&
		terms &&
		day.slice(0, 7) === first.startsOn.slice(0, 7)
	) {
		return { from: "contract", version: terms, weekOf: first.startsOn };
	}
	return null;
}

/** The days a week works, and its minutes. */
function weekShape(week: ScheduleWeek) {
	return { minutes: weekTotal(week), days: week.filter((day) => workedMinutes(day) > 0).length };
}

/** `a ÷ b` rounded up, for whole numbers with `b` above 0. */
function ceilDiv(a: bigint, b: bigint): number {
	return Number((a + b - 1n) / b);
}

/** lcm(1, …, 7): an average day, a week's minutes ÷ its working days, is whole in these. */
const SCALE = 420;

/** One leave year's entitlement, and what the year's balance is shown and carried in. */
export interface YearEntitlement {
	year: LeaveYear;
	/** Whether a contract gives this year's annual leave: one of its versions has leave days of its own. */
	fromContract: boolean;
	/** Minutes, rounded up to half an average working day. */
	minutes: number;
	/** The person's average working day over the days counted, in minutes; 0 for none. */
	averageDay: number;
	/** The length of every working day counted, where they are all the same; null otherwise. */
	dayLength: number | null;
	/** The terms on the last day counted, whose carry-over applies at the year's end; null for none. */
	lastTerms: ContractVersion | null;
	/** Whether a contract gives `day` its share: public holidays come out of annual leave only on such days. */
	counts: (day: Day) => boolean;
}

/** The entitlement of the leave year named `year`. */
export function entitlementOf(
	leave: Pick<ContractLeave, "contracts" | "settings" | "allowanceHalfDays" | "calendar">,
	year: number,
): YearEntitlement {
	const span = leaveYear(leave.settings.leaveYearStarts, year);
	const days = daysFrom(span.first, span.last);
	const counted = new Set<Day>();
	const lengths = new Set<number>();
	let fromContract = false;
	let lastTerms: ContractVersion | null = null;
	// The exact share in minutes is `share ÷ (10 × the year's days × SCALE)`:
	// a contract's day adds half days × week minutes × SCALE, and an allowance
	// day 5 × half days × week minutes × SCALE ÷ working days. Beside it, the
	// week minutes and the days worked a week of every day counted.
	let share = 0;
	let weekMinutes = 0;
	let weekDays = 0;
	for (const day of days) {
		const terms = shareOn(leave.contracts, leave.settings, day);
		if (!terms) continue;
		const week = leave.calendar.timetable(terms.from === "contract" ? terms.weekOf : day).week;
		const shape = weekShape(week);
		if (terms.from === "contract") {
			counted.add(day);
			lastTerms = terms.version;
			if (terms.version.leaveDays !== null) fromContract = true;
			// Half days a year for a full week: the version's own, or the kind's allowance.
			const halves =
				terms.version.leaveDays === null
					? (leave.allowanceHalfDays ?? 0)
					: terms.version.leaveDays * 2;
			share += halves * shape.minutes * SCALE;
		} else {
			// Nothing carries out of a year the allowance ends.
			lastTerms = null;
			if (shape.days > 0) {
				share += (5 * (leave.allowanceHalfDays ?? 0) * shape.minutes * SCALE) / shape.days;
			}
		}
		weekMinutes += shape.minutes;
		weekDays += shape.days;
		for (const worked of week) {
			const minutes = workedMinutes(worked);
			if (minutes > 0) lengths.add(minutes);
		}
	}
	let minutes = 0;
	if (weekMinutes > 0 && weekDays > 0 && share > 0) {
		// Half an average day is weekMinutes ÷ (2 × weekDays). The share is
		// rounded up to a whole number of those, then up to the whole minute.
		const halves = ceilDiv(
			BigInt(share) * BigInt(weekDays),
			BigInt(5 * days.length * SCALE) * BigInt(weekMinutes),
		);
		minutes = ceilDiv(BigInt(halves) * BigInt(weekMinutes), BigInt(2 * weekDays));
	}
	const [only] = lengths;
	return {
		year: span,
		fromContract,
		minutes,
		averageDay: weekDays > 0 ? weekMinutes / weekDays : 0,
		dayLength: lengths.size === 1 && only !== undefined ? only : null,
		lastTerms,
		counts: (day) => counted.has(day),
	};
}

/** A balance of annual leave from a contract, for one leave year. Every figure is minutes. */
export interface ContractBalance {
	year: LeaveYear;
	entitlement: number;
	/** Carried in from the year before: what was left, up to its carry-over, or all of it when below nothing. */
	carried: number;
	/** The last day carried leave may be taken on; null for the year's end. */
	carriedUntil: Day | null;
	/** Carried leave not taken by `carriedUntil`, which lapses then: not counted in `left`. */
	lapsing: number;
	/** The adjustments of the year, added up. */
	adjusted: number;
	/** Public holidays on working days, where they come out of annual leave. */
	holidays: number;
	approved: number;
	pending: number;
	/** What is left for the whole year, carried leave that lapses not counted; below 0 when more was taken. */
	left: number;
	/** The length of every working day counted, where they are all the same; null otherwise. */
	dayLength: number | null;
}

/** The minutes of approved and of pending leave on the days of `year` that `within` admits. */
function takenIn(leave: ContractLeave, year: LeaveYear, within: (day: Day) => boolean) {
	let approved = 0;
	let pending = 0;
	for (const request of leave.requests) {
		if (request.status !== "approved" && request.status !== "pending") continue;
		if (request.endsOn < year.first || request.startsOn > year.last) continue;
		for (const [day, halves] of halfDaysByDay(request, leave.calendar)) {
			if (day < year.first || day > year.last || !within(day)) continue;
			const minutes = (leave.calendar.timetable(day).minutes * halves) / 2;
			if (request.status === "approved") approved += minutes;
			else pending += minutes;
		}
	}
	return { approved, pending };
}

/** The minutes of public holidays on working days the entitlement counts, on the days `within` admits. */
function holidaysIn(
	leave: ContractLeave,
	entitlement: YearEntitlement,
	within: (day: Day) => boolean,
): number {
	if (!leave.settings.holidaysFromAllowance) return 0;
	let minutes = 0;
	for (const day of leave.calendar.holidays.keys()) {
		if (day < entitlement.year.first || day > entitlement.year.last) continue;
		if (!entitlement.counts(day) || !within(day)) continue;
		minutes += leave.calendar.timetable(day).minutes;
	}
	return minutes;
}

/** What carries out of a year whose balance is `left`: up to its carry-over, or all of a debt. */
function carriedOut(entitlement: YearEntitlement, left: number): number {
	if (left <= 0) return left;
	const days = entitlement.lastTerms?.carryOverDays ?? 0;
	return Math.min(left, Math.floor(days * entitlement.averageDay));
}

/**
 * The balance of annual leave from a contract in the leave year named `year`,
 * or null when no contract gives that year's leave: then the person's balance
 * is `balance`'s, as before. Carry-over runs from the first year a contract
 * gives; a year none gives carries nothing on.
 */
export function contractBalance(leave: ContractLeave, year: number): ContractBalance | null {
	const first = leave.contracts[0];
	if (!first) return null;
	// A starter's whole month may reach back into the leave year before its first day's.
	const from = leaveYearOf(leave.settings.leaveYearStarts, `${first.startsOn.slice(0, 7)}-01`);
	let carried = 0;
	let expiresAfter: number | null = null;
	let found: ContractBalance | null = null;
	for (let y = Math.min(from, year); y <= year; y++) {
		const entitlement = entitlementOf(leave, y);
		if (!entitlement.fromContract) {
			carried = 0;
			found = null;
			continue;
		}
		const span = entitlement.year;
		const all = () => true;
		const { approved, pending } = takenIn(leave, span, all);
		const holidays = holidaysIn(leave, entitlement, all);
		const adjusted = leave.adjustments
			.filter((a) => a.leaveYear === y)
			.reduce((sum, a) => sum + a.minutes, 0);
		const carriedUntil =
			carried > 0 && expiresAfter !== null && addDays(span.first, expiresAfter - 1) < span.last
				? addDays(span.first, expiresAfter - 1)
				: null;
		let lapsing = 0;
		if (carriedUntil) {
			const byThen = (day: Day) => day <= carriedUntil;
			const used = takenIn(leave, span, byThen);
			lapsing = Math.max(
				0,
				carried - used.approved - used.pending - holidaysIn(leave, entitlement, byThen),
			);
		}
		const left = entitlement.minutes + carried - lapsing + adjusted - holidays - approved - pending;
		found = {
			year: span,
			entitlement: entitlement.minutes,
			carried,
			carriedUntil,
			lapsing,
			adjusted,
			holidays,
			approved,
			pending,
			left,
			dayLength: entitlement.dayLength,
		};
		carried = carriedOut(entitlement, left);
		expiresAfter = entitlement.lastTerms?.carryOverExpiresAfterDays ?? null;
	}
	return found;
}

/**
 * The day length a balance is shown in: its people's working day, where every
 * figure is whole or half days of it; null to show it in hours.
 */
export function shownInDays(balance: ContractBalance): number | null {
	const length = balance.dayLength;
	if (length === null) return null;
	const figures = [
		balance.entitlement,
		balance.carried,
		balance.lapsing,
		balance.adjusted,
		balance.holidays,
		balance.approved,
		balance.pending,
		balance.left,
	];
	return figures.every((m) => Number.isInteger((m * 2) / length)) ? length : null;
}

/**
 * Minutes of leave in words: in days of `dayLength` where given ("15 days",
 * "half a day", "9.5 days"), else in hours ("112:30"). Below nothing reads
 * "minus …".
 */
export function leaveAmount(minutes: number, dayLength: number | null): string {
	const sign = minutes < 0 ? "minus " : "";
	const size = Math.abs(minutes);
	if (dayLength !== null) {
		const halves = Math.round((size * 2) / dayLength);
		if (halves === 1) return `${sign}half a day`;
		return `${sign}${halves / 2} ${halves === 2 ? "day" : "days"}`;
	}
	const whole = Math.round(size);
	return `${sign}${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The longest reason an adjustment takes. */
export const ADJUSTMENT_REASON_MAX_LENGTH = 200;
/** The most one adjustment adds or takes away: a year of whole days, in minutes, as the table allows. */
export const LONGEST_ADJUSTMENT_MINUTES = 366 * 24 * 60;

/** Minutes from what a person typed as days of `dayLength`, or as hours ("7:30", "7.5"); null for neither. */
export function minutesFrom(
	text: string,
	unit: "days" | "hours",
	dayLength: number | null,
): number | null {
	const trimmed = text.trim().replace(/^\+/, "");
	const negative = trimmed.startsWith("-");
	const size = negative ? trimmed.slice(1).trim() : trimmed;
	let minutes: number | null = null;
	if (unit === "days") {
		if (dayLength === null || !/^\d+(\.5|\.0)?$/.test(size)) return null;
		minutes = Math.round(Number(size) * dayLength);
	} else if (/^\d+:[0-5]\d$/.test(size)) {
		const [hours = "0", rest = "0"] = size.split(":");
		minutes = Number(hours) * 60 + Number(rest);
	} else if (/^\d+(\.\d{1,2})?$/.test(size)) {
		minutes = Math.round(Number(size) * 60);
	}
	if (minutes === null || minutes === 0) return null;
	return negative ? -minutes : minutes;
}

/**
 * A balance from a contract as Time off and the Contract page say it: what
 * the year gives and what came out of it, and what is left. Carried leave that
 * lapses is said beside it while it may still be taken.
 */
export function contractBalanceWords(
	balance: ContractBalance,
	today: Day,
): { detail: string; value: string } {
	const unit = shownInDays(balance);
	const amount = (minutes: number) => leaveAmount(minutes, unit);
	const parts = [`From the contract: ${amount(balance.entitlement)} this leave year.`];
	if (balance.carried !== 0) parts.push(`Carried over: ${amount(balance.carried)}.`);
	if (balance.adjusted !== 0) parts.push(`Adjusted: ${amount(balance.adjusted)}.`);
	if (balance.holidays > 0) parts.push(`Public holidays: ${amount(balance.holidays)}.`);
	parts.push(
		`Taken: ${amount(balance.approved)}${balance.pending ? `; waiting: ${amount(balance.pending)}` : ""}.`,
	);
	if (balance.lapsing > 0 && balance.carriedUntil && today <= balance.carriedUntil) {
		const more = amount(balance.lapsing);
		parts.push(
			`${more.charAt(0).toUpperCase()}${more.slice(1)} more of what was carried over, until ${formatDayWithYear(balance.carriedUntil)}.`,
		);
	}
	return {
		detail: parts.join(" "),
		value: balance.left >= 0 ? `${amount(balance.left)} left` : `${amount(-balance.left)} over`,
	};
}

// The statutory floor.

/** gov.uk: "at least 5.6 weeks of paid holiday", in tenths of a week. */
export const STATUTORY_WEEKS_TENTHS = 56;
/** gov.uk: "Statutory paid holiday entitlement is limited to 28 days." */
export const STATUTORY_CAP_DAYS = 28;
/** What a contract sheet says when its leave is below the floor. */
export const BELOW_STATUTORY =
	"This is less than the 5.6 weeks' paid holiday UK law gives (gov.uk, Holiday entitlement).";

/**
 * Whether a version's annual leave is below the UK's statutory minimum: 5.6
 * weeks of its hours, but never more than 28 of its days. Public holidays on
 * its working days count toward it where they are on top of annual leave;
 * where they come out of it, they are already inside. It warns and never
 * refuses: an organisation outside the UK may have other rules.
 */
export function belowStatutoryFloor(terms: {
	/** Days a year for a full week. */
	leaveDays: number;
	week: ScheduleWeek;
	/** Minutes of the public holidays on the week's working days in a leave year. */
	holidayMinutes: number;
	holidaysFromAllowance: boolean;
}): boolean {
	const { minutes: w, days: n } = weekShape(terms.week);
	if (w === 0 || n === 0) return false;
	const holidays = terms.holidaysFromAllowance ? 0 : terms.holidayMinutes;
	// Given: leaveDays × w ÷ 5 + holidays. Floor: the lesser of 5.6 × w and
	// 28 × w ÷ n. Both sides times 10n, to stay in whole numbers.
	const given = 2 * n * terms.leaveDays * w + 10 * n * holidays;
	const floor = Math.min(STATUTORY_WEEKS_TENTHS * n * w, STATUTORY_CAP_DAYS * 10 * w);
	return given < floor;
}

/** The minutes of `holidays` that fall on the working days of `week`. */
export function holidayMinutesOn(week: ScheduleWeek, holidays: readonly Day[]): number {
	return holidays.reduce((sum, day) => {
		const index = isoWeekday(day) - 1;
		return sum + workedMinutes(week[index]);
	}, 0);
}
