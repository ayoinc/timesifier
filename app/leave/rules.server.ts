import { env } from "cloudflare:workers";
import { and, eq, gte, inArray, lt, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { type OrganisationScope, organisations } from "~/db";
import { bounds, type Day, dayOf, daysFrom } from "~/time/calendar";
import { LeaveStatus } from "./kinds";
import { calendarOf, leaveContext } from "./leave.server";
import {
	type DayRule,
	DEFAULT_RULES,
	dayLimit,
	dayRules,
	mayStart,
	mayWrite,
	type RulesCalendar,
	ShortNoticeRule,
	type TimesheetRules,
	WorkKind,
	type WorkRequestLike,
	WorkRule,
} from "./rules";

/**
 * The timesheet rules of TS-090 as the database holds them: the
 * organisation's settings, the approved overtime and weekend work, and the
 * checks each writer of time entries makes before it writes. The rules
 * themselves are `rules.ts`.
 */

/** The organisation's timesheet rules. A value this application does not know is read as the default. */
export async function timesheetRulesOf(organisationId: string): Promise<TimesheetRules> {
	const [row] = await drizzle(env.DB)
		.select({
			overtime: organisations.overtimeRule,
			weekend: organisations.weekendRule,
			shortNotice: organisations.shortNotice,
		})
		.from(organisations)
		.where(eq(organisations.id, organisationId))
		.limit(1);
	return {
		overtime: WorkRule.catch(DEFAULT_RULES.overtime).parse(row?.overtime),
		weekend: WorkRule.catch(DEFAULT_RULES.weekend).parse(row?.weekend),
		shortNotice: ShortNoticeRule.catch(DEFAULT_RULES.shortNotice).parse(row?.shortNotice),
	};
}

/** Changes the organisation's timesheet rules. Who may is the caller's to decide. */
export async function setTimesheetRules(
	organisationId: string,
	rules: Partial<TimesheetRules>,
): Promise<void> {
	await drizzle(env.DB)
		.update(organisations)
		.set({
			...(rules.overtime ? { overtimeRule: rules.overtime } : {}),
			...(rules.weekend ? { weekendRule: rules.weekend } : {}),
			...(rules.shortNotice ? { shortNotice: rules.shortNotice } : {}),
			updatedAt: new Date(),
		})
		.where(eq(organisations.id, organisationId));
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
		timesheetRulesOf(scope.organisationId),
		approvedWorkOf(scope, [userId], first, last),
	]);
	return { ...calendarOf(context, userId), rules, work };
}

/** An entry as the checks read it. */
interface Timed {
	id: string;
	startedAt: number;
	endedAt: number | null;
}

/** The milliseconds of `entries` that start on `day` in `zone`, a running one counted to `now`. */
export function trackedOn(entries: readonly Timed[], day: Day, zone: string, now: number): number {
	let sum = 0;
	for (const entry of entries) {
		if (dayOf(entry.startedAt, zone) !== day) continue;
		sum += Math.max(0, (entry.endedAt ?? now) - entry.startedAt);
	}
	return sum;
}

/** The entries of `userId` that start from `first` to `last` in `zone`. */
async function entriesOfDays(
	scope: OrganisationScope,
	userId: string,
	first: Day,
	last: Day,
	zone: string,
): Promise<Timed[]> {
	const { from, to } = bounds(first, last, zone);
	const rows = await scope.timeEntries.select((e) =>
		and(eq(e.userId, userId), gte(e.startedAt, new Date(from)), lt(e.startedAt, new Date(to))),
	);
	return rows.map((row) => ({
		id: row.id,
		startedAt: row.startedAt.getTime(),
		endedAt: row.endedAt?.getTime() ?? null,
	}));
}

/**
 * Each of `days` of `userId` with its limit and what is tracked on it, from
 * `entries` that the caller has already read: what the Timesheet's views show.
 */
export async function dayRulesOf(
	scope: OrganisationScope,
	userId: string,
	days: readonly Day[],
	entries: readonly Timed[],
	zone: string,
	now: number,
): Promise<DayRule[]> {
	const first = days[0];
	const last = days.at(-1);
	if (!first || !last) return [];
	const calendar = await rulesCalendarOf(scope, userId, first, last);
	return dayRules(calendar, days, (day) => trackedOn(entries, day, zone, now));
}

/** A change to one day, as a writer of entries describes it. */
export interface DayChange {
	/** The day the entry belongs to after the change. */
	day: Day;
	/** The entry the change replaces, which is not counted as the day's other time; null for a new one. */
	replaces: string | null;
	/** How long the entry is after the change. */
	afterMs: number;
}

/**
 * Whether `userId` may make `change`: null when they may, else what to tell
 * them ("This day has 3:45 left."). A day with no limit is not read further.
 */
export async function refusalOf(
	scope: OrganisationScope,
	userId: string,
	zone: string,
	now: number,
	change: DayChange,
): Promise<string | null> {
	const calendar = await rulesCalendarOf(scope, userId, change.day, change.day);
	const limit = dayLimit(calendar, change.day);
	if (limit.limitMinutes === null && !limit.closed) return null;
	const entries = await entriesOfDays(scope, userId, change.day, change.day, zone);
	const replaced = entries.find((entry) => entry.id === change.replaces);
	const others = entries.filter((entry) => entry.id !== change.replaces);
	const verdict = mayWrite(limit, {
		othersMs: trackedOn(others, change.day, zone, now),
		beforeMs: replaced ? trackedOn([replaced], change.day, zone, now) : 0,
		afterMs: change.afterMs,
	});
	return verdict.ok ? null : verdict.message;
}

/** Whether `userId` may start a timer at `now`: null when they may, else what to tell them. */
export async function startRefusalOf(
	scope: OrganisationScope,
	userId: string,
	zone: string,
	now: number,
): Promise<string | null> {
	const day = dayOf(now, zone);
	const calendar = await rulesCalendarOf(scope, userId, day, day);
	const limit = dayLimit(calendar, day);
	if (limit.limitMinutes === null && !limit.closed) return null;
	const entries = await entriesOfDays(scope, userId, day, day, zone);
	// The running entry is stopped as the new one starts: what it has run counts.
	const verdict = mayStart(limit, trackedOn(entries, day, zone, now));
	return verdict.ok ? null : verdict.message;
}

/** The days from `first` to `last` on which `userId` has tracked more than the day takes. */
export async function daysOver(
	scope: OrganisationScope,
	userId: string,
	first: Day,
	last: Day,
	zone: string,
	now: number,
): Promise<DayRule[]> {
	const [calendar, entries] = await Promise.all([
		rulesCalendarOf(scope, userId, first, last),
		entriesOfDays(scope, userId, first, last, zone),
	]);
	return dayRules(calendar, daysFrom(first, last), (day) =>
		trackedOn(entries, day, zone, now),
	).filter((day) => day.overMinutes > 0);
}
