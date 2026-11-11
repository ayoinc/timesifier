import { env } from "cloudflare:workers";
import { and, asc, desc, eq, gte, lt } from "drizzle-orm";

import { type Filter, type OrganisationScope, organisationScope, type ScopedAccessor } from "~/db";
import type { Membership } from "~/organisations/membership.server";
import { lockedDays } from "~/periods/locks.server";
import {
	type PeriodDays,
	PeriodStatus,
	periodAfter,
	periodBounds,
	periodContaining,
} from "~/periods/periods";
import { bounds, type Day, dayOf, daysFrom } from "~/time/calendar";
import { runningEntry } from "~/time/entries.server";
import { zoneOfMember } from "~/time/zones.server";

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
import type { ChosenView } from "./views.server";

/**
 * What the views of Timesheet read (TS-012a, TS-013, TS-046, TS-052). Every
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

export interface DayData extends TimesheetBase {
	view: "day";
	day: Day;
	/** The day's entries, earliest first. */
	entries: SheetEntry[];
	total: number;
	/** Whether the day is in a submitted or approved period. */
	locked: boolean;
}

export interface WeekData extends TimesheetBase {
	view: "week";
	period: PeriodDays;
	days: Day[];
	sheet: WeekSheet;
	/** The active projects with time in the week before, which "Copy last week's rows" adds (TS-052). */
	lastWeekProjects: string[];
	/** The days of the week in a submitted or approved period: all of them, or none. */
	lockedDays: Day[];
	state: PeriodState;
	status: PeriodStatus | null;
	/** Why it was returned, while it stands returned. */
	comment: string | null;
	/** Whether a timer runs on a day of the week: the week cannot be submitted while one does. */
	runsInWeek: boolean;
	/** Whether the week has begun: a week to come cannot be submitted. */
	started: boolean;
}

export interface HistoryData extends TimesheetBase {
	view: "history";
	rows: HistoryRow[];
}

export type TimesheetData = DayData | WeekData | HistoryData;

/** The data of the view `chosen` for the person behind `membership`, at `now`. */
export async function timesheetData(
	membership: Membership,
	chosen: ChosenView,
	now: number,
): Promise<TimesheetData> {
	const { user, organisation } = membership;
	const scope = organisationScope(env.DB, organisation.id);
	const zone = await zoneOfMember(membership);
	const today = dayOf(now, zone);
	const { projects, running } = await common(scope, user.id);
	const base: TimesheetBase = { zone, now, today, projects, running };

	switch (chosen.view) {
		case "day":
			return { ...base, ...(await dayData(scope, user.id, chosen.day ?? today, zone, now)) };
		case "week": {
			const period = periodContaining(chosen.start ?? today, organisation.weekStartsOn);
			return { ...base, ...(await weekData(scope, user.id, period, zone, now, projects)) };
		}
		case "history": {
			const current = periodContaining(today, organisation.weekStartsOn);
			return { ...base, ...(await historyData(scope, user.id, current, zone, now)) };
		}
	}
}

async function dayData(
	scope: OrganisationScope,
	userId: string,
	day: Day,
	zone: string,
	now: number,
): Promise<Omit<DayData, keyof TimesheetBase>> {
	const [entries, locked] = await Promise.all([
		entriesStartingIn(scope, userId, bounds(day, day, zone)),
		lockedDays(scope, userId, [day]),
	]);
	return {
		view: "day" as const,
		day,
		entries,
		total: totalOf(entries, now),
		locked: locked.has(day),
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
	const [entries, previous, row, locked] = await Promise.all([
		entriesStartingIn(scope, userId, periodBounds(period, zone)),
		entriesStartingIn(scope, userId, periodBounds(before, zone)),
		periodOf(scope, userId, period.startsOn),
		lockedDays(scope, userId, days),
	]);
	const active = new Set(projects.filter((p) => !p.archived).map((p) => p.id));
	return {
		view: "week" as const,
		period,
		days,
		sheet: weekSheet(entries, days, zone, now, { projectOrder: projects.map((p) => p.id) }),
		lastWeekProjects: [...new Set(previous.map((e) => e.projectId))].filter((id) => active.has(id)),
		lockedDays: days.filter((day) => locked.has(day)),
		state: periodState(row?.status ?? null),
		status: row?.status ?? null,
		comment: row?.status === "returned" ? row.comment : null,
		runsInWeek: entries.some((entry) => entry.endedAt === null),
		started: period.startsOn <= dayOf(now, zone),
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
