import { and, asc, eq, inArray } from "drizzle-orm";

import { changes, recordStatement } from "~/activity/activity.server";
import { type OrganisationScope, uuidv7 } from "~/db";
import { nameKey } from "~/lib/names";
import { Role } from "~/organisations/roles";
import type { Day } from "~/time/calendar";

import {
	type Assignment,
	assignmentOn,
	clockTime,
	isWorkedDay,
	type OwnOvertime,
	type PersonPlace,
	SCHEDULE_ROLES,
	type Schedule,
	type ScheduleBook,
	type ScheduleRules,
	type ScheduleVersion,
	type ScheduleWeek,
	SINCE_EVER,
	type TargetKind,
	type Timetable,
	timetableOf,
	versionOn,
	type WorkedDay,
	weekTotal,
} from "./schedules";

/**
 * Work schedules in the database (TS-097): reading an organisation's book of
 * schedules and assignments, and the changes owners and admins make to it.
 * Every change is dated, from today or later, so a day gone keeps the
 * schedule it had; every change is recorded in the activity log in the same
 * batch that makes it.
 */

/** The organisation's schedules, their versions and days, and every assignment. */
export async function scheduleBookOf(scope: OrganisationScope): Promise<ScheduleBook> {
	const [schedules, versions, days, assignments] = await Promise.all([
		scope.workSchedules.select(undefined, { orderBy: (s) => [asc(s.nameKey)] }),
		scope.workScheduleVersions.select(undefined, { orderBy: (v) => [asc(v.effectiveFrom)] }),
		scope.workScheduleDays.select(),
		scope.scheduleAssignments.select(undefined, {
			orderBy: (a) => [asc(a.effectiveFrom), asc(a.createdAt)],
		}),
	]);
	const daysOf = new Map<string, (WorkedDay | null)[]>();
	for (const day of days) {
		const week = daysOf.get(day.versionId) ?? [null, null, null, null, null, null, null];
		week[day.weekday - 1] = {
			start: day.startMinute,
			finish: day.finishMinute,
			breakMinutes: day.breakMinutes,
		};
		daysOf.set(day.versionId, week);
	}
	const versionsOf = new Map<string, ScheduleVersion[]>();
	for (const v of versions) {
		const list = versionsOf.get(v.scheduleId) ?? [];
		list.push({
			effectiveFrom: v.effectiveFrom,
			week: daysOf.get(v.id) ?? [null, null, null, null, null, null, null],
			overtime: v.overtimePolicy
				? {
						policy: v.overtimePolicy as OwnOvertime["policy"],
						dayCap: v.overtimeDayCapMinutes,
						weekCap: v.overtimeWeekCapMinutes,
					}
				: null,
			weekend: (v.nonWorkingDays as ScheduleRules["weekend"]) ?? null,
		});
		versionsOf.set(v.scheduleId, list);
	}
	return {
		schedules: new Map(
			schedules.flatMap((s): [string, Schedule][] => {
				const list = versionsOf.get(s.id);
				return list && list.length > 0
					? [[s.id, { id: s.id, name: s.name, archived: s.archivedAt !== null, versions: list }]]
					: [];
			}),
		),
		assignments: assignments.map((a) => ({
			id: a.id,
			targetKind: a.targetKind as TargetKind,
			targetId: a.targetId,
			scheduleId: a.scheduleId,
			effectiveFrom: a.effectiveFrom,
			sourceKind: a.sourceKind as Assignment["sourceKind"],
			sourceId: a.sourceId,
			createdAt: a.createdAt.getTime(),
		})),
	};
}

/** Where each member stands, as their schedule is decided: role, contractor, the teams they are in and whether they manage one. `only` limits it to those people. */
export async function placesOf(
	scope: OrganisationScope,
	only?: readonly string[],
): Promise<Map<string, PersonPlace>> {
	if (only?.length === 0) return new Map();
	const [members, places, teams] = await Promise.all([
		scope.memberships.select((m) => (only ? inArray(m.userId, [...only]) : undefined)),
		scope.teamMembers.select((t) => (only ? inArray(t.userId, [...only]) : undefined)),
		scope.teams.select(),
	]);
	const teamName = new Map(teams.map((t) => [t.id, t.name]));
	const result = new Map<string, PersonPlace>();
	for (const m of members) {
		const theirs = places.filter((p) => p.userId === m.userId);
		result.set(m.userId, {
			userId: m.userId,
			role: Role.catch("member").parse(m.role),
			contractor: m.isContractor,
			manager: theirs.some((p) => p.isManager),
			teams: theirs.map((p) => ({ id: p.teamId, name: teamName.get(p.teamId) ?? "" })),
		});
	}
	return result;
}

/** A place for someone no longer a member: no teams, the member's role. Their schedule is then the organisation's. */
export function formerPlace(userId: string): PersonPlace {
	return { userId, role: "member", contractor: false, manager: false, teams: [] };
}

/** People's timetables: each one's schedule, day by day, made the first time it is asked for. */
export type Timetables = (userId: string) => Timetable;

/**
 * The timetables of `userIds`, read at once; anyone else asked for (someone no
 * longer a member) has the organisation's default.
 */
export async function timetablesOf(
	scope: OrganisationScope,
	userIds?: readonly string[],
): Promise<Timetables> {
	const [book, places] = await Promise.all([scheduleBookOf(scope), placesOf(scope, userIds)]);
	const made = new Map<string, Timetable>();
	return (userId) => {
		let found = made.get(userId);
		if (!found) {
			found = timetableOf(book, places.get(userId) ?? formerPlace(userId));
			made.set(userId, found);
		}
		return found;
	};
}

/** One person's timetable. */
export async function timetableFor(scope: OrganisationScope, userId: string): Promise<Timetable> {
	return (await timetablesOf(scope, [userId]))(userId);
}

// Changes.

/** A schedule as a form gives it: its name, its days and its rules. */
export interface ScheduleInput {
	name: string;
	week: ScheduleWeek;
	rules: ScheduleRules;
}

/**
 * What a change came to. `taken`: another schedule has the name. `missing`:
 * the schedule, or what it is given to, is not there. `archived`: an archived
 * schedule cannot be given. `in-use`: an assigned schedule cannot be archived.
 * `past`: the day is before today. `no-days`: a schedule works at least one day.
 */
export type ScheduleChange =
	| "done"
	| "taken"
	| "missing"
	| "archived"
	| "in-use"
	| "past"
	| "no-days";

/** The week of a version as the activity log records it: "Mon 09:00–17:30 (60), Tue …". */
function weekSummary(week: ScheduleWeek): string {
	const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
	return week
		.flatMap((day, index) =>
			day
				? [`${names[index]} ${clockTime(day.start)}–${clockTime(day.finish)} (${day.breakMinutes})`]
				: [],
		)
		.join(", ");
}

/** The rules as the activity log records them. */
function rulesSummary(rules: ScheduleRules) {
	return {
		overtime: rules.overtime?.policy ?? "the organisation's",
		overtimeDayCap: rules.overtime?.dayCap ?? null,
		overtimeWeekCap: rules.overtime?.weekCap ?? null,
		weekend: rules.weekend ?? "the organisation's",
	};
}

/** The statements that write `version` of a schedule from `from`. */
function versionStatements(
	scope: OrganisationScope,
	scheduleId: string,
	from: Day,
	input: Pick<ScheduleInput, "week" | "rules">,
) {
	const versionId = uuidv7();
	return [
		scope.workScheduleVersions.statements.insert({
			id: versionId,
			scheduleId,
			effectiveFrom: from,
			overtimePolicy: input.rules.overtime?.policy ?? null,
			overtimeDayCapMinutes: input.rules.overtime?.dayCap ?? null,
			overtimeWeekCapMinutes: input.rules.overtime?.weekCap ?? null,
			nonWorkingDays: input.rules.weekend,
		}),
		scope.workScheduleDays.statements.insert(
			input.week.flatMap((day, index) =>
				day
					? [
							{
								versionId,
								weekday: index + 1,
								startMinute: day.start,
								finishMinute: day.finish,
								breakMinutes: day.breakMinutes,
							},
						]
					: [],
			),
		),
	];
}

function isUniqueViolation(error: unknown): boolean {
	return (
		error instanceof Error && /UNIQUE constraint failed/.test(`${error.message} ${error.cause}`)
	);
}

/** Whether a week holds together: a day worked at least, each day whole. */
function weekProblem(week: ScheduleWeek): "no-days" | null {
	if (!week.some((day) => day !== null)) return "no-days";
	if (week.some((day) => day !== null && !isWorkedDay(day))) return "no-days";
	return null;
}

async function nameTaken(scope: OrganisationScope, name: string, except?: string) {
	const found = await scope.workSchedules.select((s) => eq(s.nameKey, nameKey(name)), { limit: 2 });
	return found.some((s) => s.id !== except);
}

/** Creates a schedule; it holds from the start of time, as nobody has it until it is assigned. */
export async function createSchedule(
	scope: OrganisationScope,
	actor: string,
	input: ScheduleInput,
): Promise<{ change: ScheduleChange; id?: string }> {
	const problem = weekProblem(input.week);
	if (problem) return { change: problem };
	if (await nameTaken(scope, input.name)) return { change: "taken" };
	const id = uuidv7();
	try {
		await scope.batch([
			scope.workSchedules.statements.insert({ id, name: input.name, nameKey: nameKey(input.name) }),
			...versionStatements(scope, id, SINCE_EVER, input),
			recordStatement(
				scope,
				actor,
				"work_schedule.created",
				{ type: "work_schedule", id },
				changes(
					null,
					{
						name: input.name,
						days: weekSummary(input.week),
						weekMinutes: weekTotal(input.week),
						...rulesSummary(input.rules),
					},
					[
						"name",
						"days",
						"weekMinutes",
						"overtime",
						"overtimeDayCap",
						"overtimeWeekCap",
						"weekend",
					],
				),
			),
		]);
	} catch (error) {
		if (isUniqueViolation(error)) return { change: "taken" };
		throw error;
	}
	return { change: "done", id };
}

/**
 * Changes a schedule from `from`, today or later: the days and rules from
 * then, the version in force before it kept for the days before. A version
 * already starting that day is replaced; later ones stay. A new name holds at
 * once, as a name has no history.
 */
export async function changeSchedule(
	scope: OrganisationScope,
	actor: string,
	scheduleId: string,
	input: ScheduleInput,
	from: Day,
	today: Day,
): Promise<ScheduleChange> {
	if (from < today) return "past";
	const problem = weekProblem(input.week);
	if (problem) return problem;
	const book = await scheduleBookOf(scope);
	const schedule = book.schedules.get(scheduleId);
	if (!schedule) return "missing";
	if (await nameTaken(scope, input.name, scheduleId)) return "taken";
	const before = versionOn(schedule, from);
	const [same] = await scope.workScheduleVersions.select(
		(v) => and(eq(v.scheduleId, scheduleId), eq(v.effectiveFrom, from)),
		{ limit: 1 },
	);
	const fields = [
		"name",
		"effectiveFrom",
		"days",
		"weekMinutes",
		"overtime",
		"overtimeDayCap",
		"overtimeWeekCap",
		"weekend",
	] as const;
	try {
		await scope.batch([
			scope.workSchedules.statements.update(
				{ name: input.name, nameKey: nameKey(input.name), updatedAt: new Date() },
				(s) => eq(s.id, scheduleId),
			),
			...(same ? [scope.workScheduleVersions.statements.delete((v) => eq(v.id, same.id))] : []),
			...versionStatements(scope, scheduleId, from, input),
			recordStatement(
				scope,
				actor,
				"work_schedule.updated",
				{ type: "work_schedule", id: scheduleId },
				changes(
					{
						name: schedule.name,
						effectiveFrom: before.effectiveFrom,
						days: weekSummary(before.week),
						weekMinutes: weekTotal(before.week),
						...rulesSummary(before),
					},
					{
						name: input.name,
						effectiveFrom: from,
						days: weekSummary(input.week),
						weekMinutes: weekTotal(input.week),
						...rulesSummary(input.rules),
					},
					fields,
				),
			),
		]);
	} catch (error) {
		if (isUniqueViolation(error)) return "taken";
		throw error;
	}
	return "done";
}

/** The targets a schedule is given to on `today` or will be after: what keeps it from being archived. */
export function assignedTargets(book: ScheduleBook, scheduleId: string, today: Day): Assignment[] {
	const targets = new Map<string, Assignment[]>();
	for (const a of book.assignments) {
		const key = `${a.targetKind}:${a.targetId}`;
		targets.set(key, [...(targets.get(key) ?? []), a]);
	}
	const found: Assignment[] = [];
	for (const list of targets.values()) {
		const first = list[0];
		if (!first) continue;
		const now = assignmentOn(list, first.targetKind, first.targetId, today);
		const holding = [now, ...list.filter((a) => a.effectiveFrom > today)].filter(
			(a): a is Assignment => a?.scheduleId === scheduleId,
		);
		found.push(...holding);
	}
	return found;
}

/** Archives a schedule, unless it is given to anyone today or later; restores one archived. */
export async function archiveSchedule(
	scope: OrganisationScope,
	actor: string,
	scheduleId: string,
	archived: boolean,
	today: Day,
): Promise<ScheduleChange> {
	const book = await scheduleBookOf(scope);
	const schedule = book.schedules.get(scheduleId);
	if (!schedule) return "missing";
	if (schedule.archived === archived) return "done";
	if (archived && assignedTargets(book, scheduleId, today).length > 0) return "in-use";
	await scope.batch([
		scope.workSchedules.statements.update(
			{ archivedAt: archived ? new Date() : null, updatedAt: new Date() },
			(s) => eq(s.id, scheduleId),
		),
		recordStatement(
			scope,
			actor,
			archived ? "work_schedule.archived" : "work_schedule.restored",
			{ type: "work_schedule", id: scheduleId },
			changes({ archived: !archived }, { archived }, ["archived"]),
		),
	]);
	return "done";
}

/** What a schedule is given to, as a form names it. */
export interface Target {
	kind: TargetKind;
	/** The person's user id, the team's id, the role, or empty for the organisation. */
	id: string;
}

/** Whether `target` is there to be given a schedule: a member, a team, a role, or the organisation. */
async function targetExists(scope: OrganisationScope, target: Target): Promise<boolean> {
	switch (target.kind) {
		case "person":
			return (
				(await scope.memberships.select((m) => eq(m.userId, target.id), { limit: 1 })).length > 0
			);
		case "team":
			return (await scope.teams.select((t) => eq(t.id, target.id), { limit: 1 })).length > 0;
		case "role":
			return (SCHEDULE_ROLES as readonly string[]).includes(target.id);
		case "organisation":
			return target.id === "";
	}
}

/**
 * Gives `target` the schedule `scheduleId` from `from`, today or later; null
 * takes the target's own away from then, so the next level applies (never for
 * the organisation, which always has a default). An assignment of the same
 * target from the same day is replaced. The person it is about, for a person,
 * is the record's owner, so their own activity shows it.
 */
export async function assignSchedule(
	scope: OrganisationScope,
	actor: string,
	target: Target,
	scheduleId: string | null,
	from: Day,
	today: Day,
): Promise<ScheduleChange> {
	if (from < today) return "past";
	if (scheduleId === null && target.kind === "organisation") return "missing";
	if (!(await targetExists(scope, target))) return "missing";
	const book = await scheduleBookOf(scope);
	if (scheduleId !== null) {
		const schedule = book.schedules.get(scheduleId);
		if (!schedule) return "missing";
		if (schedule.archived) return "archived";
	}
	const before = assignmentOn(book.assignments, target.kind, target.id, from);
	const id = uuidv7();
	await scope.batch([
		scope.scheduleAssignments.statements.delete((a) =>
			and(eq(a.targetKind, target.kind), eq(a.targetId, target.id), eq(a.effectiveFrom, from)),
		),
		scope.scheduleAssignments.statements.insert({
			id,
			scheduleId,
			targetKind: target.kind,
			targetId: target.id,
			effectiveFrom: from,
			sourceKind: "manual",
			sourceId: null,
		}),
		recordStatement(
			scope,
			actor,
			"work_schedule.assigned",
			{
				type: "work_schedule",
				id: scheduleId ?? before?.scheduleId ?? id,
				ownerId: target.kind === "person" ? target.id : null,
			},
			changes(
				{ scheduleId: before?.scheduleId ?? null },
				{ ...targetFields(target), scheduleId, effectiveFrom: from },
				["userId", "teamId", "role", "organisation", "scheduleId", "effectiveFrom"],
			),
		),
	]);
	return "done";
}

/** A target as the log records it: the person or team by id, which the log names, a role by its name. */
function targetFields(target: Target) {
	switch (target.kind) {
		case "person":
			return { userId: target.id };
		case "team":
			return { teamId: target.id };
		case "role":
			return { role: target.id };
		case "organisation":
			return { organisation: "default" };
	}
}
