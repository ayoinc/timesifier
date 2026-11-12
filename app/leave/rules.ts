import * as z from "zod";

import { addDays, type Day, daysFrom } from "~/time/calendar";

import { type DayStatus, dayStatus, type LeaveCalendar, weekMinutes } from "./days";
import type { KindKey, LeaveStatus } from "./kinds";
import { minutesLabel, WEEKDAY_NAMES } from "./words";

/**
 * Leave and tracked time together (TS-090): how much time a day of a person
 * takes, and whether leave was asked for in good time. Nothing here reads the
 * database or a clock; the server gathers a `RulesCalendar` and these rules
 * read it, the same in the Worker and the browser.
 *
 * A day's limit is what is expected of the person on it, less their leave,
 * plus the overtime or weekend work approved for it:
 *
 * - A public holiday, or a day of whole-day leave, is closed: no time at all.
 * - A day of half-day leave takes the other half of its expected time, and
 *   more only by approved overtime, whatever the organisation's overtime rule.
 * - Any other working day takes any time while overtime is allowed freely;
 *   else its expected time and the overtime approved for it.
 * - A day the working week does not work takes any time while weekend work is
 *   allowed freely; with pre-approval, the weekend work approved for it, and
 *   is closed without; never, when weekend work is not allowed.
 *
 * Time is the person's entries that start on the day, a running one counted
 * to now, in whole minutes, as the Timesheet adds it up.
 */

/** How an organisation treats time beyond what is expected: allowed freely, only with pre-approval, or not at all. */
export const WORK_RULES = ["free", "approval", "none"] as const;
export const WorkRule = z.enum(WORK_RULES);
export type WorkRule = z.infer<typeof WorkRule>;

/** Whether leave asked for at shorter notice than its kind's is allowed with a reason, or refused. */
export const SHORT_NOTICE_RULES = ["with-reason", "refused"] as const;
export const ShortNoticeRule = z.enum(SHORT_NOTICE_RULES);
export type ShortNoticeRule = z.infer<typeof ShortNoticeRule>;

/** The organisation's timesheet rules (Workspace settings, Timesheet rules). */
export interface TimesheetRules {
	overtime: WorkRule;
	weekend: WorkRule;
	shortNotice: ShortNoticeRule;
}

/** What an organisation starts with: everything allowed freely, short notice with a reason. */
export const DEFAULT_RULES: TimesheetRules = {
	overtime: "free",
	weekend: "free",
	shortNotice: "with-reason",
};

/** The rules in words, as Workspace settings offers them. */
export const WORK_RULE_LABELS: Record<WorkRule, string> = {
	free: "Allowed freely",
	approval: "Only with pre-approval",
	none: "Not allowed",
};

export const SHORT_NOTICE_LABELS: Record<ShortNoticeRule, string> = {
	"with-reason": "Allowed with a reason",
	refused: "Not allowed",
};

/** The two kinds of pre-approved work. */
export const WORK_KINDS = ["overtime", "weekend"] as const;
export const WorkKind = z.enum(WORK_KINDS);
export type WorkKind = z.infer<typeof WorkKind>;

export const WORK_KIND_LABELS: Record<WorkKind, string> = {
	overtime: "Overtime",
	weekend: "Weekend work",
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

/** Everything that decides one person's limits: their leave calendar, the rules, and their approved work. */
export interface RulesCalendar extends LeaveCalendar {
	rules: Pick<TimesheetRules, "overtime" | "weekend">;
	/** The person's requests for overtime and weekend work. Only approved ones count. */
	work: readonly WorkRequestLike[];
}

/** Why a day takes no time. */
export type Closed =
	| { why: "holiday"; name: string }
	| { why: "leave"; kindName: string }
	| { why: "weekend-needs-approval" }
	| { why: "weekend-not-allowed" };

/** How much time one day of one person takes. */
export interface DayLimit {
	day: Day;
	status: DayStatus;
	/** The most minutes the day takes; null for no limit. 0 on a closed day. */
	limitMinutes: number | null;
	/** Why the day takes no time at all; null when it takes some. */
	closed: Closed | null;
	/** The minutes of approved overtime or weekend work on it, counted in the limit. */
	approvedMinutes: number;
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

/** The limit of `day` for the person whose calendar this is. */
export function dayLimit(calendar: RulesCalendar, day: Day): DayLimit {
	const status = dayStatus(calendar, day);
	const { is } = status;
	const closed = (why: Closed): DayLimit => ({
		day,
		status,
		limitMinutes: 0,
		closed: why,
		approvedMinutes: 0,
	});
	switch (is.kind) {
		case "holiday":
			return closed({ why: "holiday", name: is.name });
		case "not-a-working-day": {
			if (calendar.rules.weekend === "free") {
				return { day, status, limitMinutes: null, closed: null, approvedMinutes: 0 };
			}
			if (calendar.rules.weekend === "none") return closed({ why: "weekend-not-allowed" });
			const approved = approvedWorkMinutes(calendar.work, "weekend", day);
			if (approved === 0) return closed({ why: "weekend-needs-approval" });
			return { day, status, limitMinutes: approved, closed: null, approvedMinutes: approved };
		}
		case "leave": {
			if (is.halves === 2) return closed({ why: "leave", kindName: is.request.kindName });
			const approved = approvedWorkMinutes(calendar.work, "overtime", day);
			return {
				day,
				status,
				limitMinutes: Math.floor(status.expectedMinutes) + approved,
				closed: null,
				approvedMinutes: approved,
			};
		}
		case "working": {
			if (calendar.rules.overtime === "free") {
				return { day, status, limitMinutes: null, closed: null, approvedMinutes: 0 };
			}
			const approved = approvedWorkMinutes(calendar.work, "overtime", day);
			return {
				day,
				status,
				limitMinutes: Math.floor(status.expectedMinutes) + approved,
				closed: null,
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

/** The whole minutes left on a day that holds `trackedMs`; null for no limit. Never below 0. */
export function minutesLeft(limit: Pick<DayLimit, "limitMinutes">, trackedMs: number) {
	return limit.limitMinutes === null ? null : wholeMinutes(limit.limitMinutes * 60_000 - trackedMs);
}

/** The whole minutes by which a day holding `trackedMs` is over its limit; 0 when it is not. */
export function minutesOver(limit: Pick<DayLimit, "limitMinutes">, trackedMs: number) {
	return limit.limitMinutes === null
		? 0
		: Math.max(0, wholeMinutes(trackedMs) - limit.limitMinutes);
}

/** A day of the week by name: "Saturday". */
function weekdayName(day: Day): string {
	const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
	return WEEKDAY_NAMES[(weekday + 6) % 7] ?? "That day";
}

/**
 * Why a closed day takes no time, as a sentence: "Christmas Day is a public
 * holiday: no time can be tracked on it."
 */
export function closedReason(closed: Closed, day: Day): string {
	switch (closed.why) {
		case "holiday":
			return `${closed.name} is a public holiday: no time can be tracked on it.`;
		case "leave":
			return `You are on ${closed.kindName.toLowerCase()} that day: no time can be tracked on it.`;
		case "weekend-needs-approval":
			return `${weekdayName(day)} is not a working day: time on it needs approved weekend work. Request it on Time off.`;
		case "weekend-not-allowed":
			return `${weekdayName(day)} is not a working day, and this organisation does not allow time on it.`;
	}
}

/** What a refused change says when it would take a day past its limit: "This day has 3:45 left." */
export function leftMessage(minutes: number): string {
	return `This day has ${minutesLabel(minutes)} left.`;
}

/** A day over its limit in words: "Over by 0:15". */
export function overLabel(minutes: number): string {
	return `Over by ${minutesLabel(minutes)}`;
}

/**
 * Whether a change may be written on a day, and why not. `othersMs` is the
 * time of the day the change leaves alone, `beforeMs` the time of what it
 * changes as it is, and `afterMs` as it would be. A change that adds nothing
 * is always allowed, so that a day over its limit can be trimmed and its
 * entries moved; anything else must fit in what the day has left.
 */
export function mayWrite(
	limit: DayLimit,
	change: { othersMs: number; beforeMs: number; afterMs: number },
): { ok: true } | { ok: false; message: string } {
	if (change.afterMs <= change.beforeMs) return { ok: true };
	if (limit.closed) return { ok: false, message: closedReason(limit.closed, limit.day) };
	if (limit.limitMinutes === null) return { ok: true };
	if (wholeMinutes(change.othersMs + change.afterMs) <= limit.limitMinutes) return { ok: true };
	return { ok: false, message: leftMessage(minutesLeft(limit, change.othersMs) ?? 0) };
}

/** Whether a timer may start on a day that holds `trackedMs`: not on a closed day, nor one with nothing left. */
export function mayStart(
	limit: DayLimit,
	trackedMs: number,
): { ok: true } | { ok: false; message: string } {
	if (limit.closed) return { ok: false, message: closedReason(limit.closed, limit.day) };
	if (limit.limitMinutes !== null && (minutesLeft(limit, trackedMs) ?? 0) === 0) {
		return { ok: false, message: leftMessage(0) };
	}
	return { ok: true };
}

/** One day as the Timesheet shows its limit: serialisable, for the loaders. */
export interface DayRule {
	day: Day;
	/** The most minutes the day takes; null for no limit. */
	limitMinutes: number | null;
	/** Why the day takes no time, as a sentence; null when it takes some. */
	closedReason: string | null;
	/** The whole minutes tracked on it. */
	trackedMinutes: number;
	/** The whole minutes left; null for no limit. */
	leftMinutes: number | null;
	/** The whole minutes it is over its limit; 0 when it is not. */
	overMinutes: number;
	/** Minutes of approved overtime or weekend work counted in the limit. */
	approvedMinutes: number;
}

/** Each of `days` with its limit, given the milliseconds tracked on each. */
export function dayRules(
	calendar: RulesCalendar,
	days: readonly Day[],
	trackedMs: (day: Day) => number,
): DayRule[] {
	return days.map((day) => {
		const limit = dayLimit(calendar, day);
		const ms = trackedMs(day);
		return {
			day,
			limitMinutes: limit.limitMinutes,
			closedReason: limit.closed ? closedReason(limit.closed, day) : null,
			trackedMinutes: wholeMinutes(ms),
			leftMinutes: minutesLeft(limit, ms),
			overMinutes: minutesOver(limit, ms),
			approvedMinutes: limit.approvedMinutes,
		};
	});
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

/** The most notice a kind may ask for, in days. */
export const LONGEST_NOTICE_DAYS = 365;

/** The longest reason given for short notice: one line. */
export const NOTICE_REASON_MAX_LENGTH = 200;

/** The kinds never held to notice: sick leave, and public holidays, which nobody asks for. */
export function heldToNotice(kind: { key: KindKey }): boolean {
	return kind.key !== "sick" && kind.key !== "holiday";
}

/** The days of notice a kind asks for: none for a kind never held to it. */
export function noticeAsked(kind: { key: KindKey; noticeDays: number }): number {
	return heldToNotice(kind) ? kind.noticeDays : 0;
}

/** The days of notice given by asking on `today` for leave from `startsOn`: negative once it has begun. */
export function noticeGiven(today: Day, startsOn: Day): number {
	return Math.round(
		(Date.parse(`${startsOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
	);
}

/** The first day that can be asked for on `today` with the notice a kind asks. */
export function earliestNoticed(kind: { key: KindKey; noticeDays: number }, today: Day): Day {
	return addDays(today, noticeAsked(kind));
}

/** Whether asking on `today` for leave from `startsOn` gives less notice than the kind asks. */
export function isShortNotice(
	kind: { key: KindKey; noticeDays: number },
	today: Day,
	startsOn: Day,
): boolean {
	const asked = noticeAsked(kind);
	return asked > 0 && noticeGiven(today, startsOn) < asked;
}

/** Days as words: "1 day", "14 days". */
export function daysLabel(days: number): string {
	return `${days} ${days === 1 ? "day" : "days"}`;
}

/** The notice a request gave, as an approver reads it: "Short notice (3 days)", "14 days' notice". */
export function noticeLabel(request: { noticeDays: number; shortNotice: boolean }): string {
	const given = Math.max(0, request.noticeDays);
	if (request.shortNotice) return `Short notice (${daysLabel(given)})`;
	return given === 1 ? "1 day's notice" : `${given} days' notice`;
}

// Requests for overtime and weekend work.

/** Whether the organisation's rules let a person ask for `kind`: only while it needs pre-approval. */
export function mayAskFor(rules: Pick<TimesheetRules, "overtime" | "weekend">, kind: WorkKind) {
	return (kind === "overtime" ? rules.overtime : rules.weekend) === "approval";
}

/**
 * The days of a span a request of `kind` applies to: working days without a
 * holiday or whole-day leave for overtime, days the week does not work (and
 * no public holiday) for weekend work.
 */
export function workDays(
	calendar: LeaveCalendar,
	kind: WorkKind,
	span: { startsOn: Day; endsOn: Day },
): Day[] {
	return daysFrom(span.startsOn, span.endsOn).filter((day) => {
		const { is } = dayStatus(calendar, day);
		if (kind === "weekend") return is.kind === "not-a-working-day";
		return is.kind === "working" || (is.kind === "leave" && is.halves === 1);
	});
}

/** Whether `day` is worked in the week at all, before holidays and leave. */
export function inWorkingWeek(calendar: Pick<LeaveCalendar, "week">, day: Day): boolean {
	return weekMinutes(calendar.week, day) > 0;
}
