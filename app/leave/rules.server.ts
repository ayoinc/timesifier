import { env } from "cloudflare:workers";
import { and, eq, gte, inArray, lt, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { ActivitySource } from "~/activity/actions";
import { record } from "~/activity/activity.server";
import { type OrganisationScope, organisationScope, organisations } from "~/db";
import { addDays, bounds, type Day, dayOf, daysFrom } from "~/time/calendar";
import { LeaveStatus } from "./kinds";
import { calendarOf, leaveContext } from "./leave.server";
import {
	type DayRule,
	type DayRulesOf,
	DEFAULT_RULES,
	dayLimit,
	dayRules,
	type KindsMs,
	mayStart,
	mayWrite,
	minutesLeft,
	NonWorkingRule,
	OvertimeRule,
	overtimeAllowance,
	type RulesCalendar,
	ShortNoticeRule,
	splitAtLimit,
	type TimesheetRules,
	WorkKind,
	type WorkRequestLike,
	weekOf,
	wholeMinutes,
} from "./rules";

/**
 * The timesheet rules of TS-090 and TS-095 as the database holds them: the
 * organisation's settings, the approved overtime and weekend work, and the
 * checks each writer of time entries makes before it writes. The rules
 * themselves are `rules.ts`.
 */

/** A cap as stored: a whole number of minutes more than none, or none. */
const cap = (minutes: number | null | undefined) =>
	typeof minutes === "number" && Number.isInteger(minutes) && minutes > 0 ? minutes : null;

/** The organisation's rules and its week, as a day's limits read them. A value this application does not know is read as the default. */
async function rulesRowOf(organisationId: string): Promise<TimesheetRules & DayRulesOf> {
	const [row] = await drizzle(env.DB)
		.select({
			overtime: organisations.overtimePolicy,
			weekend: organisations.nonWorkingDays,
			overtimeDayCap: organisations.overtimeDayCapMinutes,
			overtimeWeekCap: organisations.overtimeWeekCapMinutes,
			shortNotice: organisations.shortNotice,
			weekStartsOn: organisations.weekStartsOn,
		})
		.from(organisations)
		.where(eq(organisations.id, organisationId))
		.limit(1);
	return {
		overtime: OvertimeRule.catch(DEFAULT_RULES.overtime).parse(row?.overtime),
		weekend: NonWorkingRule.catch(DEFAULT_RULES.weekend).parse(row?.weekend),
		overtimeDayCap: cap(row?.overtimeDayCap),
		overtimeWeekCap: cap(row?.overtimeWeekCap),
		shortNotice: ShortNoticeRule.catch(DEFAULT_RULES.shortNotice).parse(row?.shortNotice),
		weekStartsOn: row?.weekStartsOn ?? 1,
	};
}

/** The organisation's timesheet rules. */
export async function timesheetRulesOf(organisationId: string): Promise<TimesheetRules> {
	const { weekStartsOn: _week, ...rules } = await rulesRowOf(organisationId);
	return rules;
}

/** The fields of the rules, as the activity log records them. */
const RULE_FIELDS = [
	"overtime",
	"weekend",
	"overtimeDayCap",
	"overtimeWeekCap",
	"shortNotice",
] as const satisfies readonly (keyof TimesheetRules)[];

/**
 * Changes the organisation's timesheet rules, with a row in the activity log
 * naming what changed (TS-095). A cap given as null is taken away; one left
 * out stays. Who may is the caller's to decide.
 */
export async function setTimesheetRules(
	organisationId: string,
	actorId: string,
	rules: Partial<TimesheetRules>,
	source: ActivitySource = "web",
): Promise<void> {
	const before = await timesheetRulesOf(organisationId);
	const after: TimesheetRules = { ...before, ...rules };
	const was: Record<string, string | number | null> = {};
	const is: Record<string, string | number | null> = {};
	for (const field of RULE_FIELDS) {
		if (before[field] === after[field]) continue;
		was[field] = before[field];
		is[field] = after[field];
	}
	if (Object.keys(is).length === 0) return;
	await drizzle(env.DB)
		.update(organisations)
		.set({
			overtimePolicy: after.overtime,
			nonWorkingDays: after.weekend,
			overtimeDayCapMinutes: after.overtimeDayCap,
			overtimeWeekCapMinutes: after.overtimeWeekCap,
			shortNotice: after.shortNotice,
			updatedAt: new Date(),
		})
		.where(eq(organisations.id, organisationId));
	await record(
		organisationScope(env.DB, organisationId),
		actorId,
		"timesheet_rules.changed",
		{ type: "organisation", id: organisationId, ownerId: null },
		{ before: was, after: is },
		source,
	);
}

/** The approved requests for overtime and weekend work of `userIds` that touch `first` to `last`. */
export async function approvedWorkOf(
	scope: OrganisationScope,
	userIds: readonly string[],
	first: Day,
	last: Day,
): Promise<WorkRequestLike[]> {
	const ids = [...new Set(userIds)];
	if (ids.length === 0) return [];
	const rows = await scope.workRequests.select((w) =>
		and(
			inArray(w.userId, ids),
			eq(w.status, "approved"),
			lte(w.startsOn, last),
			gte(w.endsOn, first),
		),
	);
	return rows.map((row) => ({
		userId: row.userId,
		kind: WorkKind.parse(row.kind),
		startsOn: row.startsOn,
		endsOn: row.endsOn,
		minutesPerDay: row.minutesPerDay,
		status: LeaveStatus.parse(row.status),
	}));
}

/** Everything that decides the limits of `userId` from `first` to `last`. */
export async function rulesCalendarOf(
	scope: OrganisationScope,
	userId: string,
	first: Day,
	last: Day,
): Promise<RulesCalendar> {
	const [context, rules, work] = await Promise.all([
		leaveContext(scope, [userId], first, last),
		rulesRowOf(scope.organisationId),
		approvedWorkOf(scope, [userId], first, last),
	]);
	return { ...calendarOf(context, userId), rules, work };
}

/** An entry as the checks read it, with the day it belongs to (TS-111). */
export interface Timed {
	id: string;
	startedAt: number | Date;
	endedAt: number | Date | null;
	overtime: boolean;
	day: Day;
}

/** The milliseconds of each kind of `entries` on `day`, a running one counted to `now`. */
export function trackedOn(entries: readonly Timed[], day: Day, now: number): KindsMs {
	const sum = { regularMs: 0, overtimeMs: 0 };
	for (const entry of entries) {
		if (entry.day !== day) continue;
		const ms = Math.max(0, Number(entry.endedAt ?? now) - Number(entry.startedAt));
		if (entry.overtime) sum.overtimeMs += ms;
		else sum.regularMs += ms;
	}
	return sum;
}

/** The entries of `userId` whose day is from `first` to `last`. */
async function entriesOfDays(
	scope: OrganisationScope,
	userId: string,
	first: Day,
	last: Day,
): Promise<Timed[]> {
	const rows = await scope.timeEntries.select((e) =>
		and(eq(e.userId, userId), gte(e.spentOn, first), lte(e.spentOn, last)),
	);
	return rows.map((row) => ({
		id: row.id,
		startedAt: row.startedAt.getTime(),
		endedAt: row.endedAt?.getTime() ?? null,
		overtime: row.overtime,
		day: row.spentOn,
	}));
}

/** The last day of the organisation's week that holds `day`. */
const weekEndOf = (rules: DayRulesOf, day: Day) => addDays(weekOf(rules, day), 6);

/**
 * Each of `days` of `userId` with its limits and what is tracked on it, from
 * `entries` that the caller has already read: what the Timesheet's views show.
 * While the organisation caps a week's overtime, the rest of each week is read
 * too, as its overtime counts.
 */
export async function dayRulesOf(
	scope: OrganisationScope,
	userId: string,
	days: readonly Day[],
	entries: readonly Timed[],
	now: number,
): Promise<DayRule[]> {
	const first = days[0];
	const last = days.at(-1);
	if (!first || !last) return [];
	const calendar = await rulesCalendarOf(scope, userId, first, last);
	const counted =
		calendar.rules.overtimeWeekCap === null
			? entries
			: await entriesOfDays(scope, userId, weekOf(calendar.rules, first), last);
	return dayRules(calendar, days, (day) => trackedOn(counted, day, now));
}

/** A change to one day, as a writer of entries describes it. */
export interface DayChange {
	/** The day the entry belongs to after the change. */
	day: Day;
	/** The entry the change replaces, which is not counted as the day's other time; null for a new one. */
	replaces: string | null;
	/** How long the entry is after the change. */
	afterMs: number;
	/** Whether the entry is overtime after the change. */
	overtime: boolean;
}

/** The whole minutes of overtime of `entries` on the days from `first` to `last`, both included. */
function overtimeBetween(
	entries: readonly Timed[],
	first: Day,
	last: Day,
	now: number,
) {
	if (first > last) return 0;
	let sum = 0;
	for (const day of daysFrom(first, last)) {
		sum += wholeMinutes(trackedOn(entries, day, now).overtimeMs);
	}
	return sum;
}

/**
 * Whether `userId` may make `change`: null when they may, else what to tell
 * them ("This day has 3:45 left."). Regular time is held to the day's
 * expected time; overtime to the organisation's rule, its caps, and what is
 * approved (TS-095).
 */
export async function refusalOf(
	scope: OrganisationScope,
	userId: string,
	now: number,
	change: DayChange,
): Promise<string | null> {
	const calendar = await rulesCalendarOf(scope, userId, change.day, change.day);
	const { rules } = calendar;
	const limit = dayLimit(calendar, change.day);
	const weekCapped = change.overtime && rules.overtimeWeekCap !== null;
	const entries = weekCapped
		? await entriesOfDays(scope, userId, weekOf(rules, change.day), weekEndOf(rules, change.day))
		: await entriesOfDays(scope, userId, change.day, change.day);
	const replaced = entries.find((entry) => entry.id === change.replaces);
	const others = entries.filter((entry) => entry.id !== change.replaces);
	const ofKind = (ms: KindsMs) => (change.overtime ? ms.overtimeMs : ms.regularMs);
	const verdict = mayWrite(limit, rules, {
		overtime: change.overtime,
		othersMs: ofKind(trackedOn(others, change.day, now)),
		beforeMs: replaced ? ofKind(trackedOn([replaced], change.day, now)) : 0,
		afterMs: change.afterMs,
		weekOvertimeBefore: weekCapped
			? overtimeBetween(others, weekOf(rules, change.day), addDays(change.day, -1), now)
			: 0,
		weekOvertimeAfter: weekCapped
			? overtimeBetween(others, addDays(change.day, 1), weekEndOf(rules, change.day), now)
			: 0,
	});
	return verdict.ok ? null : verdict.message;
}

/**
 * Whether `userId` may start a timer at `now`, and of which kind its entry
 * is: regular while today has regular time left, else overtime where today
 * takes it (TS-095). A refusal says what to tell them.
 */
export async function timerStartOf(
	scope: OrganisationScope,
	userId: string,
	zone: string,
	now: number,
): Promise<{ ok: true; overtime: boolean } | { ok: false; message: string }> {
	const day = dayOf(now, zone);
	const calendar = await rulesCalendarOf(scope, userId, day, day);
	const { rules } = calendar;
	const limit = dayLimit(calendar, day);
	const first = weekOf(rules, day);
	const last = addDays(first, 6);
	const entries = await entriesOfDays(scope, userId, first, last);
	// The running entry is stopped as the new one starts: what it has run counts.
	const tracked = trackedOn(entries, day, now);
	const ofDay = wholeMinutes(tracked.overtimeMs);
	const allowance = overtimeAllowance(
		limit,
		rules,
		overtimeBetween(entries, first, last, now) - ofDay,
	);
	const verdict = mayStart(
		limit,
		tracked.regularMs,
		allowance === null ? null : Math.max(0, allowance - ofDay),
	);
	if (!verdict.ok) return verdict;
	return { ok: true, overtime: minutesLeft(limit, tracked.regularMs) === 0 };
}

/**
 * Where an entry of regular time of `userId`, just stopped, is cut (TS-095,
 * `splitAtLimit`): what its day had left of regular time is regular, the
 * rest overtime while the day takes overtime at all. Overtime past a cap is
 * kept and the day flagged over; so is all of it where the day takes none.
 * The day is the entry's own, the one it started on, even when the cut falls
 * after midnight (TR-06).
 */
export async function stopSplitOf(
	scope: OrganisationScope,
	userId: string,
	stopped: { id: string; startedAt: number; endedAt: number; day: Day },
): Promise<{ overtime: boolean; overtimeFrom: number | null }> {
	const { day } = stopped;
	const [calendar, entries] = await Promise.all([
		rulesCalendarOf(scope, userId, day, day),
		entriesOfDays(scope, userId, day, day),
	]);
	const limit = dayLimit(calendar, day);
	const others = trackedOn(
		entries.filter((entry) => entry.id !== stopped.id),
		day,
		stopped.endedAt,
	);
	return splitAtLimit(
		stopped,
		limit.regularMinutes * 60_000 - others.regularMs,
		!limit.closed && !limit.noOvertime,
	);
}

/** The days from `first` to `last` on which `userId` has tracked more than the day takes. */
export async function daysOver(
	scope: OrganisationScope,
	userId: string,
	first: Day,
	last: Day,
	now: number,
): Promise<DayRule[]> {
	const calendar = await rulesCalendarOf(scope, userId, first, last);
	const entries = await entriesOfDays(
		scope,
		userId,
		calendar.rules.overtimeWeekCap === null ? first : weekOf(calendar.rules, first),
		last,
	);
	return dayRules(calendar, daysFrom(first, last), (day) => trackedOn(entries, day, now)).filter((day) => day.overMinutes > 0);
}
