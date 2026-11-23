import { env } from "cloudflare:workers";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { ActivitySource } from "~/activity/actions";
import { recordStatement } from "~/activity/activity.server";
import { among, type OrganisationScope, organisationScope, organisations } from "~/db";
import { addDays, type Day, dayOf, daysFrom } from "~/time/calendar";
import { formatDayWithYear } from "~/time/format";
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
	type RulesVersion,
	rulesOn,
	ShortNoticeRule,
	splitAtLimit,
	type TimesheetRules,
	versionOn,
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

/** The organisation's dated changes of its rules (TR-10), earliest first. */
export async function rulesVersionsOf(scope: OrganisationScope): Promise<RulesVersion[]> {
	const rows = await scope.timesheetRuleVersions.select(undefined, {
		orderBy: (v) => [asc(v.effectiveFrom)],
	});
	return rows.map((row) => ({
		effectiveFrom: row.effectiveFrom,
		overtime: OvertimeRule.catch(DEFAULT_RULES.overtime).parse(row.overtimePolicy),
		weekend: NonWorkingRule.catch(DEFAULT_RULES.weekend).parse(row.nonWorkingDays),
		overtimeDayCap: cap(row.overtimeDayCapMinutes),
		overtimeWeekCap: cap(row.overtimeWeekCapMinutes),
	}));
}

/**
 * The organisation's timesheet rules: those in force on `day` (TR-10) where it
 * is given, else those before any dated change. Short notice is not dated.
 */
export async function timesheetRulesOf(organisationId: string, day?: Day): Promise<TimesheetRules> {
	const [{ weekStartsOn: _week, ...rules }, versions] = await Promise.all([
		rulesRowOf(organisationId),
		day === undefined
			? Promise.resolve([])
			: rulesVersionsOf(organisationScope(env.DB, organisationId)),
	]);
	return day === undefined ? rules : versionOn(rules, versions, day);
}

/** The organisation's next dated change of its rules after `day`, if one is waiting. */
export async function nextRulesOf(organisationId: string, day: Day): Promise<RulesVersion | null> {
	const versions = await rulesVersionsOf(organisationScope(env.DB, organisationId));
	return versions.find((v) => v.effectiveFrom > day) ?? null;
}

/** The fields of the rules, as the activity log records them. */
const RULE_FIELDS = [
	"overtime",
	"weekend",
	"overtimeDayCap",
	"overtimeWeekCap",
	"shortNotice",
] as const satisfies readonly (keyof TimesheetRules)[];

/** The fields of the rules a day's limits read, which are dated (TR-10). */
const DATED_FIELDS = ["overtime", "weekend", "overtimeDayCap", "overtimeWeekCap"] as const;

/** What a change of the rules does to time already tracked: the days it puts over their limit, and whose. */
export interface RulesEffect {
	days: number;
	people: number;
}

/** The longest run of days a change of the rules is checked against tracked time. */
const EFFECT_DAYS = 366;

/**
 * The days of time already tracked from `from` that `next`, the rules from
 * that day on, would put over their limit that are not over now (TR-10).
 */
export async function rulesEffectOf(
	scope: OrganisationScope,
	from: Day,
	next: Omit<RulesVersion, "effectiveFrom">,
	now: number,
): Promise<RulesEffect> {
	const rows = await scope.timeEntries.select((e) =>
		and(gte(e.spentOn, from), lte(e.spentOn, addDays(from, EFFECT_DAYS))),
	);
	const lastOf = new Map<string, Day>();
	for (const row of rows) {
		const last = lastOf.get(row.userId);
		if (!last || row.spentOn > last) lastOf.set(row.userId, row.spentOn);
	}
	let days = 0;
	let people = 0;
	for (const [userId, last] of lastOf) {
		const calendar = await rulesCalendarOf(scope, userId, from, last);
		const entries = await entriesOfDays(scope, userId, weekOf(calendar.rules, from), last);
		const tracked = (day: Day) => trackedOn(entries, day, now);
		const span = daysFrom(from, last);
		const overNow = new Set(
			dayRules(calendar, span, tracked)
				.filter((d) => d.overMinutes > 0)
				.map((d) => d.day),
		);
		const changed: RulesCalendar = {
			...calendar,
			versions: [
				...(calendar.versions ?? []).filter((v) => v.effectiveFrom < from),
				{ ...next, effectiveFrom: from },
			],
		};
		const newlyOver = dayRules(changed, span, tracked).filter(
			(d) => d.overMinutes > 0 && !overNow.has(d.day),
		).length;
		if (newlyOver > 0) {
			days += newlyOver;
			people += 1;
		}
	}
	return { days, people };
}

/**
 * What saving the rules says (TR-10): from when they apply, and the days of
 * time already tracked they put over their limit, "This puts 3 days of 2
 * people over their limit." `effect` is null when no rule of a day changed.
 */
export function rulesSavedSentence(from: Day, effect: RulesEffect | null): string {
	if (effect === null) return "The timesheet rules are saved.";
	const applies = `The timesheet rules are saved. They apply from ${formatDayWithYear(from)}.`;
	if (effect.days === 0) return applies;
	const days = effect.days === 1 ? "1 day" : `${effect.days} days`;
	const people = effect.people === 1 ? "1 person" : `${effect.people} people`;
	return `${applies} This puts ${days} of ${people} over their limit.`;
}

/**
 * Changes the organisation's timesheet rules from `from` on (TR-10): the rules
 * a day's limits read apply to the days from `from`, as a dated version that
 * replaces any later one, and never to the days before it; short notice, which
 * is about requests rather than days, changes at once. One batch makes the
 * change and its row in the activity log, with before and after (TS-095). A
 * cap given as null is taken away; one left out stays. Who may is the
 * caller's to decide. Answers whether anything changed.
 */
export async function setTimesheetRules(
	organisationId: string,
	actorId: string,
	rules: Partial<TimesheetRules>,
	from: Day,
	source: ActivitySource = "web",
): Promise<boolean> {
	const scope = organisationScope(env.DB, organisationId);
	const before = await timesheetRulesOf(organisationId, from);
	const after: TimesheetRules = { ...before, ...rules };
	const was: Record<string, string | number | null> = {};
	const is: Record<string, string | number | null> = {};
	for (const field of RULE_FIELDS) {
		if (before[field] === after[field]) continue;
		was[field] = before[field];
		is[field] = after[field];
	}
	if (Object.keys(is).length === 0) return false;
	const dated = DATED_FIELDS.some((field) => field in is);
	if (dated) is.appliesFrom = from;
	const statements = [
		drizzle(env.DB)
			.update(organisations)
			.set({ shortNotice: after.shortNotice, updatedAt: new Date() })
			.where(eq(organisations.id, organisationId)),
		...(dated
			? [
					scope.timesheetRuleVersions.statements.delete((v) => gte(v.effectiveFrom, from)).query,
					scope.timesheetRuleVersions.statements.insert({
						effectiveFrom: from,
						overtimePolicy: after.overtime,
						nonWorkingDays: after.weekend,
						overtimeDayCapMinutes: after.overtimeDayCap,
						overtimeWeekCapMinutes: after.overtimeWeekCap,
					}).query,
				]
			: []),
		recordStatement(
			scope,
			actorId,
			"timesheet_rules.changed",
			{ type: "organisation", id: organisationId, ownerId: null },
			{ before: was, after: is },
			source,
		).query,
	] as const;
	await drizzle(env.DB).batch([statements[0], ...statements.slice(1)]);
	return true;
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
			among(w.userId, ids),
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
	const [context, rules, versions, work] = await Promise.all([
		leaveContext(scope, [userId], first, last),
		rulesRowOf(scope.organisationId),
		rulesVersionsOf(scope),
		approvedWorkOf(scope, [userId], first, last),
	]);
	return { ...calendarOf(context, userId), rules, versions, work };
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
	const counted = days.every((day) => rulesOn(calendar, day).overtimeWeekCap === null)
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
function overtimeBetween(entries: readonly Timed[], first: Day, last: Day, now: number) {
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
	const rules = rulesOn(calendar, change.day);
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
	const rules = rulesOn(calendar, day);
	const limit = dayLimit(calendar, day);
	const first = weekOf(rules, day);
	const last = addDays(first, 6);
	const entries = await entriesOfDays(scope, userId, first, last);
	// The running entry is stopped as the new one starts: what it has run counts.
	const tracked = trackedOn(entries, day, now);
	const ofDay = wholeMinutes(tracked.overtimeMs);
	const weekBefore = overtimeBetween(entries, first, last, now) - ofDay;
	const allowance = overtimeAllowance(limit, rules, weekBefore);
	const dayLeft =
		limit.overtimeMinutes === null ? null : Math.max(0, limit.overtimeMinutes - ofDay);
	const verdict = mayStart(
		limit,
		tracked.regularMs,
		allowance === null ? null : Math.max(0, allowance - ofDay),
		rules.overtimeWeekCap !== null &&
			(dayLeft === null || rules.overtimeWeekCap - weekBefore - ofDay < dayLeft),
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
	const days = daysFrom(first, last);
	const entries = await entriesOfDays(
		scope,
		userId,
		days.every((day) => rulesOn(calendar, day).overtimeWeekCap === null)
			? first
			: weekOf(calendar.rules, first),
		last,
	);
	return dayRules(calendar, days, (day) => trackedOn(entries, day, now)).filter(
		(day) => day.overMinutes > 0,
	);
}

/**
 * The days over their limit in each of `periods`, by period, for many people
 * at once (TR-01): what `daysOver` says of each, read in one query of each
 * kind whatever the number of people, for Approvals and Approve all. A period
 * with no day over is left out.
 */
export async function daysOverOf(
	scope: OrganisationScope,
	periods: readonly { id: string; userId: string; startsOn: Day; endsOn: Day }[],
	now: number,
): Promise<Map<string, DayRule[]>> {
	const over = new Map<string, DayRule[]>();
	if (periods.length === 0) return over;
	const ids = [...new Set(periods.map((p) => p.userId))];
	const first = periods.map((p) => p.startsOn).sort()[0] as Day;
	const last = periods
		.map((p) => p.endsOn)
		.sort()
		.at(-1) as Day;
	const rules = await rulesRowOf(scope.organisationId);
	const from = rules.overtimeWeekCap === null ? first : weekOf(rules, first);
	const [context, work, rows] = await Promise.all([
		leaveContext(scope, ids, first, last),
		approvedWorkOf(scope, ids, first, last),
		scope.timeEntries.select((e) =>
			and(among(e.userId, ids), gte(e.spentOn, from), lte(e.spentOn, last)),
		),
	]);
	for (const period of periods) {
		const calendar = {
			...calendarOf(context, period.userId),
			rules,
			work: work.filter((w) => w.userId === period.userId),
		};
		const entries: Timed[] = rows
			.filter((row) => row.userId === period.userId)
			.map((row) => ({
				id: row.id,
				startedAt: row.startedAt.getTime(),
				endedAt: row.endedAt?.getTime() ?? null,
				overtime: row.overtime,
				day: row.spentOn,
			}));
		const days = dayRules(calendar, daysFrom(period.startsOn, period.endsOn), (day) =>
			trackedOn(entries, day, now),
		).filter((day) => day.overMinutes > 0);
		if (days.length > 0) over.set(period.id, days);
	}
	return over;
}
