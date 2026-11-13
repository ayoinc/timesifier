import {
	createExecutionContext,
	createScheduledController,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "~/db";
import worker from "../../workers/app";
import { DAILY } from "../../workers/scheduled";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	type Role,
	row,
	seedMembership,
	seedTeam,
	value,
} from "../organisations/harness";
import { open, type Person, person, submit, textOf } from "./harness";
import { kindOf, seedLeave } from "./leave-seed";
import { markOvertime, seedEntry, seedPeriod } from "./periods-seed";

// The lock date and the timesheet deadline (TS-065): set by owners and admins
// in Workspace settings, binding everyone, owner included, on every write of
// time and leave, moved back only with a reason the activity log keeps; and
// auto-lock and auto-submit on the scheduled handler, on a fake clock.

/** Wednesday 11 November 2026, 10:00 in London. */
const T0 = Date.parse("2026-11-11T10:00:00Z");
const LONDON = "Europe/London";

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string; slug: string };
let site: string;
/** The test's clock, put back to the real one while someone signs in. */
let clock: ReturnType<typeof vi.spyOn>;
let settings: string;
let sheet: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	await env.DB.prepare("update organisations set time_zone = ? where id = ?")
		.bind(LONDON, acme.id)
		.run();
	site = uuidv7();
	await env.DB.prepare(
		"insert into projects (id, organisation_id, name, name_key, created_at, updated_at) values (?, ?, 'Site', 'site', 0, 0)",
	)
		.bind(site, acme.id)
		.run();
	settings = `/app/${acme.slug}/settings`;
	sheet = `/app/${acme.slug}?index`;
	clock = vi.spyOn(Date, "now").mockReturnValue(T0);
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

/** A person in Acme with `role`; `manages` makes them manage a team of their own. */
async function joined(email: string, role: Role, manages = false) {
	// Signing in reads the real clock: the code would not count on the test's.
	clock.mockRestore();
	const who = await person(mailbox, email);
	clock = vi.spyOn(Date, "now").mockReturnValue(T0);
	await seedMembership(acme.id, who.user.id, role);
	if (manages) await seedTeam(acme.id, `Team of ${email}`, { managers: [who.user.id] });
	return who;
}

async function post(path: string, fields: Record<string, string>, who: Person) {
	return (await submit(path, fields, who, { byScript: true })).status;
}

/** An entry of `who` from 09:00 to 10:00 UTC on `day`. */
async function entryOn(who: Person, day: string) {
	const id = uuidv7();
	await env.DB.prepare(
		"insert into time_entries (id, organisation_id, user_id, project_id, description, started_at, spent_on, ended_at, created_at, updated_at) values (?, ?, ?, ?, 'Survey', ?, ?, ?, 0, 0)",
	)
		.bind(
			id,
			acme.id,
			who.user.id,
			site,
			Date.parse(`${day}T09:00:00Z`),
			day,
			Date.parse(`${day}T10:00:00Z`),
		)
		.run();
	return id;
}

const lockedThrough = () =>
	value<string | null>("select locked_through from organisations where id = ?", acme.id);

describe("Workspace settings, Timesheet locking", () => {
	it("is shown to owners and admins, with the lock date and the deadline", async () => {
		const html = textOf(await (await open(settings, ada)).text());
		expect(html).toContain("Timesheet locking");
		expect(html).toContain("No lock date");
	});

	it.each([
		["owner", true],
		["admin", true],
		["finance", false],
		["manager", false],
		["member", false],
	] as const)("lets %s set the lock date: %s", async (role, allowed) => {
		const who =
			role === "owner"
				? ada
				: await joined(
						`${role}@example.com`,
						role === "manager" ? "member" : role,
						role === "manager",
					);
		const status = await post(settings, { intent: "lock-date", lockedThrough: "2026-11-05" }, who);
		expect(status).toBe(allowed ? 200 : 404);
		expect(await lockedThrough()).toBe(allowed ? "2026-11-05" : null);
	});

	it("sets a weekly or a monthly deadline, with auto-lock and auto-submit, in the organisation's zone", async () => {
		expect(
			await post(
				settings,
				{
					intent: "deadline",
					deadlineKind: "weekly",
					weekday: "5",
					time: "17:00",
					autoLockDays: "2",
					autoSubmitAtLock: "on",
				},
				ada,
			),
		).toBe(200);
		expect(
			await row(
				"select deadline_kind as kind, deadline_day as day, deadline_time as time, auto_lock_days as wait, auto_submit_at_lock as submit from organisations where id = ?",
				acme.id,
			),
		).toEqual({ kind: "weekly", day: 5, time: "17:00", wait: 2, submit: 1 });

		expect(
			await post(
				settings,
				{ intent: "deadline", deadlineKind: "monthly", monthDay: "31", time: "18:00" },
				ada,
			),
		).toBe(200);
		expect(
			await row(
				"select deadline_kind as kind, deadline_day as day, auto_lock_days as wait from organisations where id = ?",
				acme.id,
			),
		).toEqual({
			kind: "monthly",
			day: 31,
			wait: null,
		});
		// Auto-lock waits on a deadline: with none, it is off.
		await post(settings, { intent: "deadline", deadlineKind: "none", autoLockDays: "3" }, ada);
		expect(
			await value("select auto_lock_days from organisations where id = ?", acme.id),
		).toBeNull();
		expect(
			await post(settings, { intent: "deadline", deadlineKind: "weekly", time: "17:00" }, ada),
		).toBe(400);
		expect(
			await value("select count(*) from activity_records where action = 'deadline.changed'"),
		).toBe(3);
	});

	it("refuses a lock date after today, in the organisation's zone", async () => {
		expect(await post(settings, { intent: "lock-date", lockedThrough: "2026-11-12" }, ada)).toBe(
			400,
		);
		// Malformed input is refused before anything is read.
		expect(await post(settings, { intent: "lock-date", lockedThrough: "2026-02-30" }, ada)).toBe(
			400,
		);
		expect(
			await post(
				settings,
				{ intent: "deadline", deadlineKind: "weekly", weekday: "8", time: "25:00" },
				ada,
			),
		).toBe(400);
		expect(
			await post(
				settings,
				{
					intent: "deadline",
					deadlineKind: "monthly",
					monthDay: "5",
					time: "09:00",
					autoLockDays: "61",
				},
				ada,
			),
		).toBe(400);
		expect(await post(settings, { intent: "lock-date", lockedThrough: "2026-11-11" }, ada)).toBe(
			200,
		);
	});

	it("moves the date back, or removes it, only with a reason, which the activity log keeps", async () => {
		await post(settings, { intent: "lock-date", lockedThrough: "2026-11-05" }, ada);
		expect(await post(settings, { intent: "lock-date", lockedThrough: "2026-11-01" }, ada)).toBe(
			400,
		);
		expect(await lockedThrough()).toBe("2026-11-05");
		expect(
			await post(
				settings,
				{ intent: "lock-date", lockedThrough: "2026-11-01", reason: "Payroll fix" },
				ada,
			),
		).toBe(200);
		expect(await post(settings, { intent: "remove-lock-date", reason: "" }, ada)).toBe(400);
		expect(
			await post(settings, { intent: "remove-lock-date", reason: "Year end reopened" }, ada),
		).toBe(200);
		expect(await lockedThrough()).toBeNull();

		const { results } = await env.DB.prepare(
			"select actor_id as actor, summary from activity_records where action = 'lock_date.changed' order by rowid",
		).all<{ actor: string; summary: string }>();
		expect(results.map((r) => [r.actor, JSON.parse(r.summary)])).toEqual([
			[ada.user.id, { before: { lockedThrough: null }, after: { lockedThrough: "2026-11-05" } }],
			[
				ada.user.id,
				{
					before: { lockedThrough: "2026-11-05" },
					after: { lockedThrough: "2026-11-01", reason: "Payroll fix" },
				},
			],
			[
				ada.user.id,
				{
					before: { lockedThrough: "2026-11-01" },
					after: { lockedThrough: null, reason: "Year end reopened" },
				},
			],
		]);
	});
});

describe("the lock date binds everyone", () => {
	it.each(["owner", "admin", "finance", "manager", "member"] as const)(
		"%s can neither add, change nor delete time on or before it, and can after it",
		async (role) => {
			const who =
				role === "owner"
					? ada
					: await joined(
							`${role}@example.com`,
							role === "manager" ? "member" : role,
							role === "manager",
						);
			const locked = await entryOn(who, "2026-11-04");
			await post(settings, { intent: "lock-date", lockedThrough: "2026-11-05" }, ada);

			const edit = {
				intent: "edit",
				entryId: locked,
				projectId: site,
				date: "2026-11-04",
				start: "09:00",
				end: "11:00",
			};
			expect(await post(sheet, edit, who)).toBe(409);
			expect(await post(sheet, { ...edit, date: "2026-11-09" }, who)).toBe(409);
			expect(await post(sheet, { intent: "delete", entryId: locked }, who)).toBe(409);
			expect(
				await post(sheet, { intent: "track", projectId: site, day: "2026-11-05", hours: "1" }, who),
			).toBe(409);
			expect(
				await post(sheet, { intent: "cell", projectId: site, day: "2026-11-03", hours: "2" }, who),
			).toBe(409);
			expect(await value("select count(*) from time_entries where user_id = ?", who.user.id)).toBe(
				1,
			);

			// The day after it is open, and moving an open entry onto it is not.
			expect(
				await post(sheet, { intent: "track", projectId: site, day: "2026-11-06", hours: "1" }, who),
			).toBe(200);
			const open = await entryOn(who, "2026-11-09");
			expect(
				await post(
					sheet,
					{
						intent: "edit",
						entryId: open,
						projectId: site,
						date: "2026-11-05",
						start: "09:00",
						end: "10:00",
					},
					who,
				),
			).toBe(409);
		},
	);

	it("a change of zone leaves locked time locked", async () => {
		// P2 (TR-03): Grace's approved week of 2-8 November, 37:30 and 3:00 of
		// overtime on Sunday 8 from 20:00 to 23:00 in London, the lock date the 8th.
		const grace = await joined("grace@example.com", "member");
		await env.DB.prepare("update users set time_zone = ? where id = ?")
			.bind(LONDON, grace.user.id)
			.run();
		for (const day of ["02", "03", "04", "05", "06"]) {
			await seedEntry(
				acme.id,
				grace.user.id,
				site,
				`2026-11-${day}T09:00:00Z`,
				`2026-11-${day}T16:30:00Z`,
			);
		}
		const sunday = await seedEntry(
			acme.id,
			grace.user.id,
			site,
			"2026-11-08T20:00:00Z",
			"2026-11-08T23:00:00Z",
		);
		await markOvertime(sunday);
		await seedPeriod(acme.id, grace.user.id, "2026-11-02", "approved");
		await post(settings, { intent: "lock-date", lockedThrough: "2026-11-08" }, ada);
		const history = `/app/${acme.slug}?view=history`;
		const edit = {
			intent: "edit",
			entryId: sunday,
			projectId: site,
			date: "2026-11-09",
			start: "05:00",
			end: "07:00",
		};

		for (const zone of ["Asia/Tokyo", "America/Los_Angeles"]) {
			expect(
				await post(`/app/${acme.slug}/account`, { intent: "time-zone", timeZone: zone }, grace),
			).toBe(200);
			expect(await post(sheet, edit, grace), zone).toBe(409);
			expect(await post(sheet, { intent: "delete", entryId: sunday }, grace), zone).toBe(409);
			expect(await value("select spent_on from time_entries where id = ?", sunday), zone).toBe(
				"2026-11-08",
			);
			const text = textOf(await (await open(history, grace)).text());
			expect(text, zone).toContain("40:30");
			expect(text, zone).toContain("3:00 overtime");
		}
		expect(await value("select status from periods where user_id = ?", grace.user.id)).toBe(
			"approved",
		);
	});

	it("tells the person why on the Day view", async () => {
		await post(
			settings,
			{ intent: "lock-date", lockedThrough: "2026-11-05", reason: "October payroll" },
			ada,
		);
		const text = textOf(await (await open(`/app/${acme.slug}?day=2026-11-04`, ada)).text());
		expect(text).toContain("This day is on or before the lock date");
		expect(text).toContain("October payroll");
	});

	it("refuses leave asked for on or before it, and deciding or withdrawing leave that reaches it", async () => {
		const grace = await joined("grace@example.com", "member");
		await post(settings, { intent: "lock-date", lockedThrough: "2026-11-05" }, ada);
		const annual = await kindOf(acme.id, "annual");
		const timeOff = `/app/${acme.slug}/time-off`;
		expect(
			await post(
				timeOff,
				{ intent: "request", kindId: annual, startsOn: "2026-11-05", endsOn: "2026-11-06" },
				grace,
			),
		).toBe(400);
		const pending = await seedLeave(acme.id, grace.user.id, "annual", "2026-11-04", "2026-11-04", {
			status: "pending",
		});
		expect(await post(timeOff, { intent: "approve", requestId: pending }, ada)).toBe(409);
		expect(await post(timeOff, { intent: "withdraw", requestId: pending }, grace)).toBe(409);
		expect(await value("select status from leave_requests where id = ?", pending)).toBe("pending");
		expect(
			await post(
				timeOff,
				{
					intent: "request",
					kindId: annual,
					startsOn: "2026-11-16",
					endsOn: "2026-11-16",
					// Less than annual leave's notice (TS-090), so it says why.
					noticeReason: "A family wedding",
				},
				grace,
			),
		).toBe(200);
	});
});

describe("auto-submit", () => {
	it("submits every unsubmitted week up to the new lock date, as the system", async () => {
		const grace = await joined("grace@example.com", "member");
		await entryOn(grace, "2026-11-03");
		await entryOn(ada, "2026-10-27");
		expect(
			await post(
				settings,
				{ intent: "lock-date", lockedThrough: "2026-11-08", autoSubmit: "on" },
				ada,
			),
		).toBe(200);

		const { results: periods } = await env.DB.prepare(
			"select user_id as userId, starts_on as startsOn, status from periods order by starts_on",
		).all();
		expect(periods).toEqual([
			{ userId: ada.user.id, startsOn: "2026-10-26", status: "submitted" },
			{ userId: grace.user.id, startsOn: "2026-11-02", status: "submitted" },
		]);
		expect(
			await value(
				"select count(*) from period_events where actor_id is null and action = 'submitted'",
			),
		).toBe(2);
		expect(
			await value(
				"select count(*) from activity_records where action = 'period.submitted' and actor_id is null and source = 'system'",
			),
		).toBe(2);
	});
});

describe("the scheduled handler", () => {
	async function runAt(instant: string, cron = "0 * * * *") {
		const controller = createScheduledController({ scheduledTime: Date.parse(instant), cron });
		const context = createExecutionContext();
		await worker.scheduled(controller, env, context);
		await waitOnExecutionContext(context);
	}

	it("auto-locks N days after each deadline, never backward, and submits as the system when asked", async () => {
		const grace = await joined("grace@example.com", "member");
		await entryOn(grace, "2026-11-04");
		await post(
			settings,
			{
				intent: "deadline",
				deadlineKind: "weekly",
				weekday: "5",
				time: "17:00",
				autoLockDays: "1",
				autoSubmitAtLock: "on",
			},
			ada,
		);
		await runAt("2026-11-14T16:00:00Z");
		expect(await lockedThrough()).toBe("2026-11-06");
		await runAt("2026-11-14T17:00:00Z");
		expect(await lockedThrough()).toBe("2026-11-13");
		expect(await value("select status from periods where user_id = ?", grace.user.id)).toBe(
			"submitted",
		);
		expect(
			await value(
				"select count(*) from activity_records where action = 'lock_date.changed' and actor_id is null and source = 'system'",
			),
		).toBe(2);

		// Moved back by hand, it stays back until the next deadline.
		await post(
			settings,
			{ intent: "lock-date", lockedThrough: "2026-11-01", reason: "Corrections" },
			ada,
		);
		await runAt("2026-11-15T09:00:00Z");
		expect(await lockedThrough()).toBe("2026-11-01");
		await runAt("2026-11-21T17:00:00Z");
		expect(await lockedThrough()).toBe("2026-11-20");
	});

	it("deletes activity records older than two years once a day, and no record can be changed", async () => {
		const old = Date.parse("2024-11-01T00:00:00Z");
		await env.DB.prepare(
			"insert into activity_records (id, organisation_id, actor_id, source, action, subject_type, subject_id, owner_id, summary, created_at) values (?, ?, null, 'system', 'lock_date.changed', 'organisation', ?, null, '{}', ?)",
		)
			.bind(uuidv7(), acme.id, acme.id, old)
			.run();
		await expect(
			env.DB.prepare("update activity_records set action = 'x'").run(),
		).rejects.toThrow();
		const before = await value("select count(*) from activity_records");
		await runAt("2026-11-12T03:17:00Z", "0 * * * *");
		expect(await value("select count(*) from activity_records")).toBe(before);
		await runAt("2026-11-12T03:17:00Z", DAILY);
		expect(await value("select count(*) from activity_records where created_at = ?", old)).toBe(0);
	});
});
