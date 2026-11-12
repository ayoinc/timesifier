import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "~/db";
import type { NonWorkingRule, OvertimeRule } from "~/leave/rules";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, type Role, seedMembership, value } from "../organisations/harness";
import { type Person, person, submit } from "./harness";
import { seedHoliday, seedLeave } from "./leave-seed";
import { seedEntry, seedProject } from "./periods-seed";

// The Timesheet's action and the limits of a day (TS-090, TS-095): no time
// on a public holiday or a day of whole-day leave, a day's expected hours as
// its ceiling for regular time, overtime entered as such only as the
// organisation's rule, its caps and approved work allow, a week over its
// limits refused at submission, and a timer stopped past the limit cut there
// or kept but flagged. Every request goes through the Worker, as the page's
// own forms make it, on every write path (track, a slot of the calendar, a
// cell of the grid, an edit, the timer), for an owner, an admin and a member
// alike: each acts on their own time.

/** Where the page's forms post: the index route, not the organisation's layout at the same address. */
const ACTION = "/app/acme?index";
const LONDON = "Europe/London";
const HOUR = 3_600_000;
/** A Wednesday, 10:00 in London: the server's clock for every test here. */
const T0 = Date.parse("2026-11-11T10:00:00Z");

// The week of T0, Monday 9 to Sunday 15 November 2026, worked Monday to
// Friday, 7:30 a day.
const MONDAY = "2026-11-09";
const TUESDAY = "2026-11-10";
const WEDNESDAY = "2026-11-11";
const THURSDAY = "2026-11-12";
const FRIDAY = "2026-11-13";
/** The Saturday before T0's week: a day already gone. */
const SATURDAY = "2026-11-07";

const ON_LEAVE = "You are on annual leave that day: no time can be tracked on it.";
const ON_HOLIDAY = "Company Day is a public holiday: no time can be tracked on it.";

let mailbox: Mailbox;
let acme: { id: string };
let site: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Acme, owned by Ada, with Grace a member, both in London, and the person of
 * `role` returned. Signing in reads the real clock, so the server's is fixed
 * at T0 only after.
 */
async function acmeWith(role: Role): Promise<Person> {
	const ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	const grace = await person(mailbox, "grace@example.com");
	await seedMembership(acme.id, grace.user.id, role === "owner" ? "member" : role);
	for (const who of [ada, grace]) await setZone(who, LONDON);
	site = await seedProject(acme.id, "Site");
	clockAt(T0);
	return role === "owner" ? ada : grace;
}

function setZone(who: Person, zone: string) {
	return env.DB.prepare("update users set time_zone = ? where id = ?")
		.bind(zone, who.user.id)
		.run();
}

/** The server's clock, fixed at `at` for what follows. */
function clockAt(at: number) {
	vi.spyOn(Date, "now").mockReturnValue(at);
}

/** Posts one of the page's forms by script, and returns the status and what it said. */
async function ask(who: Person, fields: Record<string, string>) {
	const response = await submit(ACTION, fields, who, { byScript: true });
	return { status: response.status, said: await response.text() };
}

/** "Track time" with `hours` on `day`, at `start` where a slot of the calendar was chosen. */
function trackHours(day: string, hours: string, start?: string) {
	return {
		intent: "track",
		projectId: site,
		day,
		hours,
		...(start === undefined ? {} : { start }),
	};
}

/** The same, as overtime (TS-095). */
const overtimeHours = (day: string, hours: string, start?: string) => ({
	...trackHours(day, hours, start),
	overtime: "on",
});

/** A cell of the week's grid, of regular time or of overtime. */
const cell = (day: string, hours: string, overtime = false) => ({
	intent: "cell",
	projectId: site,
	day,
	hours,
	...(overtime ? { overtime: "true" } : {}),
});

/** The instant of `clock` on `day` in London, where November is GMT. */
const at = (day: string, clock: string) => Date.parse(`${day}T${clock}:00Z`);

/** The organisation's rules for overtime and weekend work, set as Workspace settings would. */
function setRules({
	overtime,
	weekend,
	dayCap = null,
	weekCap = null,
}: {
	overtime?: OvertimeRule;
	weekend?: NonWorkingRule;
	dayCap?: number | null;
	weekCap?: number | null;
}) {
	return env.DB.prepare(
		"update organisations set overtime_policy = coalesce(?, overtime_policy), non_working_days = coalesce(?, non_working_days), overtime_day_cap_minutes = ?, overtime_week_cap_minutes = ? where id = ?",
	)
		.bind(overtime ?? null, weekend ?? null, dayCap, weekCap, acme.id)
		.run();
}

/** A request of `who` for overtime or weekend work, already decided. */
async function seedWork(
	who: Person,
	kind: "overtime" | "weekend",
	startsOn: string,
	endsOn: string,
	minutesPerDay: number,
	status: "approved" | "pending" | "refused" = "approved",
) {
	await env.DB.prepare(
		"insert into work_requests (id, organisation_id, user_id, kind, starts_on, ends_on, minutes_per_day, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)",
	)
		.bind(uuidv7(), acme.id, who.user.id, kind, startsOn, endsOn, minutesPerDay, status)
		.run();
}

/** The minutes `who` has tracked on `day` in London: all of them, or of one kind. */
async function minutesOn(who: Person, day: string, kind?: "regular" | "overtime") {
	const from = at(day, "00:00");
	const total = await value<number>(
		`select coalesce(sum(ended_at - started_at), 0) from time_entries where user_id = ? and started_at >= ? and started_at < ?${kind === undefined ? "" : ` and overtime = ${kind === "overtime" ? 1 : 0}`}`,
		who.user.id,
		from,
		from + 24 * HOUR,
	);
	return (total ?? 0) / 60_000;
}

/** The entries of `who`, oldest first: start, end and kind. */
async function entriesOf(who: Person) {
	const { results } = await env.DB.prepare(
		"select started_at, ended_at, overtime from time_entries where user_id = ? order by started_at",
	)
		.bind(who.user.id)
		.all<{ started_at: number; ended_at: number | null; overtime: number }>();
	return results.map((row) => ({
		from: row.started_at,
		to: row.ended_at,
		overtime: row.overtime === 1,
	}));
}

const countEntries = () => value<number>("select count(*) from time_entries");
const periodStatus = () => value<string>("select status from periods");

describe.each(["owner", "admin", "member"] as const)("for an %s's own time", (role) => {
	let me: Person;

	beforeEach(async () => {
		me = await acmeWith(role);
	});

	describe("a public holiday or a day of whole-day leave", () => {
		beforeEach(async () => {
			await seedHoliday(acme.id, FRIDAY, "Company Day");
			await seedLeave(acme.id, me.user.id, "annual", THURSDAY, THURSDAY);
		});

		it("takes no hours tracked, typed into the week, or placed on a slot of the calendar", async () => {
			for (const [day, reason] of [
				[FRIDAY, ON_HOLIDAY],
				[THURSDAY, ON_LEAVE],
			] as const) {
				for (const fields of [
					trackHours(day, "1"),
					trackHours(day, "1", "09:00"),
					{ intent: "cell", projectId: site, day, hours: "0:15" },
				]) {
					const refused = await ask(me, fields);
					expect(refused.status, `${fields.intent} on ${day}`).toBe(409);
					expect(refused.said).toContain(reason);
				}
			}
			expect(await countEntries()).toBe(0);
			// The days around them take time as before.
			expect((await ask(me, trackHours(WEDNESDAY, "1"))).status).toBe(200);
		});

		it("takes no entry moved onto it, and lets one be moved off it", async () => {
			const entry = await seedEntry(
				acme.id,
				me.user.id,
				site,
				at(WEDNESDAY, "09:00"),
				at(WEDNESDAY, "10:00"),
			);
			const edit = (date: string) => ({
				intent: "edit",
				entryId: entry,
				projectId: site,
				date,
				start: "09:00",
				end: "10:00",
			});
			const refused = await ask(me, edit(THURSDAY));
			expect(refused.status).toBe(409);
			expect(refused.said).toContain(ON_LEAVE);
			expect(await minutesOn(me, WEDNESDAY)).toBe(60);

			// Time already on a closed day, from before the leave, can be taken off it.
			const before = await seedEntry(
				acme.id,
				me.user.id,
				site,
				at(THURSDAY, "09:00"),
				at(THURSDAY, "11:00"),
			);
			expect(
				(
					await ask(me, {
						intent: "edit",
						entryId: before,
						projectId: site,
						date: THURSDAY,
						start: "09:00",
						end: "10:00",
					})
				).status,
			).toBe(200);
			expect(
				(
					await ask(me, {
						intent: "edit",
						entryId: before,
						projectId: site,
						date: WEDNESDAY,
						start: "11:00",
						end: "12:00",
					})
				).status,
			).toBe(200);
			expect(await minutesOn(me, THURSDAY)).toBe(0);
		});

		it("starts no timer when it is today, in the person's own zone", async () => {
			clockAt(at(THURSDAY, "09:00"));
			const refused = await ask(me, { intent: "track", projectId: site, day: THURSDAY });
			expect(refused.status).toBe(409);
			expect(refused.said).toContain(ON_LEAVE);
			expect(await countEntries()).toBe(0);
		});
	});

	it("reads today in the person's zone: leave on Auckland's Thursday refuses a timer while London's is Wednesday", async () => {
		await setZone(me, "Pacific/Auckland");
		await seedLeave(acme.id, me.user.id, "annual", THURSDAY, THURSDAY);
		// 12:00 in London on Wednesday is 01:00 on Thursday in Auckland.
		clockAt(at(WEDNESDAY, "12:00"));
		const refused = await ask(me, { intent: "track", projectId: site, day: THURSDAY });
		expect(refused.status).toBe(409);
		expect(refused.said).toContain(ON_LEAVE);

		// Back in London it is Wednesday, a working day.
		await setZone(me, LONDON);
		const started = await ask(me, { intent: "track", projectId: site, day: WEDNESDAY });
		expect(started.status).toBe(200);
		expect(started.said).toContain("Timer started.");
	});

	describe("a day of half-day leave", () => {
		beforeEach(async () => {
			await seedLeave(acme.id, me.user.id, "annual", TUESDAY, TUESDAY, { startsHalf: true });
		});

		it("takes 3:45 tracked, and not a minute more", async () => {
			expect((await ask(me, trackHours(TUESDAY, "3:45"))).status).toBe(200);
			const refused = await ask(me, trackHours(TUESDAY, "0:01"));
			expect(refused.status).toBe(409);
			expect(refused.said).toContain("This day has 0:00 left.");
			expect(await minutesOn(me, TUESDAY)).toBe(225);
		});

		it("refuses a cell typed past what is left, saying what is", async () => {
			const refused = await ask(me, { intent: "cell", projectId: site, day: TUESDAY, hours: "4" });
			expect(refused.status).toBe(409);
			expect(refused.said).toContain("This day has 3:45 left.");
			expect(await countEntries()).toBe(0);

			expect(
				(await ask(me, { intent: "cell", projectId: site, day: TUESDAY, hours: "3:45" })).status,
			).toBe(200);
			// The cell's own time is not counted twice: lowering it is fine.
			expect(
				(await ask(me, { intent: "cell", projectId: site, day: TUESDAY, hours: "3" })).status,
			).toBe(200);
			expect(await minutesOn(me, TUESDAY)).toBe(180);
		});

		it("refuses an edit that lengthens an entry past the limit, and allows one that shortens an entry of a day over", async () => {
			const entry = await seedEntry(
				acme.id,
				me.user.id,
				site,
				at(TUESDAY, "09:00"),
				at(TUESDAY, "12:00"),
			);
			const edit = (id: string, start: string, end: string) => ({
				intent: "edit",
				entryId: id,
				projectId: site,
				date: TUESDAY,
				start,
				end,
			});
			const refused = await ask(me, edit(entry, "09:00", "13:00"));
			expect(refused.status).toBe(409);
			expect(refused.said).toContain("This day has 3:45 left.");
			expect(await minutesOn(me, TUESDAY)).toBe(180);
			expect((await ask(me, edit(entry, "09:00", "12:45"))).status).toBe(200);

			// Time tracked before the leave: the day is over by 2:00.
			const later = await seedEntry(
				acme.id,
				me.user.id,
				site,
				at(TUESDAY, "13:00"),
				at(TUESDAY, "15:00"),
			);
			expect(await minutesOn(me, TUESDAY)).toBe(345);
			expect((await ask(me, edit(later, "13:00", "14:00"))).status).toBe(200);
			const longer = await ask(me, edit(later, "13:00", "14:30"));
			expect(longer.status).toBe(409);
			expect(longer.said).toContain("This day has 0:00 left.");
			expect(await minutesOn(me, TUESDAY)).toBe(285);
		});

		it("takes overtime beyond its half only as the rule allows", async () => {
			expect((await ask(me, trackHours(TUESDAY, "3:45"))).status).toBe(200);
			const none = await ask(me, overtimeHours(TUESDAY, "1"));
			expect(none.status).toBe(409);
			expect(none.said).toContain("This organisation does not allow overtime.");

			await setRules({ overtime: "approval" });
			await seedWork(me, "overtime", TUESDAY, TUESDAY, 60);
			await seedWork(me, "overtime", TUESDAY, TUESDAY, 120, "pending");
			expect((await ask(me, overtimeHours(TUESDAY, "1"))).status).toBe(200);
			const refused = await ask(me, overtimeHours(TUESDAY, "0:01"));
			expect(refused.status).toBe(409);
			expect(refused.said).toContain("This day has 0:00 of overtime left.");
			expect(await minutesOn(me, TUESDAY, "regular")).toBe(225);
			expect(await minutesOn(me, TUESDAY, "overtime")).toBe(60);
		});
	});

	describe("a working day, overtime not allowed (every organisation's default)", () => {
		it("takes its 7:30 tracked, typed or placed, and refuses a minute more with what is left", async () => {
			expect((await ask(me, trackHours(TUESDAY, "7"))).status).toBe(200);
			for (const fields of [trackHours(TUESDAY, "0:31"), trackHours(TUESDAY, "0:31", "18:00")]) {
				const refused = await ask(me, fields);
				expect(refused.status, fields.intent).toBe(409);
				expect(refused.said).toContain("This day has 0:30 left.");
			}
			// The cell holds the 7:00 it replaces: the whole day is left to it.
			const typed = await ask(me, cell(TUESDAY, "7:31"));
			expect(typed.status).toBe(409);
			expect(typed.said).toContain("This day has 7:30 left.");
			expect((await ask(me, trackHours(TUESDAY, "0:30", "18:00"))).status).toBe(200);
			const full = await ask(me, trackHours(TUESDAY, "0:01"));
			expect(full.said).toContain("This day has 0:00 left.");
			expect(full.said).not.toContain("overtime");
			expect(await minutesOn(me, TUESDAY)).toBe(450);
		});

		it("refuses overtime on every path: track, a slot, a cell, an edit", async () => {
			const entry = await seedEntry(
				acme.id,
				me.user.id,
				site,
				at(MONDAY, "09:00"),
				at(MONDAY, "10:00"),
			);
			for (const fields of [
				overtimeHours(MONDAY, "1"),
				overtimeHours(MONDAY, "1", "19:00"),
				cell(MONDAY, "1", true),
				{
					intent: "edit",
					entryId: entry,
					projectId: site,
					date: MONDAY,
					start: "09:00",
					end: "10:00",
					overtime: "true",
				},
			]) {
				const refused = await ask(me, fields);
				expect(refused.status, fields.intent).toBe(409);
				expect(refused.said).toContain("This organisation does not allow overtime.");
			}
			expect(await minutesOn(me, MONDAY, "overtime")).toBe(0);
		});

		it("starts no timer on a day already full", async () => {
			await seedEntry(acme.id, me.user.id, site, at(WEDNESDAY, "00:30"), at(WEDNESDAY, "08:00"));
			const refused = await ask(me, { intent: "track", projectId: site, day: WEDNESDAY });
			expect(refused.status).toBe(409);
			expect(refused.said).toContain("This day has 0:00 left.");
			expect(await countEntries()).toBe(1);
		});
	});

	describe("overtime allowed", () => {
		beforeEach(async () => {
			await setRules({ overtime: "allowed" });
		});

		it("is entered as overtime once the expected hours are used, on every path", async () => {
			expect((await ask(me, trackHours(TUESDAY, "7:30"))).status).toBe(200);
			const regular = await ask(me, trackHours(TUESDAY, "0:01"));
			expect(regular.status).toBe(409);
			expect(regular.said).toContain("This day has 0:00 left. Track more as overtime.");

			expect((await ask(me, overtimeHours(TUESDAY, "1"))).status).toBe(200);
			expect((await ask(me, overtimeHours(TUESDAY, "0:30", "20:00"))).status).toBe(200);
			expect((await ask(me, cell(TUESDAY, "2", true))).status).toBe(409);
			expect(await minutesOn(me, TUESDAY, "regular")).toBe(450);
			expect(await minutesOn(me, TUESDAY, "overtime")).toBe(90);

			// A cell is one project's time of one kind: Thursday's overtime cell is apart from its regular one.
			expect((await ask(me, cell(MONDAY, "7:30"))).status).toBe(200);
			expect((await ask(me, cell(MONDAY, "2", true))).status).toBe(200);
			expect((await ask(me, cell(MONDAY, "1", true))).status).toBe(200);
			expect(await minutesOn(me, MONDAY, "regular")).toBe(450);
			expect(await minutesOn(me, MONDAY, "overtime")).toBe(60);
		});

		it("moves an entry between regular time and overtime by an edit, each held to its own limit", async () => {
			await seedEntry(acme.id, me.user.id, site, at(MONDAY, "08:00"), at(MONDAY, "15:00"));
			const late = await seedEntry(
				acme.id,
				me.user.id,
				site,
				at(MONDAY, "16:00"),
				at(MONDAY, "17:00"),
			);
			const edit = (overtime: string) => ({
				intent: "edit",
				entryId: late,
				projectId: site,
				date: MONDAY,
				start: "16:00",
				end: "17:00",
				overtime,
			});
			expect((await ask(me, edit("true"))).status).toBe(200);
			expect(await minutesOn(me, MONDAY, "overtime")).toBe(60);
			const back = await ask(me, edit("false"));
			expect(back.status).toBe(409);
			expect(back.said).toContain("This day has 0:30 left. Track more as overtime.");
		});

		it("is held by the day's cap and the week's", async () => {
			await setRules({ overtime: "allowed", dayCap: 120, weekCap: 180 });
			await seedEntry(acme.id, me.user.id, site, at(MONDAY, "08:00"), at(MONDAY, "15:30"));
			await seedEntry(acme.id, me.user.id, site, at(TUESDAY, "08:00"), at(TUESDAY, "15:30"));
			expect((await ask(me, overtimeHours(MONDAY, "2"))).status).toBe(200);
			const day = await ask(me, overtimeHours(MONDAY, "0:01"));
			expect(day.status).toBe(409);
			expect(day.said).toContain("This day has 0:00 of overtime left.");
			const week = await ask(me, overtimeHours(TUESDAY, "1:01"));
			expect(week.status).toBe(409);
			expect(week.said).toContain("This week has 1:00 of overtime left.");
			expect((await ask(me, overtimeHours(TUESDAY, "1"))).status).toBe(200);
		});

		it("starts a timer as overtime on a day already full", async () => {
			await seedEntry(acme.id, me.user.id, site, at(WEDNESDAY, "00:30"), at(WEDNESDAY, "08:00"));
			const started = await ask(me, { intent: "track", projectId: site, day: WEDNESDAY });
			expect(started.status).toBe(200);
			const [, running] = await entriesOf(me);
			expect(running).toEqual({ from: T0, to: null, overtime: true });
		});
	});

	describe("overtime with pre-approval", () => {
		beforeEach(async () => {
			await setRules({ overtime: "approval" });
		});

		it("caps a working day's regular time at its 7:30", async () => {
			expect((await ask(me, trackHours(WEDNESDAY, "7:30"))).status).toBe(200);
			const refused = await ask(me, trackHours(WEDNESDAY, "0:01"));
			expect(refused.status).toBe(409);
			expect(refused.said).toContain(
				"This day has 0:00 left. Overtime on this day needs pre-approval. Request it on Time off.",
			);
			const typed = await ask(me, cell(MONDAY, "8"));
			expect(typed.status).toBe(409);
			expect(typed.said).toContain("This day has 7:30 left.");
		});

		it("takes approved overtime as overtime, and not a request still waiting or refused", async () => {
			await seedWork(me, "overtime", MONDAY, WEDNESDAY, 60);
			await seedWork(me, "overtime", WEDNESDAY, WEDNESDAY, 30);
			await seedWork(me, "overtime", WEDNESDAY, WEDNESDAY, 120, "pending");
			await seedWork(me, "overtime", WEDNESDAY, WEDNESDAY, 120, "refused");
			expect((await ask(me, trackHours(WEDNESDAY, "7:30"))).status).toBe(200);
			expect((await ask(me, overtimeHours(WEDNESDAY, "1:30"))).status).toBe(200);
			const refused = await ask(me, overtimeHours(WEDNESDAY, "0:01"));
			expect(refused.status).toBe(409);
			expect(refused.said).toContain("This day has 0:00 of overtime left.");
			// Thursday has none approved.
			const thursday = await ask(me, overtimeHours(THURSDAY, "0:01"));
			expect(thursday.status).toBe(409);
			expect(thursday.said).toContain("Overtime on this day needs pre-approval.");
		});

		it("starts no timer on a day already full without approved overtime", async () => {
			await seedEntry(acme.id, me.user.id, site, at(WEDNESDAY, "00:30"), at(WEDNESDAY, "08:00"));
			const refused = await ask(me, { intent: "track", projectId: site, day: WEDNESDAY });
			expect(refused.status).toBe(409);
			expect(refused.said).toContain("This day has 0:00 left.");
		});
	});

	describe("weekends and non-working days", () => {
		it("are refused when not allowed, approved work or not", async () => {
			await setRules({ overtime: "allowed", weekend: "none" });
			await seedWork(me, "weekend", SATURDAY, SATURDAY, 120);
			for (const fields of [trackHours(SATURDAY, "1"), overtimeHours(SATURDAY, "1")]) {
				const refused = await ask(me, fields);
				expect(refused.status).toBe(409);
				expect(refused.said).toContain(
					"Saturday is not a working day, and this organisation does not allow time on it.",
				);
			}
			expect(await countEntries()).toBe(0);
		});

		it("count as overtime: refused while overtime is not allowed, the default", async () => {
			const refused = await ask(me, overtimeHours(SATURDAY, "1"));
			expect(refused.status).toBe(409);
			expect(refused.said).toContain("This organisation does not allow overtime.");
			const regular = await ask(me, trackHours(SATURDAY, "1"));
			expect(regular.said).toContain(
				"Saturday is not a working day, and this organisation does not allow overtime.",
			);
		});

		it("count as overtime: taken as overtime, never as regular time, while overtime is allowed", async () => {
			await setRules({ overtime: "allowed" });
			const regular = await ask(me, trackHours(SATURDAY, "1"));
			expect(regular.status).toBe(409);
			expect(regular.said).toContain("Saturday is not a working day: track its time as overtime.");
			expect((await ask(me, overtimeHours(SATURDAY, "10"))).status).toBe(200);
			expect(await minutesOn(me, SATURDAY, "overtime")).toBe(600);
		});

		it("with pre-approval, take up to the approved weekend work as overtime", async () => {
			await setRules({ overtime: "approval" });
			const refused = await ask(me, overtimeHours(SATURDAY, "1"));
			expect(refused.status).toBe(409);
			expect(refused.said).toContain(
				"Saturday is not a working day: time on it needs approved weekend work. Request it on Time off.",
			);

			await seedWork(me, "weekend", SATURDAY, SATURDAY, 120, "pending");
			expect((await ask(me, overtimeHours(SATURDAY, "1"))).status).toBe(409);

			await seedWork(me, "weekend", SATURDAY, SATURDAY, 120);
			expect((await ask(me, overtimeHours(SATURDAY, "2"))).status).toBe(200);
			const more = await ask(me, overtimeHours(SATURDAY, "0:01"));
			expect(more.status).toBe(409);
			expect(more.said).toContain("This day has 0:00 of overtime left.");
			expect(await minutesOn(me, SATURDAY)).toBe(120);
		});
	});

	describe("leave approved after time was tracked", () => {
		it("refuses the week's submission naming the day over, until it is trimmed", async () => {
			const day = await seedEntry(
				acme.id,
				me.user.id,
				site,
				at(MONDAY, "09:00"),
				at(MONDAY, "17:00"),
			);
			await seedLeave(acme.id, me.user.id, "annual", MONDAY, MONDAY, { startsHalf: true });

			const refused = await ask(me, { intent: "submit", startsOn: MONDAY });
			expect(refused.status).toBe(409);
			expect(refused.said).toContain(
				"Correct the days over their limit before you submit the week: Mon 9 over by 4:15.",
			);
			expect(await periodStatus()).toBeNull();

			expect(
				(
					await ask(me, {
						intent: "edit",
						entryId: day,
						projectId: site,
						date: MONDAY,
						start: "09:00",
						end: "12:45",
					})
				).status,
			).toBe(200);
			expect((await ask(me, { intent: "submit", startsOn: MONDAY })).status).toBe(200);
			expect(await periodStatus()).toBe("submitted");
		});

		it("names every day over, a whole day of leave too", async () => {
			await seedEntry(acme.id, me.user.id, site, at(MONDAY, "09:00"), at(MONDAY, "17:00"));
			await seedEntry(acme.id, me.user.id, site, at(TUESDAY, "09:00"), at(TUESDAY, "10:30"));
			await seedLeave(acme.id, me.user.id, "annual", MONDAY, TUESDAY, { startsHalf: true });

			const refused = await ask(me, { intent: "submit", startsOn: MONDAY });
			expect(refused.status).toBe(409);
			expect(refused.said).toContain(
				"Correct the days over their limit before you submit the week: Mon 9 over by 4:15, Tue 10 over by 1:30.",
			);
		});
	});

	it("stops a timer that ran past the limit, keeps the entry whole and says the day is over, where overtime is not allowed", async () => {
		await seedLeave(acme.id, me.user.id, "annual", WEDNESDAY, WEDNESDAY, { startsHalf: true });
		expect((await ask(me, { intent: "track", projectId: site, day: WEDNESDAY })).status).toBe(200);

		clockAt(T0 + 4 * HOUR);
		const stopped = await ask(me, { intent: "stop" });
		expect(stopped.status).toBe(200);
		expect(stopped.said).toContain(
			"Timer stopped. Wed 11 is over by 0:15: trim or move an entry before you submit the week.",
		);
		expect(await entriesOf(me)).toEqual([{ from: T0, to: T0 + 4 * HOUR, overtime: false }]);

		// Within the limit, it says nothing more.
		await env.DB.prepare("delete from time_entries").run();
		clockAt(T0);
		await ask(me, { intent: "track", projectId: site, day: WEDNESDAY });
		clockAt(T0 + HOUR);
		const inTime = await ask(me, { intent: "stop" });
		expect(inTime.status).toBe(200);
		expect(inTime.said).toContain("Timer stopped.");
		expect(inTime.said).not.toContain("over by");
	});

	it("cuts a timer that ran past the limit where overtime is allowed: regular to the limit, overtime after", async () => {
		await setRules({ overtime: "allowed" });
		await seedLeave(acme.id, me.user.id, "annual", WEDNESDAY, WEDNESDAY, { startsHalf: true });
		await ask(me, { intent: "track", projectId: site, day: WEDNESDAY });

		clockAt(T0 + 4 * HOUR);
		const stopped = await ask(me, { intent: "stop" });
		expect(stopped.status).toBe(200);
		expect(stopped.said).toContain(
			"Timer stopped. 0:15 past the day's expected hours is recorded as overtime.",
		);
		expect(stopped.said).not.toContain("over by");
		const cut = T0 + 225 * 60_000;
		expect(await entriesOf(me)).toEqual([
			{ from: T0, to: cut, overtime: false },
			{ from: cut, to: T0 + 4 * HOUR, overtime: true },
		]);
		expect(
			await value<number>(
				"select count(*) from activity_records where action = 'time_entry.split' and actor_id = ?",
				me.user.id,
			),
		).toBe(1);
	});

	it("cuts a timer past the day's cap too, and flags the day over by what is past it", async () => {
		await setRules({ overtime: "allowed", dayCap: 10 });
		await seedEntry(acme.id, me.user.id, site, at(WEDNESDAY, "00:30"), at(WEDNESDAY, "07:30"));
		await ask(me, { intent: "track", projectId: site, day: WEDNESDAY });

		clockAt(T0 + HOUR);
		const stopped = await ask(me, { intent: "stop" });
		expect(stopped.said).toContain(
			"Timer stopped. 0:30 past the day's expected hours is recorded as overtime. Wed 11 is over by 0:20",
		);
		expect(await minutesOn(me, WEDNESDAY, "regular")).toBe(450);
		expect(await minutesOn(me, WEDNESDAY, "overtime")).toBe(30);
	});

	it("a timer started by starting another is cut as it stops", async () => {
		await setRules({ overtime: "allowed" });
		await seedEntry(acme.id, me.user.id, site, at(WEDNESDAY, "02:00"), at(WEDNESDAY, "09:00"));
		clockAt(T0);
		await ask(me, { intent: "track", projectId: site, day: WEDNESDAY });
		// An hour later another starts: the first is regular to 10:30, overtime to 11:00; the next is overtime.
		clockAt(T0 + HOUR);
		expect((await ask(me, { intent: "track", projectId: site, day: WEDNESDAY })).status).toBe(200);
		expect(await entriesOf(me)).toEqual([
			{ from: at(WEDNESDAY, "02:00"), to: at(WEDNESDAY, "09:00"), overtime: false },
			{ from: T0, to: at(WEDNESDAY, "10:30"), overtime: false },
			{ from: at(WEDNESDAY, "10:30"), to: T0 + HOUR, overtime: true },
			{ from: T0 + HOUR, to: null, overtime: true },
		]);
	});
});
