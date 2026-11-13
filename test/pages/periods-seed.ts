import { env } from "cloudflare:workers";

import { uuidv7 } from "~/db";
import { dayOf } from "~/time/calendar";

// Rows Team and Approvals read, written straight to the database: a project,
// time entries and submitted periods (TS-045, TS-047).

export async function seedProject(organisationId: string, name: string): Promise<string> {
	const id = uuidv7();
	const now = Date.now();
	await env.DB.prepare(
		"insert into projects (id, organisation_id, name, name_key, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
	)
		.bind(id, organisationId, name, name.toLowerCase(), now, now)
		.run();
	return id;
}

/**
 * The day an entry of `userId` starting at `startedAt` is stored with, as every
 * writer stores it (TS-111): the day it starts on in the person's zone now,
 * else the organisation's.
 */
export async function entryDay(
	organisationId: string,
	userId: string,
	startedAt: number,
): Promise<string> {
	const row = await env.DB.prepare(
		"select coalesce(u.time_zone, o.time_zone) as zone from users u, organisations o where u.id = ? and o.id = ?",
	)
		.bind(userId, organisationId)
		.first<{ zone: string }>();
	return dayOf(startedAt, row?.zone ?? "UTC");
}

/** An entry of `userId` from `from` to `to`, or running when `to` is null. */
export async function seedEntry(
	organisationId: string,
	userId: string,
	projectId: string,
	from: string | number,
	to: string | number | null,
	description: string | null = null,
): Promise<string> {
	const id = uuidv7();
	const now = Date.now();
	const at = (instant: string | number) =>
		typeof instant === "number" ? instant : Date.parse(instant);
	await env.DB.prepare(
		"insert into time_entries (id, organisation_id, user_id, project_id, description, started_at, spent_on, ended_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(
			id,
			organisationId,
			userId,
			projectId,
			description,
			at(from),
			await entryDay(organisationId, userId, at(from)),
			to === null ? null : at(to),
			now,
			now,
		)
		.run();
	return id;
}

/** Marks the entry `id` as overtime rather than regular time (TS-095). */
export async function markOvertime(id: string): Promise<void> {
	await env.DB.prepare("update time_entries set overtime = 1 where id = ?").bind(id).run();
}

/** A period of `userId` starting on `startsOn`, a Monday, standing at `status`. */
export async function seedPeriod(
	organisationId: string,
	userId: string,
	startsOn: string,
	status: "submitted" | "withdrawn" | "approved" | "returned" = "submitted",
): Promise<string> {
	const id = uuidv7();
	const now = Date.now();
	const ends = new Date(`${startsOn}T00:00:00Z`);
	ends.setUTCDate(ends.getUTCDate() + 6);
	await env.DB.prepare(
		"insert into periods (id, organisation_id, user_id, starts_on, ends_on, status, submitted_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(
			id,
			organisationId,
			userId,
			startsOn,
			ends.toISOString().slice(0, 10),
			status,
			now,
			now,
			now,
		)
		.run();
	return id;
}
