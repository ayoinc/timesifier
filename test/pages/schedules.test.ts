import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { organisationScope } from "~/db";
import { makeToken } from "~/integrations/api-tokens.server";
import { LONG_WEEK, STANDARD_WEEK, weekOfMinutes } from "~/schedules/schedules";
import migration from "../../migrations/0018_work_schedules.sql?raw";
import { captureEmail, type Mailbox, ORIGIN } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { row, value } from "../organisations/harness";
import { open, openData, type Person, pageBody, submit, textOf } from "./harness";
import { seedLeave } from "./leave-seed";
import { seedEntry, seedProject } from "./periods-seed";
import { KINDS, type Roles, seedRoles } from "./roles-seed";
import { scheduleNamed, seedAssignment, seedSchedule, seedVersion } from "./schedule-seed";

// Work schedules (TS-097): the page in Workspace settings, who may use it,
// every change it makes, and each place that reads a person's expected hours
// or working days reading their schedule for the day: Timesheet's limits and
// views, Team, Reports, Utilisation, Dashboards, Approvals, Time off, the
// API, the CSV import and calendar feeds, and My account.

const PAGE = "/app/acme/settings/schedules";
/** Monday 9 November 2026, noon in London. */
const T0 = Date.parse("2026-11-09T12:00:00Z");
const MONDAY = "2026-11-09";

let mailbox: Mailbox;
let roles: Roles;
let acme: Roles["acme"];

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	roles = await seedRoles(mailbox);
	acme = roles.acme;
	vi.spyOn(Date, "now").mockReturnValue(T0);
}, 60_000);

afterEach(() => {
	vi.restoreAllMocks();
});

const ask = async (who: Person, fields: Record<string, string>) => {
	const response = await submit(PAGE, fields, who, { byScript: true });
	return { status: response.status, said: await response.text() };
};

const text = async (path: string, who: Person) => {
	const response = await open(path, who);
	expect(response.status, path).toBe(200);
	return textOf(await pageBody(response));
};

/** The fields of a schedule's sheet: Monday to Friday 09:00 to 17:30, an hour's break. */
function scheduleFields(name: string, more: Record<string, string> = {}) {
	return {
		name,
		overtime: "organisation",
		overtimeDayCap: "",
		overtimeWeekCap: "",
		weekend: "organisation",
		...Object.fromEntries(
			[1, 2, 3, 4, 5].flatMap((n) => [
				[`worked${n}`, "on"],
				[`start${n}`, "09:00"],
				[`finish${n}`, "17:30"],
				[`break${n}`, "60"],
			]),
		),
		...more,
	};
}

const recorded = (action: string) =>
	value<number>(
		"select count(*) from activity_records where organisation_id = ? and action = ?",
		acme.id,
		action,
	);

/** Monday to Wednesday, 09:00 to 14:00 without a break: 15 hours a week. */
const SHORT_WEEK = weekOfMinutes([300, 300, 300, 0, 0, 0, 0]);

describe("every organisation's schedules", () => {
	it("starts with Standard, its default, and Long", async () => {
		const rows = (
			await env.DB.prepare(
				"select s.name, sum(d.finish_minute - d.start_minute - d.break_minutes) as minutes, count(d.id) as days from work_schedules s join work_schedule_versions v on v.schedule_id = s.id join work_schedule_days d on d.version_id = v.id where s.organisation_id = ? group by s.id order by s.name",
			)
				.bind(acme.id)
				.all()
		).results;
		expect(rows).toEqual([
			{ name: "Long", minutes: 2400, days: 5 },
			{ name: "Standard", minutes: 2250, days: 5 },
		]);
		expect(
			await value(
				"select s.name from schedule_assignments a join work_schedules s on s.id = a.schedule_id where a.organisation_id = ? and a.target_kind = 'organisation'",
				acme.id,
			),
		).toBe("Standard");
	});

	it("are made from an organisation's own working week by the migration, keeping its hours exactly", async () => {
		await env.DB.prepare(
			"update working_days set minutes = case weekday when 1 then 480 when 2 then 451 when 6 then 240 when 7 then 1440 else 0 end where organisation_id = ?",
		)
			.bind(acme.id)
			.run();
		for (const table of ["schedule_assignments", "work_schedules"]) {
			await env.DB.prepare(`delete from ${table} where organisation_id = ?`).bind(acme.id).run();
		}
		// The statements of the migration that give schedules to the organisations already there.
		const statements = migration
			.split("--> statement-breakpoint")
			.map((s) => s.trim())
			.filter((s) => s.startsWith("INSERT"));
		for (const sql of statements) await env.DB.prepare(sql).run();
		const days = (
			await env.DB.prepare(
				"select d.weekday, d.start_minute, d.finish_minute, d.break_minutes from work_schedule_days d join work_schedule_versions v on v.id = d.version_id join work_schedules s on s.id = v.schedule_id where s.organisation_id = ? and s.name = 'Working week' order by d.weekday",
			)
				.bind(acme.id)
				.all()
		).results;
		expect(days).toEqual([
			{ weekday: 1, start_minute: 540, finish_minute: 1080, break_minutes: 60 },
			{ weekday: 2, start_minute: 540, finish_minute: 1051, break_minutes: 60 },
			{ weekday: 6, start_minute: 540, finish_minute: 780, break_minutes: 0 },
			{ weekday: 7, start_minute: 0, finish_minute: 1440, break_minutes: 0 },
		]);
		expect(
			await value(
				"select s.name from schedule_assignments a join work_schedules s on s.id = a.schedule_id where a.organisation_id = ? and a.target_kind = 'organisation'",
				acme.id,
			),
		).toBe("Working week");
		expect(await text("/app/acme?day=2026-11-10", roles.people.member)).toContain(
			"09:00–17:31, 7:31 expected.",
		);
	});
});

describe("the page, by role", () => {
	it.each(["owner", "admin"] as const)(
		"is the %s's: schedules, assignments and people",
		async (kind) => {
			const page = await text(PAGE, roles.people[kind]);
			expect(page).toContain("Work schedules");
			expect(page).toMatch(/Standard \(default\) Monday to Friday, 09:00–17:30 · 37:30 a week/);
			expect(page).toMatch(/Long Monday to Friday, 09:00–18:00 · 40:00 a week/);
			expect(page).toContain("Default Standard");
			expect(page).toContain("Managers None of its own");
			expect(page).toContain("Design None of its own");
			expect(page).toMatch(
				/linus@example\.com Standard: Monday to Friday, 09:00–17:30 · 37:30 a week The organisation's default\./,
			);
			// Workspace settings sums up the default and links here.
			expect(await text("/app/acme/settings", roles.people[kind])).toContain(
				"Standard Default Everyone without another schedule",
			);
		},
	);

	it.each(["finance", "manager", "member"] as const)(
		"is 404 to the %s, and every form is refused",
		async (kind) => {
			const who = roles.people[kind];
			expect((await open(PAGE, who)).status).toBe(404);
			expect((await openData(PAGE, who)).status).toBe(404);
			const standard = await scheduleNamed(acme.id, "Standard");
			const forms: Record<string, string>[] = [
				{ intent: "create", ...scheduleFields("Mine") },
				{ intent: "change", scheduleId: standard, from: MONDAY, ...scheduleFields("Standard") },
				{ intent: "archive", scheduleId: standard },
				{
					intent: "assign",
					targetKind: "person",
					targetId: who.user.id,
					scheduleId: standard,
					from: MONDAY,
				},
			];
			for (const fields of forms) {
				expect((await ask(who, fields)).status, fields.intent).toBe(404);
			}
			expect(
				await value("select count(*) from work_schedules where organisation_id = ?", acme.id),
			).toBe(2);
			expect(
				await value("select count(*) from schedule_assignments where organisation_id = ?", acme.id),
			).toBe(1);
		},
	);
});

describe("changes an owner or admin makes", () => {
	it.each(["owner", "admin"] as const)(
		"an %s adds a schedule, recorded; a second of the same name is refused",
		async (kind) => {
			const who = roles.people[kind];
			const made = await ask(who, {
				intent: "create",
				...scheduleFields("Early", { start1: "07:00", finish1: "15:00", break1: "30" }),
			});
			expect(made.status).toBe(200);
			expect(made.said).toContain("Early is added.");
			expect(await recorded("work_schedule.created")).toBe(1);
			const monday = await row<{
				start_minute: number;
				finish_minute: number;
				break_minutes: number;
			}>(
				"select d.start_minute, d.finish_minute, d.break_minutes from work_schedule_days d join work_schedule_versions v on v.id = d.version_id join work_schedules s on s.id = v.schedule_id where s.name = 'Early' and d.weekday = 1",
			);
			expect(monday).toEqual({ start_minute: 420, finish_minute: 900, break_minutes: 30 });
			const again = await ask(who, { intent: "create", ...scheduleFields(" early ") });
			expect(again).toMatchObject({ status: 409 });
			expect(again.said).toContain("Another schedule has that name.");
		},
	);

	it("refuses a day that finishes before it starts, a break as long as the day, and no day at all", async () => {
		const ada = roles.people.owner;
		for (const [more, problem] of [
			[{ finish2: "08:00" }, "Tuesday finishes before it starts."],
			[{ break3: "510" }, "Wednesday's break is as long as the day."],
			[
				Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`worked${n}`, ""])),
				"Choose at least one day worked.",
			],
		] as const) {
			const answer = await ask(ada, { intent: "create", ...scheduleFields("Bad", more) });
			expect(answer.status).toBe(400);
			expect(answer.said).toContain(problem);
		}
		expect(await recorded("work_schedule.created")).toBe(0);
	});

	it("changes a schedule from a day: the days before keep what they had, and a past day is refused", async () => {
		const ada = roles.people.owner;
		const linus = roles.people.member;
		const standard = await scheduleNamed(acme.id, "Standard");
		const past = await ask(ada, {
			intent: "change",
			scheduleId: standard,
			from: "2026-11-08",
			...scheduleFields("Standard"),
		});
		expect(past.status).toBe(409);
		expect(past.said).toContain("Choose today or a later day.");
		const changed = await ask(ada, {
			intent: "change",
			scheduleId: standard,
			from: "2026-11-11",
			...scheduleFields("Standard", {
				finish1: "18:00",
				finish2: "18:00",
				finish3: "18:00",
				finish4: "18:00",
				finish5: "18:00",
			}),
		});
		expect(changed.status).toBe(200);
		expect(await recorded("work_schedule.updated")).toBe(1);
		const week = await text("/app/acme?view=week&start=2026-11-09", linus);
		expect(week).toContain("Expected 7:30 7:30 8:00 8:00 8:00 0:00 0:00 Week expected 39:00");
		// The week before is as it was.
		expect(await text("/app/acme?view=week&start=2026-11-02", linus)).toContain(
			"Week expected 37:30",
		);
	});

	it("archives a schedule only when nobody has it, and restores it", async () => {
		const ada = roles.people.owner;
		const standard = await scheduleNamed(acme.id, "Standard");
		const long = await scheduleNamed(acme.id, "Long");
		const refused = await ask(ada, { intent: "archive", scheduleId: standard });
		expect(refused.status).toBe(409);
		expect(refused.said).toContain("Give them another before archiving it.");
		// Given to a team from a later day, it is still in use.
		await seedAssignment(acme.id, { kind: "role", id: "finance" }, long, "2026-12-01");
		expect((await ask(ada, { intent: "archive", scheduleId: long })).status).toBe(409);
		await seedAssignment(acme.id, { kind: "role", id: "finance" }, null, "2026-12-01");
		expect((await ask(ada, { intent: "archive", scheduleId: long })).status).toBe(200);
		const assign = await ask(ada, {
			intent: "assign",
			targetKind: "person",
			targetId: ada.user.id,
			scheduleId: long,
			from: MONDAY,
		});
		expect(assign.status).toBe(409);
		expect(assign.said).toContain("That schedule is archived.");
		expect((await ask(ada, { intent: "restore", scheduleId: long })).status).toBe(200);
		expect(await recorded("work_schedule.archived")).toBe(1);
		expect(await recorded("work_schedule.restored")).toBe(1);
	});

	it("assigns to a person, a team, a role and the organisation, each from a day, each recorded", async () => {
		const ada = roles.people.owner;
		const linus = roles.people.member;
		const long = await scheduleNamed(acme.id, "Long");
		const design = await value<string>("select id from teams where organisation_id = ?", acme.id);
		for (const [targetKind, targetId] of [
			["person", linus.user.id],
			["team", design ?? ""],
			["role", "manager"],
			["organisation", ""],
		] as const) {
			const answer = await ask(ada, {
				intent: "assign",
				targetKind,
				targetId,
				scheduleId: long,
				from: "2026-11-16",
			});
			expect(answer.status, targetKind).toBe(200);
		}
		expect(await recorded("work_schedule.assigned")).toBe(4);
		expect(
			await value(
				"select owner_id from activity_records where action = 'work_schedule.assigned' and owner_id is not null",
			),
		).toBe(linus.user.id);
		expect(
			(
				await ask(ada, {
					intent: "assign",
					targetKind: "person",
					targetId: linus.user.id,
					scheduleId: long,
					from: "2026-11-01",
				})
			).status,
		).toBe(409);
		expect(
			(
				await ask(ada, {
					intent: "assign",
					targetKind: "organisation",
					targetId: "",
					scheduleId: "",
					from: MONDAY,
				})
			).status,
		).toBe(404);
		expect(
			(
				await ask(ada, {
					intent: "assign",
					targetKind: "role",
					targetId: "pilot",
					scheduleId: long,
					from: MONDAY,
				})
			).status,
		).toBe(404);
		// This week is as it was; from the 16th Linus works Long.
		expect(await text("/app/acme?view=week&start=2026-11-09", linus)).toContain(
			"Week expected 37:30",
		);
		expect(await text("/app/acme?view=week&start=2026-11-16", linus)).toContain(
			"Week expected 40:00",
		);
		const account = await text("/app/acme/account", linus);
		expect(account).toContain(
			"From Monday 16 November 2026: Long, Monday to Friday, 09:00–18:00 · 40:00 a week.",
		);
		// Taking his own away from the 23rd leaves his team's.
		await ask(ada, {
			intent: "assign",
			targetKind: "person",
			targetId: linus.user.id,
			scheduleId: "",
			from: "2026-11-23",
		});
		const later = await text("/app/acme?view=week&start=2026-11-23", linus);
		expect(later).toContain("Week expected 40:00");
	});
});

describe("what reads a person's schedule", () => {
	/** Linus, a member of Design, works Short through the team: Monday to Wednesday, 09:00–14:00. */
	beforeEach(async () => {
		const short = await seedSchedule(acme.id, "Short", SHORT_WEEK);
		const design =
			(await value<string>("select id from teams where organisation_id = ?", acme.id)) ?? "";
		await seedAssignment(acme.id, { kind: "team", id: design }, short);
	});

	it("Timesheet: the day's hours and limit, the week's expected time, and the calendar's band and days off", async () => {
		const linus = roles.people.member;
		expect(await text("/app/acme?day=2026-11-09", linus)).toContain("09:00–14:00, 5:00 expected.");
		expect(await text("/app/acme?day=2026-11-12", linus)).toContain(
			"Not a working day. 0:00 expected.",
		);
		const week = await text("/app/acme?view=week&start=2026-11-09", linus);
		expect(week).toContain("Expected 5:00 5:00 5:00 0:00 0:00 0:00 0:00 Week expected 15:00");
		const calendar = await pageBody(await open("/app/acme?view=calendar&date=2026-11-09", linus));
		expect(calendar.match(/data-working-hours="09:00–14:00"/g)?.length).toBe(3);
		expect(textOf(calendar)).toContain("Not a working day");
		// The owner, on Standard, is as before.
		expect(await text("/app/acme?day=2026-11-12", roles.people.owner)).toContain(
			"09:00–17:30, 7:30 expected.",
		);
	});

	it("Timesheet: the day's ceiling is the schedule's, and its own overtime rule applies", async () => {
		const linus = roles.people.member;
		const site = await seedProject(acme.id, "Site");
		const track = (hours: string, overtime = false) =>
			submit(
				"/app/acme?index",
				{
					intent: "track",
					projectId: site,
					day: MONDAY,
					hours,
					...(overtime ? { overtime: "on" } : {}),
				},
				linus,
				{ byScript: true },
			);
		expect((await track("6")).status).toBe(409);
		expect((await track("5")).status).toBe(200);
		// The organisation allows no overtime; Short is given its own rule.
		expect((await track("1", true)).status).toBe(409);
		const short = await scheduleNamed(acme.id, "Short");
		await seedVersion(acme.id, short, SHORT_WEEK, MONDAY, { overtime: "allowed", dayCap: 60 });
		expect((await track("1", true)).status).toBe(200);
		expect((await track("0:30", true)).status).toBe(409);
	});

	it("Team: the manager sees the schedule, why, and the time expected", async () => {
		const team = await text("/app/acme/team", roles.people.manager);
		expect(team).toMatch(
			/linus@example\.com .*Short, Monday to Wednesday, 09:00–14:00 · 15:00 a week\. From the team Design\. .*15:00 expected/,
		);
		const one = await text(
			`/app/acme/team?person=${roles.people.member.user.id}`,
			roles.people.manager,
		);
		expect(one).toContain(
			"Work schedule: Short, Monday to Wednesday, 09:00–14:00 · 15:00 a week. From the team Design.",
		);
		const members = await text("/app/acme/team/members", roles.people.admin);
		expect(members).toContain(
			"Short, Monday to Wednesday, 09:00–14:00 · 15:00 a week. From the team Design.",
		);
		expect(await text("/app/acme/team/members", roles.people.manager)).not.toContain(
			"From the team Design.",
		);
	});

	it("Reports, Utilisation and Dashboards count the schedule's hours", async () => {
		const ada = roles.people.owner;
		const linus = roles.people.member;
		const week = "from=2026-11-09&to=2026-11-15";
		const people = await text(`/app/acme/reports?${week}`, ada);
		expect(people).toMatch(/linus@example\.com 15:00 expected/);
		const site = await seedProject(acme.id, "Site");
		await seedEntry(acme.id, linus.user.id, site, "2026-11-09T09:00:00Z", "2026-11-09T12:00:00Z");
		const utilisation = await text(
			`/app/acme/reports/utilisation?${week}&person=${linus.user.id}`,
			ada,
		);
		expect(utilisation).toContain("3:00 of 15:00 capacity");
		const before = (await text("/app/acme/dashboards", ada)).match(/of (\S+) expected/)?.[1];
		await seedAssignment(
			acme.id,
			{ kind: "person", id: linus.user.id },
			await scheduleNamed(acme.id, "Long"),
		);
		const after = (await text("/app/acme/dashboards", ada)).match(/of (\S+) expected/)?.[1];
		expect(before).not.toBe(after);
	});

	it("Approvals: nobody is chased for a week their schedule does not work", async () => {
		const ada = roles.people.owner;
		const linus = roles.people.member;
		await env.DB.prepare("update memberships set created_at = ?")
			.bind(Date.UTC(2025, 0, 1))
			.run();
		const weekendOnly = await seedSchedule(
			acme.id,
			"Weekends",
			weekOfMinutes([0, 0, 0, 0, 0, 450, 450]),
		);
		await seedAssignment(acme.id, { kind: "person", id: linus.user.id }, weekendOnly, "2026-11-02");
		// 26 Oct to 1 Nov he worked Short; 2 to 8 Nov, he was expected on the weekend.
		const shortWeek = await text("/app/acme/approvals?week=2026-10-26", ada);
		expect(shortWeek.slice(shortWeek.indexOf("Not submitted"))).toContain("linus@example.com");
		await seedAssignment(acme.id, { kind: "person", id: linus.user.id }, null, "2026-11-02");
		const none = await seedSchedule(acme.id, "Mondays", weekOfMinutes([450, 0, 0, 0, 0, 0, 0]));
		await seedAssignment(acme.id, { kind: "person", id: linus.user.id }, none, "2026-11-02");
		await seedLeave(acme.id, linus.user.id, "annual", "2026-11-02", "2026-11-02");
		const offWeek = await text("/app/acme/approvals?week=2026-11-02", ada);
		expect(offWeek.slice(offWeek.indexOf("Not submitted"))).not.toContain("linus@example.com");
	});

	it("Time off: leave is counted in the days the schedule works", async () => {
		const linus = roles.people.member;
		await seedLeave(acme.id, linus.user.id, "annual", "2026-11-16", "2026-11-22");
		const page = await text("/app/acme/time-off", linus);
		expect(page).toMatch(/16–22 November 2026 .*3 days/);
		expect(page).toMatch(/Annual leave .*3 days/);
	});

	it("the API: each day's schedule, hours and expected time", async () => {
		const linus = roles.people.member;
		const token = await makeToken(organisationScope(env.DB, acme.id), linus.user.id, "Test", [
			"time:read",
		]);
		const response = await exports.default.fetch(
			new Request(`${ORIGIN}/api/v1/work_days?from=2026-11-09&to=2026-11-12`, {
				headers: { Authorization: `Bearer ${token}` },
			}),
		);
		expect(response.status).toBe(200);
		const { data } = (await response.json()) as { data: Record<string, unknown>[] };
		expect(data[0]).toMatchObject({
			user_id: linus.user.id,
			date: MONDAY,
			schedule: { name: "Short" },
			kind: "working",
			start: "09:00",
			finish: "14:00",
			break_minutes: 0,
			scheduled_minutes: 300,
			expected_minutes: 300,
		});
		expect(data[3]).toMatchObject({
			date: "2026-11-12",
			kind: "not-a-working-day",
			start: null,
			expected_minutes: 0,
		});
		// Somebody whose time they may not see is not listed.
		const other = await exports.default.fetch(
			new Request(
				`${ORIGIN}/api/v1/work_days?from=2026-11-09&to=2026-11-12&user_id=${roles.people.owner.user.id}`,
				{
					headers: { Authorization: `Bearer ${token}` },
				},
			),
		);
		expect(((await other.json()) as { data: unknown[] }).data).toEqual([]);
	});

	it("the CSV import holds each row to the schedule's day", async () => {
		const ada = roles.people.owner;
		await seedAssignment(
			acme.id,
			{ kind: "person", id: ada.user.id },
			await scheduleNamed(acme.id, "Short"),
		);
		await env.DB.prepare("update users set name = 'Ada Lovelace' where id = ?")
			.bind(ada.user.id)
			.run();
		const csv = [
			"Date,Project,Task,Notes,Hours,First Name,Last Name",
			"2026-11-02,Website,Design,Monday,5,Ada,Lovelace",
			"2026-11-03,Website,Design,Tuesday,6,Ada,Lovelace",
			"2026-11-05,Website,Design,Thursday,1,Ada,Lovelace",
		].join("\n");
		const body = new FormData();
		body.set("intent", "upload");
		body.set("kind", "time");
		body.set("file", new File([csv], "harvest.csv", { type: "text/csv" }));
		const uploaded = await exports.default.fetch(
			new Request(`${ORIGIN}/app/acme/integrations/import?kind=time`, {
				method: "POST",
				headers: { Origin: ORIGIN, Cookie: ada.cookie, "CF-Connecting-IP": ada.client },
				body,
				redirect: "manual",
			}),
		);
		const preview = await text(uploaded.headers.get("Location") ?? "", ada);
		expect(preview).toContain("1 to import, 2 to skip.");
		expect(preview).toContain("Thursday is not a working day");
	});

	it("a calendar feed counts leave on the schedule's days and hours", async () => {
		const linus = roles.people.member;
		await seedLeave(acme.id, linus.user.id, "annual", "2026-11-16", "2026-11-22");
		const made = await exports.default.fetch(
			new Request(`${ORIGIN}/app/acme/account/calendar.data`, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Origin: ORIGIN,
					Cookie: linus.cookie,
					"CF-Connecting-IP": linus.client,
				},
				body: new URLSearchParams({ intent: "feed-create", follow: "me" }),
			}),
		);
		const address = (await made.text()).match(
			/https:\/\/[^"\s\\]+\/calendar\/cal_[A-Za-z0-9_-]{43}\.ics/,
		)?.[0];
		expect(address).toBeTruthy();
		const ics = await (await exports.default.fetch(new Request(address ?? ""))).text();
		expect(ics).toContain("DESCRIPTION:Takes 3 days\\, 15:00 of scheduled hours.");
	});

	it("My account shows the person's schedule, read only, and why", async () => {
		const page = await text("/app/acme/account", roles.people.member);
		expect(page).toContain(
			"Short: Monday to Wednesday, 09:00–14:00 · 15:00 a week. From the team Design.",
		);
		expect(page).toMatch(/Monday 09:00–14:00 · 5:00 .*Thursday Not a working day/);
		expect(page).not.toContain("Change schedule");
	});

	it("of two teams, the one whose schedule has more weekly hours, shown on the person's row and My account", async () => {
		const linus = roles.people.member;
		const build = await value<string>("select id from teams where organisation_id = ?", acme.id);
		await env.DB.prepare(
			"insert into teams (id, organisation_id, name, name_key, created_at, updated_at) values ('team-build', ?, 'Build', 'build', 0, 0)",
		)
			.bind(acme.id)
			.run();
		await env.DB.prepare(
			"insert into team_members (id, organisation_id, team_id, user_id, is_manager, created_at, updated_at) values ('tm-build', ?, 'team-build', ?, 0, 0, 0)",
		)
			.bind(acme.id, linus.user.id)
			.run();
		await seedAssignment(
			acme.id,
			{ kind: "team", id: "team-build" },
			await scheduleNamed(acme.id, "Long"),
		);
		expect(build).toBeTruthy();
		const account = await text("/app/acme/account", linus);
		expect(account).toContain(
			"Long: Monday to Friday, 09:00–18:00 · 40:00 a week. From the team Build: of their teams with a schedule, it has the most weekly hours (also Design (Short)).",
		);
		expect(await text(PAGE, roles.people.owner)).toContain(
			"From the team Build: of their teams with a schedule, it has the most weekly hours (also Design (Short)).",
		);
	});
});

describe("roles see their own", () => {
	it.each(KINDS)("the %s sees their own schedule on My account", async (kind) => {
		const page = await text("/app/acme/account", roles.people[kind]);
		expect(page).toContain("Your work schedule");
		expect(page).toContain("Standard: Monday to Friday, 09:00–17:30 · 37:30 a week.");
	});

	it("weeks hold the Standard and Long hours the owner asked for", () => {
		expect(STANDARD_WEEK.slice(0, 5).every((d) => d?.start === 540 && d.finish === 1050)).toBe(
			true,
		);
		expect(LONG_WEEK.slice(0, 5).every((d) => d?.start === 540 && d.finish === 1080)).toBe(true);
	});
});
