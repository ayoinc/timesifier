import * as z from "zod";

import { periodContaining } from "~/periods/periods";
import type { Timetable } from "~/schedules/schedules";
import { addDays, type Day, daysFrom } from "~/time/calendar";
import { formatDay, formatDuration } from "~/time/format";

import { type DayStatus, dayStatus, type LeaveCalendar } from "./days";
import type { KindKey, LeaveStatus } from "./kinds";
import { WEEKDAY_NAMES } from "./words";

/**
 * Leave and tracked time together (TS-090), with expected hours as a ceiling
 * and overtime recorded as such (TS-095): how much time a day of a person
 * takes, and whether leave was asked for in good time. Nothing here reads the
 * database or a clock; the server gathers a `RulesCalendar` and these rules
 * read it, the same in the Worker and the browser.
 *
 * A day takes two kinds of time. Regular time, up to what is expected of the
 * person on it less their leave; and overtime, an entry marked so, as the
 * organisation's overtime rule allows:
 *
 * - A public holiday, or a day of whole-day leave, is closed: no time at all.
 *   Where the organisation allows overtime at all, a public holiday takes
 *   approved holiday work, as overtime (decision 52).
 * - A working day, or a day of half-day leave, takes its expected time as
 *   regular time (7:30, or 3:45 on a half day). Where a half day takes more
 *   (overtime allowed, or approved), the time past its half is regular until
 *   the day reaches its full expected hours, and overtime only past them
 *   (decision 50).
 * - A day holding more than 24 hours is over its limit, whatever its rules
 *   (decision 52).
 * - A day the working week does not work takes no regular time: its time is
 *   all overtime, unless the organisation does not allow time on such days,
 *   when it is closed.
 * - Overtime is not allowed (the default); allowed; or allowed only as far
 *   as approved overtime (weekend work on a day not worked) covers the day.
 *   An optional cap per day and per week holds it in each case; the week is
 *   the organisation's.
 *
 * Time is the person's entries that start on the day, a running one counted
 * to now, in whole minutes, as the Timesheet adds it up.
 */

/** How an organisation treats time beyond a day's expected hours: not allowed, allowed, or only with pre-approval. */
export const OVERTIME_RULES = ["none", "allowed", "approval"] as const;
export const OvertimeRule = z.enum(OVERTIME_RULES);
export type OvertimeRule = z.infer<typeof OvertimeRule>;

/** How an organisation treats time on a day the working week does not work: as overtime, or not at all. */
export const NON_WORKING_RULES = ["overtime", "none"] as const;
export const NonWorkingRule = z.enum(NON_WORKING_RULES);
export type NonWorkingRule = z.infer<typeof NonWorkingRule>;

/** Whether leave asked for at shorter notice than its kind's is allowed with a reason, or refused. */
export const SHORT_NOTICE_RULES = ["with-reason", "refused"] as const;
export const ShortNoticeRule = z.enum(SHORT_NOTICE_RULES);
export type ShortNoticeRule = z.infer<typeof ShortNoticeRule>;

/** The most an overtime cap may be, in minutes: a day's cap and a week's alike. */
export const LONGEST_OVERTIME_CAP_MINUTES = 7 * 24 * 60;

/** The organisation's timesheet rules (Workspace settings, Timesheet rules). */
export interface TimesheetRules {
	overtime: OvertimeRule;
	weekend: NonWorkingRule;
	/** The most overtime a person records on one day, in minutes; null for no cap. */
	overtimeDayCap: number | null;
	/** The most overtime a person records in one of the organisation's weeks, in minutes; null for no cap. */
	overtimeWeekCap: number | null;
	shortNotice: ShortNoticeRule;
}

/** What decides a day's limits, of the organisation's rules and its week. */
export interface DayRulesOf
	extends Pick<TimesheetRules, "overtime" | "weekend" | "overtimeDayCap" | "overtimeWeekCap"> {
	/** The ISO weekday the organisation's week starts on: the week of the weekly cap. */
	weekStartsOn: number;
}

/** What an organisation starts with: no overtime, time on a day not worked counted as overtime, short notice with a reason. */
export const DEFAULT_RULES: TimesheetRules = {
	overtime: "none",
	weekend: "overtime",
	overtimeDayCap: null,
	overtimeWeekCap: null,
	shortNotice: "with-reason",
};

/** The rules in words, as Workspace settings offers them. */
export const OVERTIME_RULE_LABELS: Record<OvertimeRule, string> = {
	none: "Not allowed",
	allowed: "Allowed",
	approval: "Only with pre-approval",
};

export const NON_WORKING_RULE_LABELS: Record<NonWorkingRule, string> = {
	overtime: "Counts as overtime",
	none: "Not allowed",
};

export const SHORT_NOTICE_LABELS: Record<ShortNoticeRule, string> = {
	"with-reason": "Allowed with a reason",
	refused: "Not allowed",
};

/** The kinds of pre-approved work: overtime, weekend work, and work on a public holiday (decision 52). */
export const WORK_KINDS = ["overtime", "weekend", "holiday"] as const;
export const WorkKind = z.enum(WORK_KINDS);
export type WorkKind = z.infer<typeof WorkKind>;

export const WORK_KIND_LABELS: Record<WorkKind, string> = {
	overtime: "Overtime",
	weekend: "Weekend work",
	holiday: "Public holiday work",
};

/** A request for overtime or weekend work as the rules read it. */
export interface WorkRequestLike {
	userId: string;
	kind: WorkKind;
	startsOn: Day;
	endsOn: Day;
	minutesPerDay: number;
	status: LeaveStatus;
}

/** The most a request for overtime or weekend work asks for on one day, in minutes. */
export const MOST_WORK_MINUTES_A_DAY = 16 * 60;

/** The organisation's rules from a day on (TR-10, decision 53): a change of the rules applies from its day. */
export interface RulesVersion
	extends Pick<DayRulesOf, "overtime" | "weekend" | "overtimeDayCap" | "overtimeWeekCap"> {
	effectiveFrom: Day;
}

/** Everything that decides one person's limits: their leave calendar, the organisation's rules, and their approved work. */
export interface RulesCalendar extends LeaveCalendar {
	/** The organisation's rules before its first dated version: a day's version, then its schedule, may carry others (`rulesOn`). */
	rules: DayRulesOf;
	/** The organisation's dated changes of its rules, any order. None: `rules` hold every day. */
	versions?: readonly RulesVersion[];
	/** The person's requests for overtime, weekend and holiday work. Only approved ones count. */
	work: readonly WorkRequestLike[];
}

/** Why a day takes no time. */
export type Closed =
	| { why: "holiday"; name: string }
	| { why: "holiday-needs-approval"; name: string }
	| { why: "leave"; kindName: string }
	| { why: "weekend-not-allowed" };

/** Why a day that is open takes no overtime. */
export type NoOvertime = "not-allowed" | "needs-approval" | "weekend-needs-approval";

/** How much time one day of one person takes. */
export interface DayLimit {
	day: Day;
	status: DayStatus;
	/** The most regular minutes the day takes: its expected time less leave. 0 on a closed day or a day not worked. */
	regularMinutes: number;
	/** Why the day takes no time at all; null when it takes some. */
	closed: Closed | null;
	/**
	 * The most overtime minutes the day takes on its own, before the week's
	 * cap: null for no limit, 0 for none.
	 */
	overtimeMinutes: number | null;
	/** Why the day takes no overtime, when it is open and takes none. */
	noOvertime: NoOvertime | null;
	/** The minutes of approved overtime or weekend work on it. */
	approvedMinutes: number;
}

/**
 * The rules that hold on `day` for the person: the organisation's version in
 * force on the day (TR-10), then their schedule's own overtime rule, with its
 * caps, and its own rule for days not worked, where it has them (TS-097).
 */
export function rulesOn<
	R extends Pick<DayRulesOf, "overtime" | "weekend" | "overtimeDayCap" | "overtimeWeekCap">,
>(calendar: { rules: R; timetable: Timetable; versions?: readonly RulesVersion[] }, day: Day): R {
	const base = versionOn(calendar.rules, calendar.versions, day);
	const own = calendar.timetable(day).rules;
	if (!own.overtime && !own.weekend) return base;
	return {
		...base,
		...(own.overtime && {
			overtime: own.overtime.policy,
			overtimeDayCap: own.overtime.dayCap,
			overtimeWeekCap: own.overtime.weekCap,
		}),
		...(own.weekend && { weekend: own.weekend }),
	};
}

/** The organisation's rules in force on `day`: its latest version from that day or before, else `rules`. */
export function versionOn<
	R extends Pick<DayRulesOf, "overtime" | "weekend" | "overtimeDayCap" | "overtimeWeekCap">,
>(rules: R, versions: readonly RulesVersion[] | undefined, day: Day): R {
	let found: RulesVersion | undefined;
	for (const version of versions ?? []) {
		if (version.effectiveFrom > day) continue;
		if (!found || version.effectiveFrom > found.effectiveFrom) found = version;
	}
	if (!found) return rules;
	return {
		...rules,
		overtime: found.overtime,
		weekend: found.weekend,
		overtimeDayCap: found.overtimeDayCap,
		overtimeWeekCap: found.overtimeWeekCap,
	};
}

/** The approved minutes of `kind` on `day`: the sum of the approved requests that cover it. */
export function approvedWorkMinutes(
	work: readonly WorkRequestLike[],
	kind: WorkKind,
	day: Day,
): number {
	let sum = 0;
	for (const request of work) {
		if (request.status !== "approved" || request.kind !== kind) continue;
		if (day < request.startsOn || day > request.endsOn) continue;
		sum += request.minutesPerDay;
	}
	return sum;
}

/** The lesser of two limits, null being none. */
function least(a: number | null, b: number | null): number | null {
	if (a === null) return b;
	if (b === null) return a;
	return Math.min(a, b);
}

/** The overtime an open day takes, and why none, by the rules and what is approved for it. */
function overtimeOf(
	rules: DayRulesOf,
	approved: number,
	workingDay: boolean,
): { overtimeMinutes: number | null; noOvertime: NoOvertime | null } {
	switch (rules.overtime) {
		case "none":
			return { overtimeMinutes: 0, noOvertime: "not-allowed" };
		case "allowed":
			return { overtimeMinutes: rules.overtimeDayCap, noOvertime: null };
		case "approval":
			if (approved === 0) {
				return {
					overtimeMinutes: 0,
					noOvertime: workingDay ? "needs-approval" : "weekend-needs-approval",
				};
			}
			return { overtimeMinutes: least(approved, rules.overtimeDayCap), noOvertime: null };
	}
}

/** The limit of `day` for the person whose calendar this is. */
export function dayLimit(calendar: RulesCalendar, day: Day): DayLimit {
	const status = dayStatus(calendar, day);
	const { is } = status;
	const rules = rulesOn(calendar, day);
	const closed = (why: Closed): DayLimit => ({
		day,
		status,
		regularMinutes: 0,
		closed: why,
		overtimeMinutes: 0,
		noOvertime: null,
		approvedMinutes: 0,
	});
	switch (is.kind) {
		case "holiday": {
			// Work on a public holiday is overtime, taken only as far as approved
			// holiday work covers it, wherever overtime is allowed at all (decision 52).
			if (rules.overtime === "none") return closed({ why: "holiday", name: is.name });
			const approved = approvedWorkMinutes(calendar.work, "holiday", day);
			if (approved === 0) return closed({ why: "holiday-needs-approval", name: is.name });
			return {
				day,
				status,
				regularMinutes: 0,
				closed: null,
				overtimeMinutes: least(approved, rules.overtimeDayCap),
				noOvertime: null,
				approvedMinutes: approved,
			};
		}
		case "not-a-working-day": {
			if (rules.weekend === "none") return closed({ why: "weekend-not-allowed" });
			const approved = approvedWorkMinutes(calendar.work, "weekend", day);
			return {
				day,
				status,
				regularMinutes: 0,
				closed: null,
				...overtimeOf(rules, approved, false),
				approvedMinutes: approved,
			};
		}
		case "leave":
		case "working": {
			if (is.kind === "leave" && is.halves === 2) {
				return closed({ why: "leave", kindName: is.request.kindName });
			}
			const approved = approvedWorkMinutes(calendar.work, "overtime", day);
			const half = Math.floor(status.expectedMinutes);
			const overtime = overtimeOf(rules, approved, true);
			if (is.kind === "working" || overtime.noOvertime) {
				return {
					day,
					status,
					regularMinutes: half,
					closed: null,
					...overtime,
					approvedMinutes: approved,
				};
			}
			// A day of half-day leave that takes more than its half (decision 50):
			// the time past the half is regular until the day reaches its full
			// expected hours, and overtime only past them. Caps count overtime only.
			const room = Math.max(0, Math.floor(calendar.timetable(day).minutes) - half);
			if (rules.overtime === "allowed") {
				return {
					day,
					status,
					regularMinutes: half + room,
					closed: null,
					...overtime,
					approvedMinutes: approved,
				};
			}
			const regularMore = Math.min(room, approved);
			const rest = approved - regularMore;
			return {
				day,
				status,
				regularMinutes: half + regularMore,
				closed: null,
				overtimeMinutes: rest === 0 ? 0 : least(rest, rules.overtimeDayCap),
				noOvertime: rest === 0 ? "needs-approval" : null,
				approvedMinutes: approved,
			};
		}
	}
}

/** Each of `days` for the person, in order. */
export function dayLimits(calendar: RulesCalendar, days: readonly Day[]): DayLimit[] {
	return days.map((day) => dayLimit(calendar, day));
}

/** Milliseconds as whole minutes, as the Timesheet shows them: the seconds dropped. */
export function wholeMinutes(ms: number): number {
	return Math.floor(Math.max(0, ms) / 60_000);
}

/** The time of a day, or of a change, by kind, in milliseconds. */
export interface KindsMs {
	regularMs: number;
	overtimeMs: number;
}

/** The first day of the organisation's week that holds `day`. */
export function weekOf(rules: Pick<DayRulesOf, "weekStartsOn">, day: Day): Day {
	return periodContaining(day, rules.weekStartsOn).startsOn;
}

/** The Monday after `day`: the day a change of the rules applies from unless another is chosen (TR-10). */
export function nextMondayAfter(day: Day): Day {
	return addDays(periodContaining(day, 1).startsOn, 7);
}

/**
 * The overtime `day` takes, given the whole minutes of overtime recorded on
 * the days of its week before it: its own limit, held by what is left of the
 * week's cap. Null for no limit.
 */
export function overtimeAllowance(
	limit: Pick<DayLimit, "overtimeMinutes" | "closed">,
	rules: Pick<DayRulesOf, "overtimeWeekCap">,
	weekOvertimeBefore: number,
): number | null {
	if (limit.closed) return 0;
	if (limit.overtimeMinutes === 0) return 0;
	const weekLeft =
		rules.overtimeWeekCap === null ? null : Math.max(0, rules.overtimeWeekCap - weekOvertimeBefore);
	return least(limit.overtimeMinutes, weekLeft);
}

/** The whole minutes of regular time left on a day that holds `regularMs` of it. Never below 0. */
export function minutesLeft(limit: Pick<DayLimit, "regularMinutes">, regularMs: number): number {
	return wholeMinutes(limit.regularMinutes * 60_000 - regularMs);
}

/**
 * The whole minutes by which a day is over: regular time past its expected
 * time, and overtime past what the day takes of it (`allowance`, null for no
 * limit). 0 when it is not.
 */
export function minutesOver(
	limit: Pick<DayLimit, "regularMinutes">,
	tracked: KindsMs,
	allowance: number | null,
): number {
	const regular = Math.max(0, wholeMinutes(tracked.regularMs) - limit.regularMinutes);
	const overtime =
		allowance === null ? 0 : Math.max(0, wholeMinutes(tracked.overtimeMs) - allowance);
	return regular + overtime;
}

/** A day of the week by name: "Saturday". */
function weekdayName(day: Day): string {
	const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
	return WEEKDAY_NAMES[(weekday + 6) % 7] ?? "That day";
}

/**
 * Why a closed day takes no time, as a sentence: "Christmas Day is a public
 * holiday: no time can be tracked on it." `who` names the person whose day it
 * is, for someone else's time (an import, TR-18d): "Grace is on annual leave
 * that day."
 */
export function closedReason(closed: Closed, day: Day, who?: string): string {
	switch (closed.why) {
		case "holiday":
			return `${closed.name} is a public holiday: no time can be tracked on it.`;
		case "holiday-needs-approval":
			return `${closed.name} is a public holiday: time on it needs approved holiday work. Request it on Time off.`;
		case "leave":
			return who
				? `${who} is on ${closed.kindName.toLowerCase()} that day.`
				: `You are on ${closed.kindName.toLowerCase()} that day: no time can be tracked on it.`;
		case "weekend-not-allowed":
			return `${weekdayName(day)} is not a working day, and this organisation does not allow time on it.`;
	}
}

/** Why an open day takes no overtime, as a sentence. */
export function noOvertimeReason(why: NoOvertime, day: Day): string {
	switch (why) {
		case "not-allowed":
			return "This organisation does not allow overtime.";
		case "needs-approval":
			return "Overtime on this day needs pre-approval. Request it on Time off.";
		case "weekend-needs-approval":
			return `${weekdayName(day)} is not a working day: time on it needs approved weekend work. Request it on Time off.`;
	}
}

/** What a refused change says when it would take a day past its regular time: "This day has 3:45 left." */
export function leftMessage(minutes: number): string {
	return `This day has ${formatDuration(minutes * 60)} left.`;
}

/** The most minutes a day holds: a day holding more is over its limit (decision 52). */
export const MINUTES_A_DAY = 24 * 60;

/** What a day holding more than 24 hours is told, wherever it is flagged or blocks a week (decision 52). */
export const MORE_THAN_A_DAY = "A day cannot hold more than 24 hours.";

/** A day over its limit in words: "Over by 0:15", or "Over 24 hours by 3:30" for a day holding more than a day. */
export function overLabel(minutes: number, moreThanADay = false): string {
	const by = formatDuration(minutes * 60);
	return moreThanADay ? `Over 24 hours by ${by}` : `Over by ${by}`;
}

/**
 * Why a week with days over their limit cannot be submitted, naming each:
 * "Correct the days over their limit before you submit the week: Tue 10 Nov
 * over by 0:15." A day holding more than 24 hours says so, and the sentence
 * `MORE_THAN_A_DAY` follows (decision 52).
 */
export function overDaysRefusal(
	days: readonly Pick<DayRule, "day" | "overMinutes" | "moreThanADay">[],
): string {
	const named = days
		.map(
			(d) =>
				`${formatDay(d.day, "short")} ${overLabel(d.overMinutes, d.moreThanADay).toLowerCase()}`,
		)
		.join(", ");
	const more = days.some((d) => d.moreThanADay) ? ` ${MORE_THAN_A_DAY}` : "";
	return `Correct the days over their limit before you submit the week: ${named}.${more}`;
}

/** A change to one day of one kind, as `mayWrite` reads it. */
export interface Change {
	/** Whether the change is to overtime; else to regular time. */
	overtime: boolean;
	/** The time of the day of the change's kind that the change leaves alone. */
	othersMs: number;
	/** The time of what it changes, as it is, when that is of the same day and kind; else 0. */
	beforeMs: number;
	/** The time of what it changes, as it would be. */
	afterMs: number;
	/** The whole minutes of overtime on the days of the day's week before it. */
	weekOvertimeBefore: number;
	/** The whole minutes of overtime on the days of the day's week after it. */
	weekOvertimeAfter: number;
}

/** The verdict on a change: written, or refused with what to tell the person. */
export type Verdict = { ok: true } | { ok: false; message: string };

/** The overtime still to be had on the day, and whether the week's cap is what holds it. */
function overtimeLeft(
	limit: DayLimit,
	rules: Pick<DayRulesOf, "overtimeWeekCap">,
	change: Pick<Change, "othersMs" | "weekOvertimeBefore" | "weekOvertimeAfter">,
): { minutes: number | null; byWeek: boolean } {
	const others = wholeMinutes(change.othersMs);
	const ofDay = limit.overtimeMinutes === null ? null : Math.max(0, limit.overtimeMinutes - others);
	const ofWeek =
		rules.overtimeWeekCap === null
			? null
			: Math.max(
					0,
					rules.overtimeWeekCap - change.weekOvertimeBefore - change.weekOvertimeAfter - others,
				);
	const minutes = least(ofDay, ofWeek);
	return { minutes, byWeek: ofWeek !== null && (ofDay === null || ofWeek < ofDay) };
}

/**
 * Whether a change may be written on a day, and why not. A change that adds
 * nothing to its kind is always allowed, so that a day over its limit can be
 * trimmed and its entries moved. Regular time must fit in the day's expected
 * time; overtime must be allowed, and fit in what the day and its week take.
 * A refusal of regular time says what is left, and that more goes in as
 * overtime when the day takes some.
 */
export function mayWrite(
	limit: DayLimit,
	rules: Pick<DayRulesOf, "overtimeWeekCap">,
	change: Change,
): Verdict {
	if (change.afterMs <= change.beforeMs) return { ok: true };
	if (limit.closed) return { ok: false, message: closedReason(limit.closed, limit.day) };
	if (!change.overtime) {
		if (wholeMinutes(change.othersMs + change.afterMs) <= limit.regularMinutes) return { ok: true };
		return { ok: false, message: regularRefusal(limit, minutesLeft(limit, change.othersMs)) };
	}
	if (limit.noOvertime)
		return { ok: false, message: noOvertimeReason(limit.noOvertime, limit.day) };
	const left = overtimeLeft(limit, rules, change);
	if (left.minutes === null) return { ok: true };
	if (
		wholeMinutes(change.othersMs + change.afterMs) - wholeMinutes(change.othersMs) <=
		left.minutes
	)
		return { ok: true };
	const time = formatDuration(left.minutes * 60);
	return {
		ok: false,
		message: left.byWeek
			? `This week has ${time} of overtime left.`
			: `This day has ${time} of overtime left.`,
	};
}

/**
 * What a refusal of regular time says: what is left, and where more goes. A
 * day the week does not work has no regular time: its time is overtime.
 */
export function regularRefusal(limit: DayLimit, left: number): string {
	if (limit.status.is.kind === "holiday") {
		return `${limit.status.is.name} is a public holiday: track its time as overtime.`;
	}
	if (limit.status.is.kind === "not-a-working-day") {
		const name = weekdayName(limit.day);
		switch (limit.noOvertime) {
			case null:
				return `${name} is not a working day: track its time as overtime.`;
			case "not-allowed":
				return `${name} is not a working day, and this organisation does not allow overtime.`;
			default:
				return noOvertimeReason("weekend-needs-approval", limit.day);
		}
	}
	switch (limit.noOvertime) {
		case null:
			return `${leftMessage(left)} Track more as overtime.`;
		case "needs-approval":
			return `${leftMessage(left)} ${noOvertimeReason("needs-approval", limit.day)}`;
		default:
			return leftMessage(left);
	}
}

/**
 * Whether a timer may start on a day: not on a closed day, nor one with no
 * regular time left and no overtime to be had. `overtimeLeftMinutes` is what
 * the day and its week still take of overtime, null for no limit;
 * `overtimeHeldByWeek` says it is the week's cap that holds it, so that a
 * refusal names the week (TR-18a).
 */
export function mayStart(
	limit: DayLimit,
	regularMs: number,
	overtimeLeftMinutes: number | null,
	overtimeHeldByWeek = false,
): Verdict {
	if (limit.closed) return { ok: false, message: closedReason(limit.closed, limit.day) };
	const left = minutesLeft(limit, regularMs);
	if (left > 0) return { ok: true };
	if (!limit.noOvertime && overtimeLeftMinutes !== 0) return { ok: true };
	if (!limit.noOvertime) {
		return {
			ok: false,
			message: `This ${overtimeHeldByWeek ? "week" : "day"} has ${formatDuration(0)} of overtime left.`,
		};
	}
	return { ok: false, message: regularRefusal(limit, 0) };
}

/**
 * Where a timer stopped at `endedAt` is cut (TS-095): its regular time ends
 * when the day's expected time is used, `regularLeftMs` after it started, and
 * the rest is overtime, when the day takes overtime at all. Past a cap, or
 * when the day takes none, the rest is kept and the day is flagged over. A
 * rest of less than a whole minute is no cut: it stays with the regular time,
 * as the Timesheet counts whole minutes (TR-17).
 * Null `overtimeFrom` is no cut: the entry is all of the kind `overtime` says.
 */
export function splitAtLimit(
	entry: { startedAt: number; endedAt: number },
	regularLeftMs: number,
	overtimeOpen: boolean,
): { overtime: boolean; overtimeFrom: number | null } {
	const length = entry.endedAt - entry.startedAt;
	const left = Math.max(0, regularLeftMs);
	if (!overtimeOpen || length <= left) return { overtime: false, overtimeFrom: null };
	if (left === 0) return { overtime: true, overtimeFrom: null };
	if (length - left < 60_000) return { overtime: false, overtimeFrom: null };
	return { overtime: false, overtimeFrom: entry.startedAt + left };
}

/** One day as the Timesheet shows its limit: serialisable, for the loaders. */
export interface DayRule {
	day: Day;
	/** The most regular minutes the day takes: its expected time less leave. Never null since TS-095. */
	limitMinutes: number | null;
	/** Why the day takes no time, as a sentence; null when it takes some. */
	closedReason: string | null;
	/** The whole minutes tracked on it, regular and overtime. */
	trackedMinutes: number;
	/** The whole minutes of regular time tracked on it. */
	regularMinutes: number;
	/** The whole minutes of overtime tracked on it. */
	overtimeMinutes: number;
	/** The whole minutes of regular time left. Never null since TS-095. */
	leftMinutes: number | null;
	/** Whether the day takes overtime at all: false when not allowed, not approved, or closed. */
	overtimeOpen: boolean;
	/** The whole minutes of overtime the day still takes, its week's cap counted; null for no limit. */
	overtimeLeftMinutes: number | null;
	/** Why the day takes no overtime, as a sentence; null when it takes some, or is closed. */
	noOvertimeReason: string | null;
	/**
	 * What the day says once its regular time is used, as a refusal of more
	 * regular time does: where more goes, or why none can (`regularRefusal`);
	 * null for a closed day, which says `closedReason`.
	 */
	fullReason: string | null;
	/** The whole minutes it is over its limits, or past 24 hours where that is more; 0 when it is not. */
	overMinutes: number;
	/** Whether it holds more than 24 hours (decision 52): it says `MORE_THAN_A_DAY`. */
	moreThanADay: boolean;
	/** Minutes of approved overtime, weekend or holiday work on it. */
	approvedMinutes: number;
}

/**
 * Each of `days` with its limits, given the time of each kind tracked on each
 * day. `tracked` must also answer for the days of each day's week before it,
 * which hold the overtime the week's cap counts.
 */
export function dayRules(
	calendar: RulesCalendar,
	days: readonly Day[],
	tracked: (day: Day) => KindsMs,
): DayRule[] {
	return days.map((day) => {
		const limit = dayLimit(calendar, day);
		const ms = tracked(day);
		const rules = rulesOn(calendar, day);
		const before = weekOvertimeBetween(rules, weekOf(rules, day), day, tracked);
		const allowance = overtimeAllowance(limit, rules, before);
		const overtime = wholeMinutes(ms.overtimeMs);
		const trackedMinutes = wholeMinutes(ms.regularMs + ms.overtimeMs);
		const pastADay = Math.max(0, trackedMinutes - MINUTES_A_DAY);
		return {
			day,
			limitMinutes: limit.regularMinutes,
			closedReason: limit.closed ? closedReason(limit.closed, day) : null,
			trackedMinutes,
			regularMinutes: wholeMinutes(ms.regularMs),
			overtimeMinutes: overtime,
			leftMinutes: minutesLeft(limit, ms.regularMs),
			overtimeOpen: !limit.closed && !limit.noOvertime,
			overtimeLeftMinutes: allowance === null ? null : Math.max(0, allowance - overtime),
			noOvertimeReason: limit.noOvertime ? noOvertimeReason(limit.noOvertime, day) : null,
			fullReason: limit.closed ? null : regularRefusal(limit, 0),
			overMinutes: Math.max(minutesOver(limit, ms, allowance), pastADay),
			moreThanADay: pastADay > 0,
			approvedMinutes: limit.approvedMinutes,
		};
	});
}

/**
 * The whole minutes of overtime from `first` up to, not including, `day`: 0
 * when the week has no cap, as nothing then counts it.
 */
export function weekOvertimeBetween(
	rules: Pick<DayRulesOf, "overtimeWeekCap">,
	first: Day,
	day: Day,
	tracked: (day: Day) => KindsMs,
): number {
	if (rules.overtimeWeekCap === null || first >= day) return 0;
	let sum = 0;
	for (const each of daysFrom(first, addDays(day, -1)))
		sum += wholeMinutes(tracked(each).overtimeMs);
	return sum;
}

/**
 * Of which kind new time of `ms` on `day` is, given what is tracked: regular
 * while it fits in the day's expected hours, else overtime where the day and
 * its week take that much; else the refusal, as a CSV import reports a row it
 * skips (TS-095). Time is never cut here: a row is one kind or the other.
 */
export function kindOfNewTime(
	calendar: RulesCalendar,
	day: Day,
	ms: number,
	tracked: (day: Day) => KindsMs,
): { ok: true; overtime: boolean } | { ok: false; message: string } {
	const rules = rulesOn(calendar, day);
	const limit = dayLimit(calendar, day);
	const ofDay = tracked(day);
	const fresh = { beforeMs: 0, afterMs: ms, weekOvertimeBefore: 0, weekOvertimeAfter: 0 };
	const regular = mayWrite(limit, rules, { ...fresh, overtime: false, othersMs: ofDay.regularMs });
	if (regular.ok) return { ok: true, overtime: false };
	if (limit.closed || limit.noOvertime) return regular;
	const week = weekOf(rules, day);
	const overtime = mayWrite(limit, rules, {
		...fresh,
		overtime: true,
		othersMs: ofDay.overtimeMs,
		weekOvertimeBefore: weekOvertimeBetween(rules, week, day, tracked),
		weekOvertimeAfter: weekOvertimeBetween(rules, addDays(day, 1), addDays(week, 7), tracked),
	});
	return overtime.ok ? { ok: true, overtime: true } : overtime;
}

// Notice for leave.

/** The days of notice each kind asks for when an organisation is made, as the migration gives them. */
export const DEFAULT_NOTICE_DAYS: Record<KindKey, number> = {
	annual: 14,
	sick: 0,
	study: 28,
	parental: 56,
	unpaid: 14,
	holiday: 0,
};

/** The most notice a kind may ask for, in working days. */
export const LONGEST_NOTICE_DAYS = 365;

/** The longest reason given for short notice: one line. */
export const NOTICE_REASON_MAX_LENGTH = 200;

/** The kinds never held to notice: sick leave, and public holidays, which nobody asks for. */
export function heldToNotice(kind: { key: KindKey }): boolean {
	return kind.key !== "sick" && kind.key !== "holiday";
}

/** The working days of notice a kind asks for: none for a kind never held to it. */
export function noticeAsked(kind: { key: KindKey; noticeDays: number }): number {
	return heldToNotice(kind) ? kind.noticeDays : 0;
}

/** Whether a person works on a day: their schedule works it and it is no public holiday (`isWorkingDay`). */
export type WorksOn = (day: Day) => boolean;

/**
 * The first day a request takes (TR-16): its first working day, a public
 * holiday or a day off before it not counted. The first day of the span when
 * it holds no working day.
 */
export function firstDayTaken(span: { startsOn: Day; endsOn: Day }, worksOn: WorksOn): Day {
	return daysFrom(span.startsOn, span.endsOn).find(worksOn) ?? span.startsOn;
}

/**
 * The notice given by asking on `today` for leave whose first day taken is
 * `firstDay` (decision 51): the working days after `today` up to and including
 * `firstDay`, so that for someone who works every day it is the count of
 * calendar days. Negative once the leave has begun, in calendar days.
 */
export function noticeGiven(today: Day, firstDay: Day, worksOn: WorksOn): number {
	if (firstDay <= today) {
		return Math.round(
			(Date.parse(`${firstDay}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
		);
	}
	return daysFrom(addDays(today, 1), firstDay).filter(worksOn).length;
}

/** The longest run of days searched for working days: two years and a little. */
const NOTICE_SEARCH_DAYS = 800;

/** The first day that can be asked for on `today` with the notice a kind asks, counted in working days. */
export function earliestNoticed(
	kind: { key: KindKey; noticeDays: number },
	today: Day,
	worksOn: WorksOn,
): Day {
	const asked = noticeAsked(kind);
	if (asked === 0) return today;
	let counted = 0;
	for (let ahead = 1; ahead <= NOTICE_SEARCH_DAYS; ahead++) {
		const day = addDays(today, ahead);
		if (worksOn(day) && ++counted === asked) return day;
	}
	return addDays(today, asked);
}

/** Whether asking on `today` for leave whose first day taken is `firstDay` gives less notice than the kind asks. */
export function isShortNotice(
	kind: { key: KindKey; noticeDays: number },
	today: Day,
	firstDay: Day,
	worksOn: WorksOn,
): boolean {
	const asked = noticeAsked(kind);
	return asked > 0 && noticeGiven(today, firstDay, worksOn) < asked;
}

/** Working days as words: "1 working day", "14 working days". */
export function workingDaysLabel(days: number): string {
	return `${days} ${days === 1 ? "working day" : "working days"}`;
}

/** The notice a request gave, as an approver reads it: "Short notice (3 working days)", "14 working days' notice". */
export function noticeLabel(request: { noticeDays: number; shortNotice: boolean }): string {
	const given = Math.max(0, request.noticeDays);
	if (request.shortNotice) return `Short notice (${workingDaysLabel(given)})`;
	return given === 1 ? "1 working day's notice" : `${given} working days' notice`;
}

// Requests for overtime, weekend work and work on a public holiday.

/**
 * Whether the organisation's rules let a person ask for `kind`: overtime only
 * while it needs pre-approval, and weekend work only while time on a day not
 * worked counts as overtime too (TS-095); work on a public holiday wherever
 * overtime is allowed at all, as it always needs pre-approval (decision 52).
 */
export function mayAskFor(rules: Pick<TimesheetRules, "overtime" | "weekend">, kind: WorkKind) {
	if (kind === "holiday") return rules.overtime !== "none";
	if (rules.overtime !== "approval") return false;
	return kind === "overtime" || rules.weekend === "overtime";
}

/**
 * The days of a span a request of `kind` applies to: working days without a
 * holiday or whole-day leave for overtime, days the week does not work (and
 * no public holiday) for weekend work, public holidays for holiday work.
 */
export function workDays(
	calendar: LeaveCalendar,
	kind: WorkKind,
	span: { startsOn: Day; endsOn: Day },
): Day[] {
	return daysFrom(span.startsOn, span.endsOn).filter((day) => {
		const { is } = dayStatus(calendar, day);
		if (kind === "weekend") return is.kind === "not-a-working-day";
		if (kind === "holiday") return is.kind === "holiday";
		return is.kind === "working" || (is.kind === "leave" && is.halves === 1);
	});
}

/** Whether `day` is worked in the person's schedule at all, before holidays and leave. */
export function inWorkingWeek(calendar: Pick<LeaveCalendar, "timetable">, day: Day): boolean {
	return calendar.timetable(day).minutes > 0;
}
