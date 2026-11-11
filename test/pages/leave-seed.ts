import { env } from "cloudflare:workers";

import { uuidv7 } from "~/db";
import type { KindKey, LeaveStatus } from "~/leave/kinds";

// Leave written straight to the database (TS-061), for the pages that only
// show it: Team, Timesheet, Approvals and Reports. Time off's own tests make
// their requests through the page.

/** The id of the organisation's kind of leave with `key`: every organisation has the six. */
export async function kindOf(organisationId: string, key: KindKey): Promise<string> {
	const found = await env.DB.prepare(
		"select id from leave_kinds where organisation_id = ? and key = ?",
	)
		.bind(organisationId, key)
		.first<{ id: string }>();
	if (!found) throw new Error(`no ${key} kind`);
	return found.id;
}

/** A request of `userId` for leave of `key` from `startsOn` to `endsOn`, standing at `status`. */
export async function seedLeave(
	organisationId: string,
	userId: string,
	key: KindKey,
	startsOn: string,
	endsOn: string,
	{
		status = "approved" as LeaveStatus,
		startsHalf = false,
		endsHalf = false,
	}: { status?: LeaveStatus; startsHalf?: boolean; endsHalf?: boolean } = {},
): Promise<string> {
	const id = uuidv7();
	const now = Date.now();
	await env.DB.prepare(
		"insert into leave_requests (id, organisation_id, user_id, kind_id, starts_on, ends_on, starts_half, ends_half, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(
			id,
			organisationId,
			userId,
			await kindOf(organisationId, key),
			startsOn,
			endsOn,
			startsHalf ? 1 : 0,
			endsHalf ? 1 : 0,
			status,
			now,
			now,
		)
		.run();
	return id;
}

/** A public holiday of the organisation on `day`. */
export async function seedHoliday(organisationId: string, day: string, name: string) {
	const now = Date.now();
	await env.DB.prepare(
		"insert into public_holidays (id, organisation_id, day, name, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
	)
		.bind(uuidv7(), organisationId, day, name, now, now)
		.run();
}
