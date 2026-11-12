import { env } from "cloudflare:workers";
import { and, asc, desc, eq, gte, lt } from "drizzle-orm";

import { type Filter, type OrganisationScope, organisationScope, type ScopedAccessor } from "~/db";
import { type DayKind, dayLabel } from "~/leave/days";
import { daysOf } from "~/leave/leave.server";
import type { DayRule } from "~/leave/rules";
import { dayRulesOf } from "~/leave/rules.server";
import type { LockNotice, LockReason } from "~/locks/locks";
import { lockNoticeOf, lockReasonsOn } from "~/locks/locks.server";
import type { Membership } from "~/organisations/membership.server";
import { lockedDays } from "~/periods/locks.server";
import {
	type PeriodDays,
	PeriodStatus,
	periodAfter,
	periodBounds,
	periodContaining,
} from "~/periods/periods";
import { addDays, bounds, type Day, dayOf, daysFrom } from "~/time/calendar";
import { runningEntry } from "~/time/entries.server";
import { zoneOfMember } from "~/time/zones.server";

import { calendarDays, type DayStatus } from "./calendar-sheets";
import type { GettingStarted } from "./GettingStarted";
import { gettingStarted, type Marks } from "./getting-started.server";

import {
	HISTORY_LENGTH,
	type HistoryRow,
	historyRows,
	type PeriodState,
	periodState,
	type SheetEntry,
	totalOf,
	type WeekSheet,
	weekSheet,
} from "./sheets";
import type { CalendarScale, Zoom } from "./views";
import type { ChosenView } from "./views.server";

/**
 * What the views of Timesheet read (TS-012a, TS-013, TS-046, TS-052, TS-056). Every
 * query is the person's own entries and periods: these pages show nobody
 * else's time, whatever the role (TS-013, "Who may").
 */

type TimeEntries = OrganisationScope["timeEntries"] extends ScopedAccessor<infer T> ? T : never;

/**
 * The entries of `userId` that start in `span`. The organisation, the person
 * and the start are the columns of the index
 * `time_entries_organisation_id_user_id_started_at_idx`, in its order, so the
 * query is answered from it (TS-013).
 */
export function startingIn(
	userId: string,
	span: { from: number; to: number },
): Filter<TimeEntries> {
	return (e) =>
		and(
			eq(e.userId, userId),
			gte(e.startedAt, new Date(span.from)),
			lt(e.startedAt, new Date(span.to)),
		);
}

/** The entries of `userId` that start in `span`, earliest first, as the sheets read them. */
export async function entriesStartingIn(
	scope: OrganisationScope,
	userId: string,
	span: { from: number; to: number },
): Promise<SheetEntry[]> {
	const rows = await scope.timeEntries.select(startingIn(userId, span), {
		orderBy: (e) => [asc(e.startedAt)],
	});
	return rows.map(toSheetEntry);
}

export function toSheetEntry(row: TimeEntries["$inferSelect"]): SheetEntry {
	return {
		id: row.id,
		projectId: row.projectId,
		description: row.description,
		startedAt: row.startedAt.getTime(),
		endedAt: row.endedAt?.getTime() ?? null,
	};
}

/** A project as the views name it. An archived one is still named (TS-013). */
export interface ProjectName {
	id: string;
	name: string;
	archived: boolean;
}

/** Every project of the organisation, by name: the active ones are offered, all are named. */
async function projectsOf(scope: OrganisationScope): Promise<ProjectName[]> {
	const rows = await scope.projects.select(undefined, { orderBy: (p) => [asc(p.nameKey)] });
	return rows.map(({ id, name, archivedAt }) => ({ id, name, archived: archivedAt !== null }));
}

/** The period of `userId` that starts on `startsOn`, once it has been submitted; null before. */
export async function periodOf(scope: OrganisationScope, userId: string, startsOn: Day) {
	const [period] = await scope.periods.select(
		(p) => and(eq(p.userId, userId), eq(p.startsOn, startsOn)),
		{ limit: 1 },
	);
	if (!period) return null;
	return { ...period, status: PeriodStatus.parse(period.status) };
}

/** What every view shows: the projects, and the person's running entry for the timer. */
async function common(scope: OrganisationScope, userId: string) {
	const [projects, running] = await Promise.all([projectsOf(scope), runningEntry(scope, userId)]);
	return { projects, running: running ? toSheetEntry(running) : null };
}

/** What every view of Timesheet is given. */
export interface TimesheetBase {
	/** The zone the person's days are counted in. */
	zone: string;
	/** The time of the request. */
	now: number;
	today: Day;
	/** Every project of the organisation, by name; an archived one is named, not offered. */
	projects: ProjectName[];
	/** The person's running entry, wherever it started, for the timer. */
	running: SheetEntry | null;
}

/** Where a period stands, and what its one submission action reads (TS-046): the Day, Week and Calendar views'. */
export interface PeriodSubmission {
	period: PeriodDays;
	state: PeriodState;
	status: PeriodStatus | null;
	/** Why it was returned, while it stands returned. */
	comment: string | null;
	/** Whether a timer runs on a day of the week: the week cannot be submitted while one does. */
	runsInWeek: boolean;
	/** Whether the week has begun: a week to come cannot be submitted. */
	started: boolean;
	/** The days of the week over their limit: the week cannot be submitted until each is corrected (TS-090). */
	over: DayRule[];
}

/** One day of the person's week as leave sees it (TS-061). */
export interface DayAway {
	day: Day;
	/** What the day is: leave, a public holiday, a day not worked, or a working day. */
	kind: DayKind["kind"];
	/** Its name: "Annual leave", "Annual leave (half day)", the holiday's name, "Not a working day"; null for a working day. */
	label: string | null;
	/** The minutes expected of the person on it. */
	expectedMinutes: number;
}

/** The person's week as leave sees it: each day, and the minutes expected over it. */
export interface WeekAway {
	days: DayAway[];
	expectedMinutes: number;
}

async function weekAway(
	scope: OrganisationScope,
	userId: string,
	period: PeriodDays,
): Promise<WeekAway> {
	const statuses = await daysOf(scope, userId, period.startsOn, period.endsOn);
	return {
		days: statuses.map((status) => ({
			day: status.day,
			kind: status.is.kind,
			label: dayLabel(status),
			expectedMinutes: status.expectedMinutes,
		})),
		expectedMinutes: statuses.reduce((sum, s) => sum + s.expectedMinutes, 0),
	};
}

export interface DayData extends TimesheetBase {
	view: "day";
	day: Day;
	/** The day's entries, earliest first. */
	entries: SheetEntry[];
	total: number;
	/** Whether the day is in a submitted or approved period, or on or before the lock date. */
	locked: boolean;
	/** Why the day is locked, or null when it is not (`app/locks/locks.ts`). */
	lockReason: LockReason | null;
	/** The organisation's lock date and its reason, or null when it has none (TS-065). */
	lockDate: LockNotice | null;
	/** The seven days of the period the day is in, each with its total, and the period's: the Week view's sums (TS-056). */
	week: Pick<WeekSheet, "days" | "total">;
	/** The period the day is in, for the submission in the view's header row (TS-056, W29). */
	submission: PeriodSubmission;
	/** The steps of getting started and whether each is done, or null when the list is not shown (TS-056). */
	gettingStarted: GettingStarted | null;
	/** The days of the period as leave sees them, and the time expected over it (TS-061). */
	away: WeekAway;
	/** Each day of the period with its limit, what is left and what is over (TS-090). */
	rules: DayRule[];
}

export interface WeekData extends TimesheetBase, PeriodSubmission {
	view: "week";
	days: Day[];
	sheet: WeekSheet;
	/** The active projects with time in the week before, which "Copy last week's rows" adds (TS-052). */
	lastWeekProjects: string[];
	/** The days of the week in a submitted or approved period, or on or before the lock date. */
	lockedDays: Day[];
	/** The organisation's lock date and its reason, or null when it has none (TS-065). */
	lockDate: LockNotice | null;
	/** The days of the week as leave sees them, and the time expected over it (TS-061). */
	away: WeekAway;
	/** Each day of the week with its limit, what is left and what is over (TS-090). */
	rules: DayRule[];
}

export interface HistoryData extends TimesheetBase {
	view: "history";
	rows: HistoryRow[];
}

export interface CalendarData extends TimesheetBase {
	view: "calendar";
	scale: CalendarScale;
	zoom: Zoom;
	/** The day the calendar is on: the address's, or today. */
	date: Day;
	/** The days shown: one period, or the periods that cover the month (`calendarDays`). */
	days: Day[];
	/** The first day of the month shown, on the month's scale. */
	month: Day | null;
	/**
	 * The entries that start on the days shown, and those that start the day
	 * before and may run past its midnight onto the first of them: the views
	 * add up only the first, and draw both.
	 */
	entries: SheetEntry[];
	/** The days shown that are in a submitted or approved period. */
	lockedDays: Day[];
	/** The days shown as leave sees them (TS-061), which Track time reads as the Day view does. */
	away: WeekAway;
	/** What each day is besides its time: leave, a public holiday or a day not worked, muted when nothing is expected on it. */
	statuses: Partial<Record<Day, DayStatus>>;
	/** Each day shown with its limit, what is left and what is over (TS-090). */
	rules: DayRule[];
	/** The period shown and its submission, on the week's scale; null on the month's, which shows several. */
	submission: PeriodSubmission | null;
}

export type TimesheetData = DayData | WeekData | CalendarData | HistoryData;

/**
 * The data of the view `chosen` for the person behind `membership`, at `now`.
 * `marks` are what their browser holds of getting started.
 */
export async function timesheetData(
	membership: Membership,
	chosen: ChosenView,
	now: number,
	marks: Marks,
): Promise<TimesheetData> {
	const { user, organisation } = membership;
	const scope = organisationScope(env.DB, organisation.id);
	const zone = await zoneOfMember(membership);
	const today = dayOf(now, zone);
	const { projects, running } = await common(scope, user.id);
	const base: TimesheetBase = { zone, now, today, projects, running };

	switch (chosen.view) {
		case "day": {
			const day = chosen.day ?? today;
			const period = periodContaining(day, organisation.weekStartsOn);
			const [ofDay, steps] = await Promise.all([
				dayData(scope, user.id, day, period, zone, now),
				gettingStarted(scope, user.id, {
					hasActiveProject: projects.some((p) => !p.archived),
					weekOpened: marks.week,
					putAway: marks.away,
				}),
			]);
			return { ...base, ...ofDay, gettingStarted: steps };
		}
		case "week": {
			const period = periodContaining(chosen.start ?? today, organisation.weekStartsOn);
			return { ...base, ...(await weekData(scope, user.id, period, zone, now, projects)) };
		}
		case "calendar": {
			const date = chosen.date ?? today;
			const { days, month } = calendarDays(chosen.scale, date, organisation.weekStartsOn);
			const first = days[0] as Day;
			const last = days.at(-1) as Day;
			const [entries, locked, away] = await Promise.all([
				entriesStartingIn(scope, user.id, bounds(addDays(first, -1), last, zone)),
				lockedDays(scope, user.id, days),
				weekAway(scope, user.id, { startsOn: first, endsOn: last }),
			]);
			const period = month === null ? { startsOn: first, endsOn: last } : null;
			const [rules, row] = await Promise.all([
				dayRulesOf(scope, user.id, days, entries, zone, now),
				period ? periodOf(scope, user.id, period.startsOn) : null,
			]);
			return {
				...base,
				view: "calendar",
				scale: chosen.scale,
				zoom: chosen.zoom,
				date,
				days,
				month,
				entries,
				lockedDays: days.filter((day) => locked.has(day)),
				away,
				statuses: Object.fromEntries(
					away.days.flatMap(({ day, label, expectedMinutes }) =>
						label === null ? [] : [[day, { label, quiet: expectedMinutes === 0 }]],
					),
				),
				rules,
				submission: period ? submissionOf(period, row, entries, rules, zone, now) : null,
			};
		}
		case "history": {
			const current = periodContaining(today, organisation.weekStartsOn);
			return { ...base, ...(await historyData(scope, user.id, current, zone, now)) };
		}
	}
}

/**
 * The entries of `userId` in `period`, each of its days with its limit, and
 * where the period stands. The Week view and the Day view read all three from
 * here, so the totals, the limits and the submission each shows are the same.
 */
async function periodWithEntries(
	scope: OrganisationScope,
	userId: string,
	period: PeriodDays,
	zone: string,
	now: number,
): Promise<{ entries: SheetEntry[]; rules: DayRule[]; submission: PeriodSubmission }> {
	const days = daysFrom(period.startsOn, period.endsOn);
	const [entries, row] = await Promise.all([
		entriesStartingIn(scope, userId, periodBounds(period, zone)),
		periodOf(scope, userId, period.startsOn),
	]);
	const rules = await dayRulesOf(scope, userId, days, entries, zone, now);
	return { entries, rules, submission: submissionOf(period, row, entries, rules, zone, now) };
}

/** Where `period` stands, given its row of `periods` (null before it is submitted), the entries read around it and its days' limits. */
function submissionOf(
	period: PeriodDays,
	row: { status: PeriodStatus; comment: string | null } | null,
	entries: readonly SheetEntry[],
	rules: readonly DayRule[],
	zone: string,
	now: number,
): PeriodSubmission {
	const status = row?.status ?? null;
	const inPeriod = (day: Day) => period.startsOn <= day && day <= period.endsOn;
	return {
		period,
		state: periodState(status),
		status,
		comment: row?.status === "returned" ? row.comment : null,
		runsInWeek: entries.some(
			(entry) => entry.endedAt === null && inPeriod(dayOf(entry.startedAt, zone)),
		),
		started: period.startsOn <= dayOf(now, zone),
		over: rules.filter((rule) => rule.overMinutes > 0 && inPeriod(rule.day)),
	};
}

async function dayData(
	scope: OrganisationScope,
	userId: string,
	day: Day,
	period: PeriodDays,
	zone: string,
	now: number,
): Promise<Omit<DayData, keyof TimesheetBase | "gettingStarted">> {
	const [{ entries: ofPeriod, rules, submission }, reasons, lockDate, away] = await Promise.all([
		periodWithEntries(scope, userId, period, zone, now),
		lockReasonsOn(scope, userId, [day]),
		lockNoticeOf(scope.organisationId),
		weekAway(scope, userId, period),
	]);
	const entries = ofPeriod.filter((entry) => dayOf(entry.startedAt, zone) === day);
	const { days, total } = weekSheet(ofPeriod, daysFrom(period.startsOn, period.endsOn), zone, now);
	return {
		view: "day" as const,
		day,
		entries,
		total: totalOf(entries, now),
		locked: reasons.has(day),
		lockReason: reasons.get(day) ?? null,
		lockDate,
		week: { days, total },
		submission,
		away,
		rules,
	};
}

async function weekData(
	scope: OrganisationScope,
	userId: string,
	period: PeriodDays,
	zone: string,
	now: number,
	projects: readonly ProjectName[],
): Promise<Omit<WeekData, keyof TimesheetBase>> {
	const days = daysFrom(period.startsOn, period.endsOn);
	const before = periodAfter(period, -1);
	const [{ entries, rules, submission }, previous, locked, lockDate, away] = await Promise.all([
		periodWithEntries(scope, userId, period, zone, now),
		entriesStartingIn(scope, userId, periodBounds(before, zone)),
		lockedDays(scope, userId, days),
		lockNoticeOf(scope.organisationId),
		weekAway(scope, userId, period),
	]);
	const active = new Set(projects.filter((p) => !p.archived).map((p) => p.id));
	return {
		view: "week" as const,
		...submission,
		days,
		sheet: weekSheet(entries, days, zone, now, { projectOrder: projects.map((p) => p.id) }),
		lastWeekProjects: [...new Set(previous.map((e) => e.projectId))].filter((id) => active.has(id)),
		lockedDays: days.filter((day) => locked.has(day)),
		lockDate,
		away,
		rules,
	};
}

async function historyData(
	scope: OrganisationScope,
	userId: string,
	current: PeriodDays,
	zone: string,
	now: number,
): Promise<Omit<HistoryData, keyof TimesheetBase>> {
	const oldest = periodAfter(current, -(HISTORY_LENGTH - 1));
	const span = bounds(oldest.startsOn, current.endsOn, zone);
	const [entries, periods] = await Promise.all([
		entriesStartingIn(scope, userId, span),
		scope.periods.select((p) => and(eq(p.userId, userId), gte(p.startsOn, oldest.startsOn)), {
			orderBy: (p) => [desc(p.startsOn)],
		}),
	]);
	return {
		view: "history" as const,
		rows: historyRows(
			current,
			periods.map((p) => ({ ...p, status: PeriodStatus.parse(p.status) })),
			entries,
			zone,
			now,
		),
	};
}
