import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { remindableOrganisations, uuidv7 } from "~/db";
import { deadlineReminderAt, runReminders } from "~/notifications/reminders.server";

import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, seedMembership, seedTeam } from "../organisations/harness";
import { type Person, person } from "../pages/harness";
import { seedLeave } from "../pages/leave-seed";
import { seedEntry, seedPeriod } from "../pages/periods-seed";

// The hourly reminders (TS-049, decision 69), each timed where its person is:
// London, Tokyo and Los Angeles, across the end of a week. Acme, in London,
// has a weekly deadline of Monday 10:00, which on Monday 23 November 2026 is
// 10:00 UTC and covers the week of 16 to 22 November. No reminder goes twice
// in its period, and none to a person on leave all of their today.

const HOUR = 60 * 60 * 1000;
/** Monday 23 November 2026, 10:00 in London: the deadline. */
const DEADLINE = Date.parse("2026-11-23T10:00:00Z");
/** The week the deadline covers. */
const WEEK = "2026-11-16";

const ZONES = {
	london: "Europe/London",
	tokyo: "Asia/Tokyo",
	angeles: "America/Los_Angeles",
} as const;

let mailbox: Mailbox;
let acme: { id: string; slug: string };
let ada: Person;
let site: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	await env.DB.prepare(
		"update organisations set time_zone = 'Europe/London', deadline_kind = 'weekly', deadline_day = 1, deadline_time = '10:00' where id = ?",
	)
		.bind(acme.id)
		.run();
	site = uuidv7();
	await env.DB.prepare(
		"insert into projects (id, organisation_id, name, name_key, created_at, updated_at) values (?, ?, 'Site', 'site', 0, 0)",
	)
		.bind(site, acme.id)
		.run();
}, 60_000);

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** A member of Acme since 1 November, in `zone`. */
async function memberIn(email: string, zone: string | null): Promise<Person> {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, "member");
	await env.DB.prepare("update users set time_zone = ? where id = ?").bind(zone, who.user.id).run();
	return who;
}

/** Everyone joined on 1 November, before the week the deadline covers. */
async function joinedEarlier() {
	await env.DB.prepare("update memberships set created_at = ? where organisation_id = ?")
		.bind(Date.parse("2026-11-01T00:00:00Z"), acme.id)
		.run();
}

/** Runs the hourly reminders at each hour from `from` to `to`, the clock standing at each. */
async function runHourly(from: string, to: string) {
	vi.useFakeTimers({ toFake: ["Date"] });
	for (let at = Date.parse(from); at <= Date.parse(to); at += HOUR) {
		vi.setSystemTime(at);
		await runReminders(at);
	}
	vi.useRealTimers();
}

/** Each reminder of `kind`: whom it went to, when it was made, and its words. */
async function reminders(kind: string) {
	const { results } = await env.DB.prepare(
		"select u.email as email, n.created_at as at, n.title as title, n.path as path, n.key as key from notifications n join users u on u.id = n.user_id where n.kind = ? order by n.created_at, u.email",
	)
		.bind(kind)
		.all<{ email: string; at: number; title: string; path: string; key: string }>();
	return results;
}

describe("the deadline's reminder", () => {
	it("is at 09:00 where each person is, at least an hour before the deadline: Los Angeles on Sunday, Tokyo and London on Monday", () => {
		expect(new Date(deadlineReminderAt(DEADLINE, ZONES.london)).toISOString()).toBe(
			"2026-11-23T09:00:00.000Z",
		);
		// The deadline is 19:00 in Tokyo; 09:00 there is midnight in London.
		expect(new Date(deadlineReminderAt(DEADLINE, ZONES.tokyo)).toISOString()).toBe(
			"2026-11-23T00:00:00.000Z",
		);
		// The deadline is 02:00 in Los Angeles: the 09:00 before it is the day before, on Sunday.
		expect(new Date(deadlineReminderAt(DEADLINE, ZONES.angeles)).toISOString()).toBe(
			"2026-11-22T17:00:00.000Z",
		);
	});

	it("goes once to each person with the week unsubmitted, at their hour, and not to one on leave or one who submitted", async () => {
		await memberIn("kenji@example.com", ZONES.tokyo);
		await memberIn("rosa@example.com", ZONES.angeles);
		await memberIn("lena@example.com", ZONES.london);
		const away = await memberIn("otto@example.com", null);
		const done = await memberIn("sue@example.com", ZONES.london);
		await joinedEarlier();
		// Otto, in Acme's London, is on leave all of Monday; Sue submitted her week.
		await seedLeave(acme.id, away.user.id, "annual", "2026-11-23", "2026-11-23");
		await seedPeriod(acme.id, done.user.id, WEEK, "submitted");

		// From Saturday, past the deadline, into the next week.
		await runHourly("2026-11-21T00:00:00Z", "2026-11-24T12:00:00Z");

		const sent = await reminders("deadline-reminder");
		expect(sent.map(({ email, at }) => [email, new Date(at).toISOString()])).toEqual([
			["rosa@example.com", "2026-11-22T17:00:00.000Z"],
			["kenji@example.com", "2026-11-23T00:00:00.000Z"],
			["ada@example.com", "2026-11-23T09:00:00.000Z"],
			["lena@example.com", "2026-11-23T09:00:00.000Z"],
		]);
		expect(sent.every(({ key }) => key === "deadline:2026-11-23")).toBe(true);
		// Each says when it is due where its person is.
		const titleOf = (email: string) => sent.find((s) => s.email === email)?.title;
		expect(titleOf("rosa@example.com")).toBe(
			"Your timesheet for 16–22 November 2026 is due by Monday 23 November at 02:00.",
		);
		expect(titleOf("kenji@example.com")).toBe(
			"Your timesheet for 16–22 November 2026 is due by Monday 23 November at 19:00.",
		);
		expect(titleOf("ada@example.com")).toBe(
			"Your timesheet for 16–22 November 2026 is due by Monday 23 November at 10:00.",
		);
		expect(sent.find((s) => s.email === "rosa@example.com")?.path).toBe(`?view=week&start=${WEEK}`);
	});

	it("is not sent again when the hour comes round again, nor by a second run in the same hour", async () => {
		await joinedEarlier();
		await runHourly("2026-11-23T09:00:00Z", "2026-11-23T09:00:00Z");
		await runHourly("2026-11-23T09:00:00Z", "2026-11-23T09:59:00Z");
		expect(await reminders("deadline-reminder")).toHaveLength(1);
	});

	it("is not sent for a week from before the person joined", async () => {
		// Ada made Acme today: the week before is not hers to submit.
		await runHourly("2026-11-23T09:00:00Z", "2026-11-23T09:00:00Z");
		expect(await reminders("deadline-reminder")).toEqual([]);
	});
});

describe("the reminder of weeks waiting", () => {
	it("goes once a day to the approver, from 09:00 where they are, for weeks submitted before their today", async () => {
		const kenji = await memberIn("kenji@example.com", ZONES.tokyo);
		const rosa = await memberIn("rosa@example.com", ZONES.angeles);
		await seedTeam(acme.id, "Design", { members: [rosa.user.id], managers: [kenji.user.id] });
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.parse("2026-11-20T12:00:00Z"));
		await seedPeriod(acme.id, rosa.user.id, WEEK, "submitted");
		vi.useRealTimers();

		await runHourly("2026-11-20T12:00:00Z", "2026-11-22T23:00:00Z");

		const sent = await reminders("approvals-reminder");
		// Kenji's Saturday and Sunday mornings, 09:00 in Tokyo; Friday's week was submitted that day there.
		expect(sent.map(({ email, at, key }) => [email, new Date(at).toISOString(), key])).toEqual([
			["kenji@example.com", "2026-11-21T00:00:00.000Z", "approvals:2026-11-21"],
			["kenji@example.com", "2026-11-22T00:00:00.000Z", "approvals:2026-11-22"],
		]);
		expect(sent[0]?.title).toBe("1 timesheet has waited for your approval since before today.");
		expect(sent[0]?.path).toBe("/approvals");
	});

	it("skips an approver on leave all of their today, and goes to the owners in their place", async () => {
		const kenji = await memberIn("kenji@example.com", ZONES.tokyo);
		const rosa = await memberIn("rosa@example.com", ZONES.angeles);
		await seedTeam(acme.id, "Design", { members: [rosa.user.id], managers: [kenji.user.id] });
		await seedLeave(acme.id, kenji.user.id, "annual", "2026-11-23", "2026-11-23");
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.parse("2026-11-20T12:00:00Z"));
		await seedPeriod(acme.id, rosa.user.id, WEEK, "submitted");
		vi.useRealTimers();

		// Monday 23 November, from 08:00 to 18:00 in London.
		await runHourly("2026-11-23T08:00:00Z", "2026-11-23T18:00:00Z");

		const sent = await reminders("approvals-reminder");
		expect(sent.map(({ email, at }) => [email, new Date(at).toISOString()])).toEqual([
			["ada@example.com", "2026-11-23T09:00:00.000Z"],
		]);
	});
});

describe("the reminder of a running timer", () => {
	it("goes once, when the timer runs past the regular hours its day takes", async () => {
		await joinedEarlier();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.parse("2026-11-23T08:00:00Z"));
		await seedEntry(acme.id, ada.user.id, site, "2026-11-23T08:00:00Z", null);
		vi.useRealTimers();

		// Monday's 7:30 is past at 15:30; the run at 16:00 sees it, and none after sends again.
		await runHourly("2026-11-23T09:00:00Z", "2026-11-23T22:00:00Z");

		const sent = await reminders("timer-reminder");
		expect(sent.map(({ email, at, key }) => [email, new Date(at).toISOString(), key])).toEqual([
			["ada@example.com", "2026-11-23T16:00:00.000Z", "timer:2026-11-23"],
		]);
		expect(sent[0]?.title).toBe(
			"Your timer is still running on Monday 23 November, past the hours the day takes.",
		);
	});

	it("is not sent to a person on leave all of today", async () => {
		await joinedEarlier();
		await seedLeave(acme.id, ada.user.id, "annual", "2026-11-23", "2026-11-23");
		await seedEntry(acme.id, ada.user.id, site, "2026-11-23T08:00:00Z", null);
		await runHourly("2026-11-23T16:00:00Z", "2026-11-23T20:00:00Z");
		expect(await reminders("timer-reminder")).toEqual([]);
	});
});

describe("the hourly run's reads (decision 69)", () => {
	it("finds organisations with work through the partial indexes, and reads nothing more of an idle one", async () => {
		const sam = await person(mailbox, "sam@example.com");
		const globex = await createOrganisation(sam.cookie, "Globex");
		expect(await remindableOrganisations(env.DB)).toEqual({
			timing: new Set(),
			waiting: new Set(),
		});

		await seedEntry(acme.id, ada.user.id, site, "2026-11-23T08:00:00Z", null);
		await seedPeriod(globex.id, sam.user.id, WEEK, "submitted");
		expect(await remindableOrganisations(env.DB)).toEqual({
			timing: new Set([acme.id]),
			waiting: new Set([globex.id]),
		});
		// Each is read from its partial index, which holds only the rows it returns.
		for (const [sql, index] of [
			[
				"select distinct organisation_id from time_entries where ended_at is null",
				"time_entries_one_running_per_person",
			],
			[
				"select distinct organisation_id from periods where status = 'submitted'",
				"periods_submitted_idx",
			],
			[
				"select distinct organisation_id from period_parts where status = 'submitted'",
				"period_parts_waiting_idx",
			],
		]) {
			const { results } = await env.DB.prepare(`explain query plan ${sql}`).all<{
				detail: string;
			}>();
			expect(results.map(({ detail }) => detail).join(" "), sql).toContain(index);
		}

		// With no timer, no week waiting and no deadline due, a run that starts the hour's pass
		// is five queries, however many organisations there are: it takes the pass, reads the
		// two sets and the organisations, and lets the pass go. Another in that hour is one.
		await env.DB.prepare("delete from time_entries").run();
		await env.DB.prepare("delete from periods").run();
		const prepare = vi.spyOn(env.DB, "prepare");
		expect(await runReminders(Date.parse("2026-11-25T16:00:00Z"))).toEqual({
			outcome: "finished",
			// One more since TS-117: the organisations with a part of a week waiting.
			queries: 6,
		});
		// One more since TS-117: the parts of weeks waiting.
		expect(prepare).toHaveBeenCalledTimes(6);
		expect(await runReminders(Date.parse("2026-11-25T16:01:00Z"))).toEqual({
			outcome: "idle",
			queries: 1,
		});
	});
});
