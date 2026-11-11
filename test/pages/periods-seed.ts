import { env } from "cloudflare:workers";

import { uuidv7 } from "~/db";

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
		"insert into time_entries (id, organisation_id, user_id, project_id, description, started_at, ended_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(
			id,
			organisationId,
			userId,
			projectId,
			description,
			at(from),
			to === null ? null : at(to),
			now,
			now,
		)
		.run();
	return id;
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
