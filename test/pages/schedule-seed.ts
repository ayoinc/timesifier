import { env } from "cloudflare:workers";

import { uuidv7 } from "~/db/uuidv7";
import { type ScheduleWeek, SINCE_EVER, weekOfMinutes } from "~/schedules/schedules";

// Work schedules straight into D1 (TS-097), for tests that need a person or an
// organisation on a schedule other than Standard without going through the
// page. The page's own forms are tested in `schedules.test.ts`.

/** A week as minutes a day, Monday first (each from 09:00, as a migrated week), or as worked days. */
type WeekGiven = ScheduleWeek | readonly number[];

function weekOf(week: WeekGiven): ScheduleWeek {
	return week.every((d) => typeof d === "number")
		? weekOfMinutes(week as readonly number[])
		: (week as ScheduleWeek);
}

/** Overtime and weekend rules of the schedule's own; none is the organisation's. */
export interface SeedRules {
	overtime?: "none" | "allowed" | "approval";
	dayCap?: number | null;
	weekCap?: number | null;
	weekend?: "overtime" | "none";
}

/** Writes a version of `scheduleId` from `from`. */
export async function seedVersion(
	organisationId: string,
	scheduleId: string,
	week: WeekGiven,
	from: string = SINCE_EVER,
	rules: SeedRules = {},
): Promise<void> {
	const versionId = uuidv7();
	const now = Date.now();
	await env.DB.prepare(
		"insert into work_schedule_versions (id, organisation_id, schedule_id, effective_from, overtime_policy, overtime_day_cap_minutes, overtime_week_cap_minutes, non_working_days, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(
			versionId,
			organisationId,
			scheduleId,
			from,
			rules.overtime ?? null,
			rules.dayCap ?? null,
			rules.weekCap ?? null,
			rules.weekend ?? null,
			now,
			now,
		)
		.run();
	const days = weekOf(week).flatMap((day, index) => (day ? [{ day, weekday: index + 1 }] : []));
	for (const { day, weekday } of days) {
		await env.DB.prepare(
			"insert into work_schedule_days (id, organisation_id, version_id, weekday, start_minute, finish_minute, break_minutes, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
			.bind(
				uuidv7(),
				organisationId,
				versionId,
				weekday,
				day.start,
				day.finish,
				day.breakMinutes,
				now,
				now,
			)
			.run();
	}
}

/** A schedule called `name`, from the start of time, and its id. */
export async function seedSchedule(
	organisationId: string,
	name: string,
	week: WeekGiven,
	rules: SeedRules = {},
): Promise<string> {
	const id = uuidv7();
	const now = Date.now();
	await env.DB.prepare(
		"insert into work_schedules (id, organisation_id, name, name_key, archived_at, created_at, updated_at) values (?, ?, ?, ?, null, ?, ?)",
	)
		.bind(id, organisationId, name, name.toLowerCase(), now, now)
		.run();
	await seedVersion(organisationId, id, week, SINCE_EVER, rules);
	return id;
}

/** The id of the organisation's schedule called `name`. */
export async function scheduleNamed(organisationId: string, name: string): Promise<string> {
	const found = await env.DB.prepare(
		"select id from work_schedules where organisation_id = ? and name_key = ?",
	)
		.bind(organisationId, name.toLowerCase())
		.first<{ id: string }>();
	if (!found) throw new Error(`No schedule ${name}.`);
	return found.id;
}

/** Gives `scheduleId` (null: none of its own) to a target from `from`. */
export async function seedAssignment(
	organisationId: string,
	target: { kind: "person" | "team" | "role" | "organisation"; id: string },
	scheduleId: string | null,
	from: string = SINCE_EVER,
): Promise<void> {
	const now = Date.now();
	await env.DB.prepare(
		"insert into schedule_assignments (id, organisation_id, schedule_id, target_kind, target_id, effective_from, source_kind, source_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, 'manual', null, ?, ?) on conflict (organisation_id, target_kind, target_id, effective_from) do update set schedule_id = excluded.schedule_id",
	)
		.bind(uuidv7(), organisationId, scheduleId, target.kind, target.id, from, now, now)
		.run();
}

/** Makes the organisation's default, from the start of time, a schedule of `week`. */
export async function seedDefaultWeek(organisationId: string, week: WeekGiven): Promise<string> {
	const id = await seedSchedule(organisationId, `Week ${uuidv7().slice(-6)}`, week);
	await seedAssignment(organisationId, { kind: "organisation", id: "" }, id);
	return id;
}
