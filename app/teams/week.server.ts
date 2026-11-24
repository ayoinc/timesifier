import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";

import { among, type OrganisationScope } from "~/db";
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
				among(
					e.userId,
					people.map((p) => p.id),
				),
				gte(e.spentOn, period.startsOn),
				lte(e.spentOn, period.endsOn),
			),
		{ orderBy: (e) => [asc(e.startedAt)] },
	);
}

/** What one person logged in a period, and of it the overtime (TS-095). */
export interface Logged {
	seconds: number;
	overtimeSeconds: number;
}

/**
 * The time each of `people` logged in `period`, and of it the overtime, added
 * up in one statement however many they are (TS-113): Team sorts all of them
 * by it before taking a page, and adds the page's total from it (TS-125). Each
 * entry counts in whole seconds up to `now` while it runs, as `secondsOf`
 * counts it. Somebody who logged nothing is not in the map.
 */
export async function loggedByPerson(
	scope: OrganisationScope,
	people: readonly Person[],
	period: PeriodDays,
	now: number,
): Promise<Map<string, Logged>> {
	if (people.length === 0) return new Map();
	const lines = await scope.timeEntries.sums(
		(e) => ({ userId: e.userId }),
		(e) => {
			const seconds = sql<number>`max(0, cast((coalesce(${e.endedAt}, ${now}) - ${e.startedAt}) / 1000 as integer))`;
			return {
				seconds,
				overtimeSeconds: sql<number>`case when ${e.overtime} then ${seconds} else 0 end`,
			};
		},
		[["userId"]],
		(e) =>
			and(
				among(
					e.userId,
					people.map((p) => p.id),
				),
				gte(e.spentOn, period.startsOn),
				lte(e.spentOn, period.endsOn),
			),
	);
	return new Map(
		lines.map((line) => [
			String(line.userId),
			{ seconds: line.seconds, overtimeSeconds: line.overtimeSeconds },
		]),
	);
}

/** Which of `people` have a timer running now, in whatever period it started. */
export async function runningOf(
	scope: OrganisationScope,
	people: readonly Person[],
): Promise<Set<string>> {
	if (people.length === 0) return new Set();
	const running = await scope.timeEntries.select((e) =>
		and(
			among(
				e.userId,
				people.map((p) => p.id),
			),
			isNull(e.endedAt),
		),
	);
	return new Set(running.map((e) => e.userId));
}

/**
 * Each of `people` in `period`, in the order given, with what `logged` says
 * they logged and whether `running` holds them; their period's status is read
 * here, for them alone.
 */
export async function teamWeek(
	scope: OrganisationScope,
	people: readonly Person[],
	period: PeriodDays,
	logged: ReadonlyMap<string, Logged>,
	running: ReadonlySet<string>,
): Promise<PersonInWeek[]> {
	if (people.length === 0) return [];
	const periods = await scope.periods.select((p) =>
		and(
			among(
				p.userId,
				people.map((person) => person.id),
			),
			eq(p.startsOn, period.startsOn),
		),
	);
	return people.map((person) => ({
		id: person.id,
		name: person.name,
		email: person.email,
		seconds: logged.get(person.id)?.seconds ?? 0,
		overtimeSeconds: logged.get(person.id)?.overtimeSeconds ?? 0,
		running: running.has(person.id),
		status: (periods.find((p) => p.userId === person.id)?.status ?? null) as PeriodStatus | null,
	}));
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
		projectIds.length === 0 ? [] : await scope.projects.select((p) => among(p.id, projectIds));
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
		projectIds.length === 0 ? [] : await scope.projects.select((p) => among(p.id, projectIds));
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
