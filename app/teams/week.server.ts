import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";

import type { OrganisationScope } from "~/db";
import type { PeriodDays, PeriodStatus } from "~/periods/periods";
import { type Day, daysFrom } from "~/time/calendar";

import type { Person } from "./people.server";

/**
 * Team > This week (TS-045): for one period, each person the viewer may see,
 * with the time they have logged in it, whether their timer runs now, and
 * where their period stands. A person's period is their own local days: each
 * entry counts on the day stored with it when it was tracked (decision 39). A
 * running entry counts up to `now`.
 */

export interface PersonInWeek {
	id: string;
	name: string;
	email: string;
	/** Seconds logged in the period. */
	seconds: number;
	/** Of `seconds`, those of overtime (TS-095). */
	overtimeSeconds: number;
	/** Whether a timer of theirs runs now, in whatever period it started. */
	running: boolean;
	/** Where their period stands; null when it has never been submitted. */
	status: PeriodStatus | null;
}

/** Seconds an entry lasted, or has lasted until `now` while it runs. */
function secondsOf(entry: { startedAt: Date; endedAt: Date | null }, now: number): number {
	const end = entry.endedAt ? entry.endedAt.getTime() : now;
	return Math.max(0, Math.floor((end - entry.startedAt.getTime()) / 1000));
}

/** The entries of `people` whose day is in `period`. */
async function entriesIn(scope: OrganisationScope, people: readonly Person[], period: PeriodDays) {
	if (people.length === 0) return [];
	return scope.timeEntries.select(
		(e) =>
			and(
				inArray(
					e.userId,
					people.map((p) => p.id),
				),
				gte(e.spentOn, period.startsOn),
				lte(e.spentOn, period.endsOn),
			),
		{ orderBy: (e) => [asc(e.startedAt)] },
	);
}

/** Each of `people` in `period`, in the order given. */
export async function teamWeek(
	scope: OrganisationScope,
	people: readonly Person[],
	period: PeriodDays,
	now: number,
): Promise<PersonInWeek[]> {
	if (people.length === 0) return [];
	const ids = people.map((p) => p.id);
	const [entries, running, periods] = await Promise.all([
		entriesIn(scope, people, period),
		scope.timeEntries.select((e) => and(inArray(e.userId, ids), isNull(e.endedAt))),
		scope.periods.select((p) => and(inArray(p.userId, ids), eq(p.startsOn, period.startsOn))),
	]);
	return people.map((person) => {
		const own = entries.filter((e) => e.userId === person.id);
		return {
			id: person.id,
			name: person.name,
			email: person.email,
			seconds: own.reduce((sum, e) => sum + secondsOf(e, now), 0),
			overtimeSeconds: own.reduce((sum, e) => sum + (e.overtime ? secondsOf(e, now) : 0), 0),
			running: running.some((e) => e.userId === person.id),
			status: (periods.find((p) => p.userId === person.id)?.status ?? null) as PeriodStatus | null,
		};
	});
}

/** The time one person logged on one project in a period. */
export interface ProjectTime {
	userId: string;
	projectId: string;
	project: string;
	seconds: number;
	/** Of `seconds`, those of overtime (TS-095). */
	overtimeSeconds: number;
}

/**
 * The time each of `people` logged in `period` on each project they logged it
 * on: what Approvals adds up by person or by project (TS-058).
 */
export async function timeByProject(
	scope: OrganisationScope,
	people: readonly Person[],
	period: PeriodDays,
	now: number,
): Promise<ProjectTime[]> {
	const entries = await entriesIn(scope, people, period);
	const sums = new Map<string, ProjectTime>();
	for (const entry of entries) {
		const key = `${entry.userId} ${entry.projectId}`;
		const sum = sums.get(key) ?? {
			userId: entry.userId,
			projectId: entry.projectId,
			project: "",
			seconds: 0,
			overtimeSeconds: 0,
		};
		const seconds = secondsOf(entry, now);
		sum.seconds += seconds;
		if (entry.overtime) sum.overtimeSeconds += seconds;
		sums.set(key, sum);
	}
	const projectIds = [...new Set(entries.map((e) => e.projectId))];
	const projects =
		projectIds.length === 0 ? [] : await scope.projects.select((p) => inArray(p.id, projectIds));
	const names = new Map(projects.map((p) => [p.id, p.name]));
	return [...sums.values()].map((sum) => ({ ...sum, project: names.get(sum.projectId) ?? "" }));
}

export interface EntryInWeek {
	id: string;
	project: string;
	description: string | null;
	startedAt: number;
	endedAt: number | null;
	seconds: number;
	/** Whether the entry is overtime rather than regular time (TS-095). */
	overtime: boolean;
}

/** One person's period, day by day: what the Week view shows, to read and not to change. */
export async function personWeek(
	scope: OrganisationScope,
	person: Person,
	period: PeriodDays,
	now: number,
): Promise<{
	days: { day: Day; seconds: number; overtimeSeconds: number; entries: EntryInWeek[] }[];
	seconds: number;
	/** Of `seconds`, those of overtime (TS-095). */
	overtimeSeconds: number;
	status: PeriodStatus | null;
	comment: string | null;
}> {
	const [entries, [row]] = await Promise.all([
		entriesIn(scope, [person], period),
		scope.periods.select((p) => and(eq(p.userId, person.id), eq(p.startsOn, period.startsOn)), {
			limit: 1,
		}),
	]);
	const projectIds = [...new Set(entries.map((e) => e.projectId))];
	const projects =
		projectIds.length === 0 ? [] : await scope.projects.select((p) => inArray(p.id, projectIds));
	const names = new Map(projects.map((p) => [p.id, p.name]));
	const days = daysFrom(period.startsOn, period.endsOn).map((day) => {
		const own = entries
			.filter((e) => e.spentOn === day)
			.map((e) => ({
				id: e.id,
				project: names.get(e.projectId) ?? "",
				description: e.description,
				startedAt: e.startedAt.getTime(),
				endedAt: e.endedAt?.getTime() ?? null,
				seconds: secondsOf(e, now),
				overtime: e.overtime,
			}));
		return {
			day,
			seconds: own.reduce((sum, e) => sum + e.seconds, 0),
			overtimeSeconds: own.reduce((sum, e) => sum + (e.overtime ? e.seconds : 0), 0),
			entries: own,
		};
	});
	return {
		days,
		seconds: days.reduce((sum, d) => sum + d.seconds, 0),
		overtimeSeconds: days.reduce((sum, d) => sum + d.overtimeSeconds, 0),
		status: (row?.status ?? null) as PeriodStatus | null,
		comment: row?.comment ?? null,
	};
}
