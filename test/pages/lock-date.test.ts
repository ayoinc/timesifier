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
			expect(text, zone).toContain("2–8 November 2026 Approved 40:30");
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

	it("refuses leave asked for on or before it, and approving leave that reaches it", async () => {
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

	it("a pending request the lock date has reached can be withdrawn or refused, and its later days asked for again", async () => {
		const grace = await joined("grace@example.com", "member");
		const annual = await kindOf(acme.id, "annual");
		const timeOff = `/app/${acme.slug}/time-off`;
		const asked = await seedLeave(acme.id, grace.user.id, "annual", "2026-11-05", "2026-11-20", {
			status: "pending",
		});
		const other = await seedLeave(acme.id, grace.user.id, "annual", "2026-11-04", "2026-11-04", {
			status: "pending",
		});
		await post(settings, { intent: "lock-date", lockedThrough: "2026-11-06" }, ada);
		const statusOf = (id: string) =>
			value<string>("select status from leave_requests where id = ?", id);

		// Approving would put leave on a locked day: it says what can be done instead.
		const approve = await submit(timeOff, { intent: "approve", requestId: asked }, ada, {
			byScript: true,
		});
		expect(approve.status).toBe(409);
		expect(await approve.text()).toContain(
			"Thu 5 is on or before the lock date, so this leave cannot be approved. It can be withdrawn, and the days from Sat 7, the first open day, asked for again.",
		);
		expect(await statusOf(asked)).toBe("pending");

		// Withdrawing and refusing change no day: the lock date does not stop them.
		expect(await post(timeOff, { intent: "withdraw", requestId: asked }, grace)).toBe(200);
		expect(await statusOf(asked)).toBe("withdrawn");
		expect(await post(timeOff, { intent: "refuse", requestId: other }, ada)).toBe(200);
		expect(await statusOf(other)).toBe("refused");

		expect(
			await post(
				timeOff,
				{
					intent: "request",
					kindId: annual,
					startsOn: "2026-11-16",
					endsOn: "2026-11-20",
					noticeReason: "Asked again from the first open week",
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
		// Nobody else may approve the owner's week, so the system approves it too (D5).
		expect(periods).toEqual([
			{ userId: ada.user.id, startsOn: "2026-10-26", status: "approved" },
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

describe("the lock date, timers and the weeks it submits (TS-111d)", () => {
	async function runAt(instant: string, cron = "0 * * * *") {
		const controller = createScheduledController({ scheduledTime: Date.parse(instant), cron });
		const context = createExecutionContext();
		await worker.scheduled(controller, env, context);
		await waitOnExecutionContext(context);
	}

	/** What the page said, with its status. */
	async function say(path: string, fields: Record<string, string>, who: Person) {
		const response = await submit(path, fields, who, { byScript: true });
		return { status: response.status, said: await response.text() };
	}

	const approvals = () => `/app/${acme.slug}/approvals?week=2026-11-09`;

	async function allowOvertime() {
		await env.DB.prepare("update organisations set overtime_policy = 'allowed' where id = ?")
			.bind(acme.id)
			.run();
	}

	/** K1: Grace works Mon–Fri 7:30 of 9–15 November with annual leave on Tuesday; Linus Mon–Thu, then a timer from Friday 09:00 never stopped. */
	async function seedK1() {
		await allowOvertime();
		const grace = await joined("grace@example.com", "member");
		const linus = await joined("linus@example.com", "member");
		for (const day of ["09", "10", "11", "12", "13"]) {
			await seedEntry(
				acme.id,
				grace.user.id,
				site,
				`2026-11-${day}T09:00:00Z`,
				`2026-11-${day}T16:30:00Z`,
			);
		}
		await seedLeave(acme.id, grace.user.id, "annual", "2026-11-10", "2026-11-10");
		for (const day of ["09", "10", "11", "12"]) {
			await seedEntry(
				acme.id,
				linus.user.id,
				site,
				`2026-11-${day}T09:00:00Z`,
				`2026-11-${day}T16:30:00Z`,
			);
		}
		const timer = await seedEntry(acme.id, linus.user.id, site, "2026-11-13T09:00:00Z", null);
		await post(
			settings,
			{
				intent: "deadline",
				deadlineKind: "weekly",
				weekday: "7",
				time: "23:00",
				autoLockDays: "1",
				autoSubmitAtLock: "on",
			},
			ada,
		);
		return { grace, linus, timer };
	}

	it("a week the system submits with a day over its limit says so to its approver", async () => {
		const { grace, linus } = await seedK1();
		await runAt("2026-11-16T23:00:00Z");
		expect(await lockedThrough()).toBe("2026-11-15");
		clock.mockReturnValue(Date.parse("2026-11-17T09:00:00Z"));

		const text = textOf(await (await open(approvals(), ada)).text());
		expect(text).toContain("Over by 7:30 on Tue 10");
		expect(text).toContain("Submitted by the system");

		const all = await say(approvals(), { intent: "approve-all", startsOn: "2026-11-09" }, ada);
		expect(all.status).toBe(200);
		expect(all.said).toContain("1 timesheet approved.");
		expect(all.said).toContain("1 was left: it has a day over its limit.");
		const statusOf = (who: Person) =>
			value<string>("select status from periods where user_id = ?", who.user.id);
		expect(await statusOf(linus)).toBe("approved");
		expect(await statusOf(grace)).toBe("submitted");

		// Approving hers alone asks first, then says in the log that it was over.
		const periodId = await value<string>("select id from periods where user_id = ?", grace.user.id);
		const asked = await say(approvals(), { intent: "approve", periodId: periodId ?? "" }, ada);
		expect(asked.status).toBe(409);
		expect(asked.said).toContain("Over by 7:30 on Tue 10");
		expect(await statusOf(grace)).toBe("submitted");
		expect(
			(
				await say(
					approvals(),
					{ intent: "approve", periodId: periodId ?? "", overLimit: "on" },
					ada,
				)
			).status,
		).toBe(200);
		const summary = await value<string>(
			"select summary from activity_records where action = 'period.approved' and owner_id = ?",
			grace.user.id,
		);
		expect(JSON.parse(summary ?? "{}").after).toMatchObject({
			status: "approved",
			overLimit: "Over by 7:30 on Tue 10",
		});
	});

	it("a timer running on a day the lock date reaches is stopped by the system at that moment", async () => {
		const { linus, timer } = await seedK1();
		await runAt("2026-11-16T23:00:00Z");
		// Ended at the trigger's instant: its overtime runs to then.
		expect(
			await value(
				"select max(ended_at) from time_entries where user_id = ? and spent_on = '2026-11-13'",
				linus.user.id,
			),
		).toBe(Date.parse("2026-11-16T23:00:00Z"));
		expect(await value("select count(*) from time_entries where ended_at is null")).toBe(0);
		expect(
			await value(
				"select count(*) from activity_records where action = 'time_entry.stopped' and subject_id = ? and actor_id is null and source = 'system'",
				timer,
			),
		).toBe(1);
		// Cut by the limit: Friday's 7:30 is regular, the rest overtime on Friday.
		expect(
			await row(
				"select count(*) as entries, sum(overtime) as overtime from time_entries where user_id = ? and spent_on = '2026-11-13'",
				linus.user.id,
			),
		).toEqual({ entries: 2, overtime: 1 });

		clock.mockReturnValue(Date.parse("2026-11-17T10:00:00Z"));
		const total = () =>
			value<number>(
				"select sum(ended_at - started_at) from time_entries where user_id = ?",
				linus.user.id,
			);
		const before = await total();
		const stop = await say(sheet, { intent: "stop" }, linus);
		expect(stop.said).toContain("No timer was running.");
		await say(approvals(), { intent: "approve-all", startsOn: "2026-11-09" }, ada);
		expect(await value("select status from periods where user_id = ?", linus.user.id)).toBe(
			"approved",
		);
		expect(await total()).toBe(before);
	});

	it("moving the lock date by hand stops a timer on the days it locks, and one after them runs on", async () => {
		// D4a: Linus's timer started on Tuesday 10 at 20:00; Grace's on Wednesday 11.
		await allowOvertime();
		const linus = await joined("linus@example.com", "member");
		const grace = await joined("grace@example.com", "member");
		const tuesday = await seedEntry(acme.id, linus.user.id, site, "2026-11-10T20:00:00Z", null);
		const wednesday = await seedEntry(acme.id, grace.user.id, site, "2026-11-11T09:00:00Z", null);
		expect(await post(settings, { intent: "lock-date", lockedThrough: "2026-11-10" }, ada)).toBe(
			200,
		);
		expect(
			await value(
				"select max(ended_at) from time_entries where user_id = ? and spent_on = '2026-11-10'",
				linus.user.id,
			),
		).toBe(T0);
		expect(await value("select ended_at is not null from time_entries where id = ?", tuesday)).toBe(
			1,
		);
		expect(
			await value(
				"select actor_id is null and source = 'system' from activity_records where action = 'time_entry.stopped' and subject_id = ?",
				tuesday,
			),
		).toBe(1);
		// Cut at Tuesday's 7:30: 20:00 to 03:30 regular, the rest overtime, both Tuesday's.
		expect(
			await row(
				"select count(*) as entries, sum(overtime) as overtime from time_entries where user_id = ? and spent_on = '2026-11-10'",
				linus.user.id,
			),
		).toEqual({ entries: 2, overtime: 1 });
		expect(await value("select ended_at from time_entries where id = ?", wednesday)).toBeNull();
	});

	it("a week with a running timer is not approved", async () => {
		const grace = await joined("grace@example.com", "member");
		await seedEntry(acme.id, grace.user.id, site, "2026-11-09T09:00:00Z", "2026-11-09T16:30:00Z");
		const periodId = await seedPeriod(acme.id, grace.user.id, "2026-11-09");
		await seedEntry(acme.id, grace.user.id, site, "2026-11-11T09:00:00Z", null);
		const one = await say(approvals(), { intent: "approve", periodId }, ada);
		expect(one.status).toBe(409);
		expect(one.said).toContain("A timer of theirs is running in this week");
		const all = await say(approvals(), { intent: "approve-all", startsOn: "2026-11-09" }, ada);
		expect(all.said).toContain("No timesheet approved.");
		expect(await value("select status from periods where id = ?", periodId)).toBe("submitted");
	});

	it("auto-submit leaves a returned week as it is, with its reason", async () => {
		// K4.
		const grace = await joined("grace@example.com", "member");
		await entryOn(grace, "2026-11-03");
		const periodId = await seedPeriod(acme.id, grace.user.id, "2026-11-02", "returned");
		await env.DB.prepare("update periods set comment = ? where id = ?")
			.bind("Tuesday is on the wrong project.", periodId)
			.run();
		expect(
			await post(
				settings,
				{ intent: "lock-date", lockedThrough: "2026-11-08", autoSubmit: "on" },
				ada,
			),
		).toBe(200);
		expect(await row("select status, comment from periods where id = ?", periodId)).toEqual({
			status: "returned",
			comment: "Tuesday is on the wrong project.",
		});
		// Her Day view says only that the lock date holds the week.
		const text = textOf(await (await open(`/app/${acme.slug}?day=2026-11-03`, grace)).text());
		expect(text).toContain("Returned: Tuesday is on the wrong project.");
		expect(text).toContain("The lock date holds this week");
		expect(text).not.toContain("Correct the week and submit it again");
		expect(text).not.toContain("Submit week");
	});

	it("a Friday deadline submits the week it closes", async () => {
		// K2: deadline Friday 17:00, auto-lock at once, weeks from Monday.
		const grace = await joined("grace@example.com", "member");
		for (const day of ["09", "10", "11", "12", "13"]) {
			await seedEntry(
				acme.id,
				grace.user.id,
				site,
				`2026-11-${day}T09:00:00Z`,
				`2026-11-${day}T16:30:00Z`,
			);
		}
		await post(
			settings,
			{
				intent: "deadline",
				deadlineKind: "weekly",
				weekday: "5",
				time: "17:00",
				autoLockDays: "0",
				autoSubmitAtLock: "on",
			},
			ada,
		);
		await runAt("2026-11-13T17:00:00Z");
		expect(await lockedThrough()).toBe("2026-11-13");
		// Friday has not ended in London, so the lock date has not reached it yet.
		expect(await value("select count(*) from periods")).toBe(0);
		await runAt("2026-11-14T00:00:00Z");
		expect(
			await row(
				"select starts_on as startsOn, status from periods where user_id = ?",
				grace.user.id,
			),
		).toEqual({ startsOn: "2026-11-09", status: "submitted" });
	});
});

describe("the lock date reaches a person's day once it has ended where they are (D7)", () => {
	const LOS_ANGELES = "America/Los_Angeles";

	async function runAt(instant: string) {
		const controller = createScheduledController({
			scheduledTime: Date.parse(instant),
			cron: "0 * * * *",
		});
		const context = createExecutionContext();
		await worker.scheduled(controller, env, context);
		await waitOnExecutionContext(context);
	}

	it("locks today for each person only at their midnight", async () => {
		const linus = await joined("linus@example.com", "member");
		await env.DB.prepare("update users set time_zone = ? where id = ?")
			.bind(LOS_ANGELES, linus.user.id)
			.run();
		expect(await post(settings, { intent: "lock-date", lockedThrough: "2026-11-11" }, ada)).toBe(
			200,
		);
		const track = (day: string, who: Person) =>
			post(sheet, { intent: "track", projectId: site, day, hours: "1" }, who);
		const cell = (day: string, who: Person) =>
			post(sheet, { intent: "cell", projectId: site, day, hours: "2" }, who);
		// Wednesday 11 at 10:00 in London: the day has not ended for anyone.
		expect(await track("2026-11-11", ada)).toBe(200);
		expect(await cell("2026-11-11", linus)).toBe(200);
		expect(await track("2026-11-10", ada)).toBe(409);

		// Thursday 01:00 in London, Wednesday 17:00 in Los Angeles.
		clock.mockReturnValue(Date.parse("2026-11-12T01:00:00Z"));
		expect(await track("2026-11-11", ada)).toBe(409);
		expect(await track("2026-11-11", linus)).toBe(200);
		const day = textOf(await (await open(`/app/${acme.slug}?day=2026-11-11`, linus)).text());
		expect(day).not.toContain("This day is on or before the lock date");

		// Thursday 08:30 in London: Wednesday has ended in Los Angeles too.
		clock.mockReturnValue(Date.parse("2026-11-12T08:30:00Z"));
		expect(await track("2026-11-11", linus)).toBe(409);
	});

	it("stops a timer once its day has ended where its person is", async () => {
		const linus = await joined("linus@example.com", "member");
		await env.DB.prepare("update users set time_zone = ? where id = ?")
			.bind(LOS_ANGELES, linus.user.id)
			.run();
		// Wednesday 11, 09:00 in Los Angeles.
		const timer = await seedEntry(acme.id, linus.user.id, site, "2026-11-11T17:00:00Z", null);
		clock.mockReturnValue(Date.parse("2026-11-11T18:00:00Z"));
		expect(await post(settings, { intent: "lock-date", lockedThrough: "2026-11-11" }, ada)).toBe(
			200,
		);
		expect(await value("select ended_at from time_entries where id = ?", timer)).toBeNull();
		await runAt("2026-11-12T07:00:00Z");
		expect(await value("select ended_at from time_entries where id = ?", timer)).toBeNull();
		// Wednesday ends in Los Angeles at 08:00 in London.
		await runAt("2026-11-12T08:00:00Z");
		expect(await value("select ended_at from time_entries where id = ?", timer)).toBe(
			Date.parse("2026-11-12T08:00:00Z"),
		);
	});

	it("says so in Workspace settings beside the field", async () => {
		const text = textOf(await (await open(settings, ada)).text());
		expect(text).toContain(
			"The lock date reaches each person's day once that day has ended where they are",
		);
	});
});
