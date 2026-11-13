import * as z from "zod";

import { type NonWorkingRule, OVERTIME_RULE_LABELS, OvertimeRule } from "~/leave/rules";
import type { Role } from "~/organisations/roles";
import { type Day, isoWeekday } from "~/time/calendar";
import { formatDuration } from "~/time/format";

/**
 * Work schedules (TS-097), without the database: what a schedule expects of a
 * day, which version of it holds on a day, and which schedule a person has on
 * a day. Nothing here reads the database or a clock.
 *
 * A schedule says, for each weekday it works, a start, a finish and an unpaid
 * break, all on the clock of the person's own day; the day expects
 * `finish − start − break` minutes, whatever the clocks do that day. A change
 * is a new version from a chosen day, so a day keeps the version that held on
 * it. Assignments give a schedule from a day to a person, a team, a role or
 * the organisation, and the most specific holds: person, then team, then
 * role, then the organisation's default.
 */

/** The day the first version of every schedule, and the organisation's first default, hold from. */
export const SINCE_EVER: Day = "0001-01-01";

/** A weekday a schedule works: minutes after midnight, and the unpaid break between. */
export interface WorkedDay {
	start: number;
	finish: number;
	breakMinutes: number;
}

/** Seven days, Monday first: the day worked, or null for a day not worked. */
export type ScheduleWeek = readonly (WorkedDay | null)[];

/** The minutes a worked day expects: finish less start less the break; 0 for a day not worked. */
export function workedMinutes(day: WorkedDay | null | undefined): number {
	if (!day) return 0;
	return Math.max(0, day.finish - day.start - day.breakMinutes);
}

/** The minutes a week expects in all. */
export function weekTotal(week: ScheduleWeek): number {
	return week.reduce((sum, day) => sum + workedMinutes(day), 0);
}

/** The minutes of each day of a week, Monday first. */
export function weekMinutesOf(week: ScheduleWeek): number[] {
	return [0, 1, 2, 3, 4, 5, 6].map((index) => workedMinutes(week[index]));
}

/** The latest a day may finish: midnight. A schedule never runs past it. */
export const LAST_MINUTE = 24 * 60;

/** Whether a worked day holds together: a start before its finish, both in the day, and a break shorter than the time between. */
export function isWorkedDay(day: WorkedDay): boolean {
	return (
		Number.isInteger(day.start) &&
		Number.isInteger(day.finish) &&
		Number.isInteger(day.breakMinutes) &&
		day.start >= 0 &&
		day.finish <= LAST_MINUTE &&
		day.finish > day.start &&
		day.breakMinutes >= 0 &&
		day.breakMinutes < day.finish - day.start
	);
}

/**
 * The day that expects `minutes`, as a working week became a schedule: from
 * 09:00, with an hour's break on a day of more than six hours, finishing when
 * the minutes are done; earlier, on a day too long to finish by midnight.
 * Null for no minutes. Migration `0019_work_schedules` does the same in SQL.
 */
export function dayOfMinutes(minutes: number): WorkedDay | null {
	if (minutes <= 0) return null;
	const whole = Math.min(LAST_MINUTE, Math.round(minutes));
	const breakMinutes = whole > 360 && whole <= LAST_MINUTE - 60 ? 60 : 0;
	const start = Math.min(9 * 60, LAST_MINUTE - whole - breakMinutes);
	return { start, finish: start + whole + breakMinutes, breakMinutes };
}

/** A week of minutes a day, Monday first, as a schedule week (`dayOfMinutes`). */
export function weekOfMinutes(minutes: readonly number[]): ScheduleWeek {
	return [0, 1, 2, 3, 4, 5, 6].map((index) => dayOfMinutes(minutes[index] ?? 0));
}

/** A schedule's own overtime rule, with its caps: when null, the organisation's applies. */
export interface OwnOvertime {
	policy: OvertimeRule;
	dayCap: number | null;
	weekCap: number | null;
}

/** What a version says of overtime and of days not worked: null for each is the organisation's. */
export interface ScheduleRules {
	overtime: OwnOvertime | null;
	weekend: NonWorkingRule | null;
}

/** No rules of its own: the organisation's apply. */
export const ORGANISATION_RULES: ScheduleRules = { overtime: null, weekend: null };

/** A schedule as it is from `effectiveFrom` until its next version. */
export interface ScheduleVersion extends ScheduleRules {
	effectiveFrom: Day;
	week: ScheduleWeek;
}

/** A named schedule and its versions, earliest first. */
export interface Schedule {
	id: string;
	name: string;
	archived: boolean;
	versions: readonly ScheduleVersion[];
}

/** The schedules every organisation starts with (migration `0019_work_schedules`). */
export const STANDARD_DAY: WorkedDay = { start: 9 * 60, finish: 17 * 60 + 30, breakMinutes: 60 };
export const LONG_DAY: WorkedDay = { start: 9 * 60, finish: 18 * 60, breakMinutes: 60 };
const weekdays = (day: WorkedDay): ScheduleWeek => [day, day, day, day, day, null, null];
export const STANDARD_WEEK: ScheduleWeek = weekdays(STANDARD_DAY);
export const LONG_WEEK: ScheduleWeek = weekdays(LONG_DAY);

/** The version of `schedule` that holds on `day`: the latest from it or before; the first, for a day before them all. */
export function versionOn(schedule: Pick<Schedule, "versions">, day: Day): ScheduleVersion {
	let found = schedule.versions[0];
	for (const version of schedule.versions) {
		if (version.effectiveFrom <= day) found = version;
		else break;
	}
	if (!found) throw new Error("A schedule has at least one version.");
	return found;
}

// Assignments.

/** What an assignment gives a schedule to. */
export const TARGET_KINDS = ["person", "team", "role", "organisation"] as const;
export const TargetKind = z.enum(TARGET_KINDS);
export type TargetKind = z.infer<typeof TargetKind>;

// The choices of a schedule's own rules, which the sheet shows. Here, not in
// ./forms beside the schema that reads them: that module builds a `z.object`
// as it loads, and Zod 4 then tries `new Function`, which the page's Content
// Security Policy refuses in the browser (docs/security.md, "no unsafe-eval").

/** "Use the organisation's rule": the value of a rule's choice that sets none of the schedule's own. */
export const ORGANISATION_CHOICE = "organisation";

/** The overtime choices of a schedule: the organisation's, or one of its own. */
export const OVERTIME_CHOICES = [
	{ id: ORGANISATION_CHOICE, label: "The organisation's rule" },
	...OvertimeRule.options.map((rule) => ({ id: rule, label: OVERTIME_RULE_LABELS[rule] })),
];

/** The roles a schedule is given to: the four of a membership, a manager of a team, and a contractor. */
export const SCHEDULE_ROLES = [
	"owner",
	"admin",
	"manager",
	"finance",
	"member",
	"contractor",
] as const;
export const ScheduleRole = z.enum(SCHEDULE_ROLES);
export type ScheduleRole = z.infer<typeof ScheduleRole>;

export const SCHEDULE_ROLE_LABELS: Record<ScheduleRole, string> = {
	owner: "Owners",
	admin: "Admins",
	manager: "Managers",
	finance: "Finance",
	member: "Members",
	contractor: "Contractors",
};

/** What made an assignment: an owner or admin, or (TS-098) a contract. */
export const SOURCE_KINDS = ["manual", "contract"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** A schedule given to a target from a day. No schedule takes the target's away from that day. */
export interface Assignment {
	id: string;
	targetKind: TargetKind;
	/** The person's user id, the team's id, the role, or empty for the organisation. */
	targetId: string;
	scheduleId: string | null;
	effectiveFrom: Day;
	sourceKind: SourceKind;
	sourceId: string | null;
	createdAt: number;
}

/** Where a person stands in the organisation, as their schedule is decided. */
export interface PersonPlace {
	userId: string;
	role: Role;
	contractor: boolean;
	/** Whether they manage a team. */
	manager: boolean;
	teams: readonly { id: string; name: string }[];
}

/** The organisation's schedules and every assignment of them: what decides anyone's schedule on any day. */
export interface ScheduleBook {
	schedules: ReadonlyMap<string, Schedule>;
	assignments: readonly Assignment[];
}

/** The assignment of one target that holds on `day`: the latest from it or before; null when none has begun. */
export function assignmentOn(
	assignments: readonly Assignment[],
	targetKind: TargetKind,
	targetId: string,
	day: Day,
): Assignment | null {
	let found: Assignment | null = null;
	for (const each of assignments) {
		if (each.targetKind !== targetKind || each.targetId !== targetId) continue;
		if (each.effectiveFrom > day) continue;
		if (
			!found ||
			each.effectiveFrom > found.effectiveFrom ||
			(each.effectiveFrom === found.effectiveFrom && each.createdAt > found.createdAt)
		)
			found = each;
	}
	return found;
}

/** The roles of a person that a schedule may be given to, the most specific first: contractor, manager, then their role. */
export function rolesOf(
	place: Pick<PersonPlace, "role" | "contractor" | "manager">,
): ScheduleRole[] {
	return [
		...(place.contractor ? (["contractor"] as const) : []),
		...(place.manager ? (["manager"] as const) : []),
		place.role,
	];
}

/** Why a person has the schedule they have on a day. */
export type ScheduleSource =
	| { level: "person" }
	| {
			level: "team";
			teamId: string;
			teamName: string;
			/** Their other teams with a schedule that day, which gave way: fewer weekly hours, or a later name. */
			others: { teamName: string; scheduleName: string; weekMinutes: number }[];
	  }
	| { level: "role"; role: ScheduleRole }
	| { level: "organisation" };

/** A person's schedule on one day, the version in force, and why. */
export interface Resolved {
	schedule: Schedule;
	version: ScheduleVersion;
	source: ScheduleSource;
}

/** The schedule an organisation without one falls back to: Standard. Every organisation has a default; this keeps a reader whole if it had not. */
export const FALLBACK_SCHEDULE: Schedule = {
	id: "",
	name: "Standard",
	archived: false,
	versions: [{ effectiveFrom: SINCE_EVER, week: STANDARD_WEEK, ...ORGANISATION_RULES }],
};

/**
 * The schedule of `place` on `day`, the most specific assignment holding:
 * their own, then their teams', then their roles' (contractor, manager, then
 * their role), then the organisation's. Of two teams with a schedule, the one
 * whose schedule expects more hours that week holds; on equal hours, the team
 * whose name comes first.
 */
export function resolve(book: ScheduleBook, place: PersonPlace, day: Day): Resolved {
	const scheduled = (assignment: Assignment | null) => {
		if (!assignment?.scheduleId) return null;
		const schedule = book.schedules.get(assignment.scheduleId);
		return schedule ? { schedule, version: versionOn(schedule, day) } : null;
	};
	const own = scheduled(assignmentOn(book.assignments, "person", place.userId, day));
	if (own) return { ...own, source: { level: "person" } };

	const ofTeams = place.teams
		.flatMap((team) => {
			const found = scheduled(assignmentOn(book.assignments, "team", team.id, day));
			return found ? [{ team, ...found, weekMinutes: weekTotal(found.version.week) }] : [];
		})
		.sort(
			(a, b) =>
				b.weekMinutes - a.weekMinutes ||
				a.team.name.localeCompare(b.team.name, "en") ||
				a.team.id.localeCompare(b.team.id),
		);
	const [team, ...others] = ofTeams;
	if (team) {
		return {
			schedule: team.schedule,
			version: team.version,
			source: {
				level: "team",
				teamId: team.team.id,
				teamName: team.team.name,
				others: others.map((o) => ({
					teamName: o.team.name,
					scheduleName: o.schedule.name,
					weekMinutes: o.weekMinutes,
				})),
			},
		};
	}

	for (const role of rolesOf(place)) {
		const found = scheduled(assignmentOn(book.assignments, "role", role, day));
		if (found) return { ...found, source: { level: "role", role } };
	}

	const fallback = scheduled(assignmentOn(book.assignments, "organisation", "", day)) ?? {
		schedule: FALLBACK_SCHEDULE,
		version: versionOn(FALLBACK_SCHEDULE, day),
	};
	return { ...fallback, source: { level: "organisation" } };
}

/** Why a person has their schedule, in words: "Assigned to them" (or "to you"), "From the team Design", "For managers", "The organisation's default". */
export function sourceLabel(source: ScheduleSource, you = false): string {
	switch (source.level) {
		case "person":
			return you ? "Assigned to you" : "Assigned to them";
		case "team": {
			const lead = `From the team ${source.teamName}`;
			if (source.others.length === 0) return lead;
			const others = source.others.map((o) => `${o.teamName} (${o.scheduleName})`).join(", ");
			return `${lead}: of their teams with a schedule, it has the most weekly hours (also ${others})`;
		}
		case "role":
			return `For ${SCHEDULE_ROLE_LABELS[source.role].toLowerCase()}`;
		case "organisation":
			return "The organisation's default";
	}
}

// A person's days.

/** One day of a person's schedule: what it expects, its hours, and the rules that hold on it. */
export interface ScheduledDay {
	/** The minutes it expects before holidays and leave; 0 for a day not worked. */
	minutes: number;
	/** Its start, finish and break; null for a day not worked. */
	worked: WorkedDay | null;
	scheduleId: string;
	scheduleName: string;
	rules: ScheduleRules;
}

/** A person's schedule, day by day. */
export type Timetable = (day: Day) => ScheduledDay;

/** The day of a version. */
function scheduledDay(schedule: Schedule, version: ScheduleVersion, day: Day): ScheduledDay {
	const worked = version.week[isoWeekday(day) - 1] ?? null;
	return {
		minutes: workedMinutes(worked),
		worked,
		scheduleId: schedule.id,
		scheduleName: schedule.name,
		rules: { overtime: version.overtime, weekend: version.weekend },
	};
}

/** The timetable of `place` out of the organisation's book. */
export function timetableOf(book: ScheduleBook, place: PersonPlace): Timetable {
	const seen = new Map<Day, ScheduledDay>();
	return (day) => {
		let found = seen.get(day);
		if (!found) {
			const { schedule, version } = resolve(book, place, day);
			found = scheduledDay(schedule, version, day);
			seen.set(day, found);
		}
		return found;
	};
}

/** A timetable of one week that never changes, with the organisation's rules: for a calendar with no book, and for tests. */
export function weekly(
	week: ScheduleWeek | readonly number[],
	rules: ScheduleRules = ORGANISATION_RULES,
	name = "Standard",
): Timetable {
	const days: ScheduleWeek = week.every((d) => typeof d === "number")
		? weekOfMinutes(week as readonly number[])
		: (week as ScheduleWeek);
	const schedule: Schedule = {
		id: "",
		name,
		archived: false,
		versions: [{ effectiveFrom: SINCE_EVER, week: days, ...rules }],
	};
	return (day) => scheduledDay(schedule, versionOn(schedule, day), day);
}

/** A clock time of a day, "09:00", from minutes after midnight; "24:00" for midnight at its end. */
export function clockTime(minutes: number): string {
	const hours = Math.floor(minutes / 60);
	return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** A clock time as typed, "9:00", "09:00" or "17:30", in minutes after midnight; null when it is none. "24:00" is midnight at the day's end. */
export function parseClock(text: string): number | null {
	const match = /^(\d{1,2}):([0-5]\d)$/.exec(text.trim());
	if (!match) return null;
	const minutes = Number(match[1]) * 60 + Number(match[2]);
	return minutes <= LAST_MINUTE ? minutes : null;
}

/** A worked day's hours in words: "09:00–17:30". */
export function hoursLabel(day: WorkedDay): string {
	return `${clockTime(day.start)}–${clockTime(day.finish)}`;
}

/** The days of the week, Monday first, as a schedule lists them. */
export const WEEKDAY_LABELS = [
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
	"Sunday",
] as const;

/** A worked day in words: "09:00–17:30, 1:00 break · 7:30"; "Not a working day". */
export function dayLabel(day: WorkedDay | null | undefined): string {
	if (!day) return "Not a working day";
	const pause = day.breakMinutes > 0 ? `, ${formatDuration(day.breakMinutes * 60)} break` : "";
	return `${hoursLabel(day)}${pause} · ${formatDuration(workedMinutes(day) * 60)}`;
}

/** A week in words: "Monday to Friday, 09:00–17:30 · 37:30 a week", or the total alone when the days differ. */
export function weekLabel(week: ScheduleWeek): string {
	const total = `${formatDuration(weekTotal(week) * 60)} a week`;
	const worked = week.flatMap((day, index) => (day ? [{ day, index }] : []));
	const first = worked[0];
	const last = worked.at(-1);
	if (!first || !last) return "No working days";
	const same = worked.every(
		(w) =>
			w.day.start === first.day.start &&
			w.day.finish === first.day.finish &&
			w.day.breakMinutes === first.day.breakMinutes,
	);
	const consecutive = last.index - first.index + 1 === worked.length;
	if (same && consecutive && worked.length > 1) {
		return `${WEEKDAY_LABELS[first.index]} to ${WEEKDAY_LABELS[last.index]}, ${hoursLabel(first.day)} · ${total}`;
	}
	return total;
}

/** A person's schedule as My account and a person's row show it. */
export interface ScheduleView {
	name: string;
	/** Why they have it (`sourceLabel`). */
	reason: string;
	level: ScheduleSource["level"];
	weekLabel: string;
	days: { name: string; hours: string }[];
	/** The next day their schedule changes, and to what; null when nothing is due. */
	next: { from: Day; name: string; weekLabel: string } | null;
}

/** What `place` works on `today`, why, and the next change due. */
export function scheduleView(
	book: ScheduleBook,
	place: PersonPlace,
	today: Day,
	you = false,
): ScheduleView {
	const now = resolve(book, place, today);
	const candidates = [
		...book.assignments.map((a) => a.effectiveFrom),
		...[...book.schedules.values()].flatMap((s) => s.versions.map((v) => v.effectiveFrom)),
	]
		.filter((day) => day > today)
		.sort();
	let next: ScheduleView["next"] = null;
	for (const day of new Set(candidates)) {
		const then = resolve(book, place, day);
		if (then.schedule.id !== now.schedule.id || then.version !== now.version) {
			next = { from: day, name: then.schedule.name, weekLabel: weekLabel(then.version.week) };
			break;
		}
	}
	return {
		name: now.schedule.name,
		reason: sourceLabel(now.source, you),
		level: now.source.level,
		weekLabel: weekLabel(now.version.week),
		days: WEEKDAY_LABELS.map((name, index) => ({ name, hours: dayLabel(now.version.week[index]) })),
		next,
	};
}
