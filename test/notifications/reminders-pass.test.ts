import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { leaveReminderPass, takeReminderPass, uuidv7 } from "~/db";
import {
	REMINDER_LEASE_MS,
	REMINDER_QUERIES_PER_RUN,
	runReminders,
} from "~/notifications/reminders.server";

import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, seedMembership, seedTeam } from "../organisations/harness";
import { type Person, person } from "../pages/harness";
import { seedEntry, seedPeriod } from "../pages/periods-seed";

// The reminders' share of an invocation's queries, and the pass that runs
// on from one run to the next (TS-049, decision 69). Acme is in London with a
// weekly deadline of Monday 10:00; Monday 23 November 2026 is the day. A
// timer started at 08:00 runs past the day's 7:30 at 15:30.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

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

/** Everyone in Acme joined on 1 November. */
async function joinedEarlier() {
	await env.DB.prepare("update memberships set created_at = ? where organisation_id = ?")
		.bind(Date.parse("2026-11-01T00:00:00Z"), acme.id)
		.run();
}

/** `count` members of Acme, each with a timer running since 08:00 on Monday. */
async function timersRunning(count: number): Promise<string[]> {
	const emails = [];
	for (let n = 0; n < count; n += 1) {
		const email = `timer${n}@example.com`;
		const who = await person(mailbox, email);
		await seedMembership(acme.id, who.user.id, "member");
		await seedEntry(acme.id, who.user.id, site, "2026-11-23T08:00:00Z", null);
		emails.push(email);
	}
	return emails;
}

/** One run at `at`, the clock standing there. */
async function runAt(at: string | number, cap?: number) {
	const now = typeof at === "number" ? at : Date.parse(at);
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(now);
	try {
		return await runReminders(now, cap);
	} finally {
		vi.useRealTimers();
	}
}

/** Each reminder of `kind`: whom it went to, when, and its key. */
async function reminders(kind: string) {
	const { results } = await env.DB.prepare(
		"select u.email as email, n.created_at as at, n.key as key from notifications n join users u on u.id = n.user_id where n.kind = ? order by n.created_at, u.email",
	)
		.bind(kind)
		.all<{ email: string; at: number; key: string }>();
	return results.map(({ email, at, key }) => [email, new Date(at).toISOString(), key]);
}

describe("a run's share of the invocation's queries", () => {
	it("is 400 of the 1,000 one invocation may make", () => {
		expect(REMINDER_QUERIES_PER_RUN).toBe(400);
	});

	it("stops cleanly at its cap; the next runs send the rest, and nobody gets two", async () => {
		await joinedEarlier();
		const emails = await timersRunning(6);
		const cap = 60;

		const first = await runAt("2026-11-23T16:00:00Z", cap);
		expect(first.outcome).toBe("stopped");
		expect(first.queries).toBeLessThanOrEqual(cap);
		const sentFirst = (await reminders("timer-reminder")).length;
		expect(sentFirst).toBeGreaterThan(0);
		expect(sentFirst).toBeLessThan(emails.length);

		// The minutes after go on from where it stopped, each within the cap.
		const runs = [first];
		for (let minute = 1; runs.at(-1)?.outcome === "stopped"; minute += 1) {
			expect(minute).toBeLessThan(10);
			runs.push(await runAt(Date.parse("2026-11-23T16:00:00Z") + minute * MINUTE, cap));
		}
		expect(runs.every(({ queries }) => queries <= cap)).toBe(true);
		expect(runs.at(-1)?.outcome).toBe("finished");
		// The pass is done for the hour; the next hour's checks everyone again and adds nothing.
		expect(await runAt("2026-11-23T16:30:00Z", cap)).toEqual({ outcome: "idle", queries: 1 });
		for (let at = Date.parse("2026-11-23T17:00:00Z"); ; at += MINUTE) {
			if ((await runAt(at, cap)).outcome === "finished") break;
		}

		const sent = await reminders("timer-reminder");
		expect(sent.map(([email]) => email).sort()).toEqual([...emails].sort());
		expect(sent.every(([, , key]) => key === "timer:2026-11-23")).toBe(true);
	});

	it("keeps room for an item: one organisation's own reminders, and each timer, take fewer than 30", async () => {
		const kenji = await person(mailbox, "kenji@example.com");
		await seedMembership(acme.id, kenji.user.id, "member");
		await seedTeam(acme.id, "Design", { members: [kenji.user.id], managers: [ada.user.id] });
		await joinedEarlier();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.parse("2026-11-20T12:00:00Z"));
		await seedPeriod(acme.id, kenji.user.id, "2026-11-09", "submitted");
		vi.useRealTimers();
		await seedEntry(acme.id, ada.user.id, site, "2026-11-23T00:30:00Z", null);

		// At 09:00 on Monday: the deadline's reminder, the week waiting and the timer, past
		// Monday's 7:30 at 08:00. Five queries are the run's own, four read the timers.
		const run = await runAt("2026-11-23T09:00:00Z");
		expect(run.outcome).toBe("finished");
		expect(await reminders("deadline-reminder")).toHaveLength(2);
		expect(await reminders("approvals-reminder")).toHaveLength(1);
		expect(await reminders("timer-reminder")).toHaveLength(1);
		expect(run.queries).toBeLessThan(5 + 30 + 4 + 30);
	});
});

describe("a reminder a run did not reach", () => {
	it("of a timer, past the day's hours at 15:30, is sent at 17:30 when the run at 16:00 had no room", async () => {
		await joinedEarlier();
		await seedEntry(acme.id, ada.user.id, site, "2026-11-23T08:00:00Z", null);

		expect((await runAt("2026-11-23T16:00:00Z", 10)).outcome).toBe("stopped");
		expect(await reminders("timer-reminder")).toEqual([]);

		await runAt("2026-11-23T17:30:00Z");
		for (
			let at = Date.parse("2026-11-23T18:00:00Z");
			at <= Date.parse("2026-11-23T23:00:00Z");
			at += HOUR
		) {
			await runAt(at);
		}
		expect(await reminders("timer-reminder")).toEqual([
			["ada@example.com", "2026-11-23T17:30:00.000Z", "timer:2026-11-23"],
		]);
	});

	it("of the deadline, due at 09:00, is sent at 09:40, before the deadline at 10:00", async () => {
		await joinedEarlier();
		expect((await runAt("2026-11-23T09:00:00Z", 10)).outcome).toBe("stopped");
		await runAt("2026-11-23T09:40:00Z");
		await runAt("2026-11-23T10:00:00Z");
		expect(await reminders("deadline-reminder")).toEqual([
			["ada@example.com", "2026-11-23T09:40:00.000Z", "deadline:2026-11-23"],
		]);
	});

	it("of weeks waiting, due at 09:00, is sent at 19:30 that day, and once", async () => {
		const kenji = await person(mailbox, "kenji@example.com");
		await seedMembership(acme.id, kenji.user.id, "member");
		await seedTeam(acme.id, "Design", { members: [kenji.user.id], managers: [ada.user.id] });
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.parse("2026-11-20T12:00:00Z"));
		await seedPeriod(acme.id, kenji.user.id, "2026-11-16", "submitted");
		vi.useRealTimers();

		expect((await runAt("2026-11-23T09:00:00Z", 10)).outcome).toBe("stopped");
		await runAt("2026-11-23T19:30:00Z");
		await runAt("2026-11-23T20:00:00Z");
		await runAt("2026-11-23T23:00:00Z");
		expect(await reminders("approvals-reminder")).toEqual([
			["ada@example.com", "2026-11-23T19:30:00.000Z", "approvals:2026-11-23"],
		]);
	});
});

describe("the pass's lease", () => {
	const NOW = Date.parse("2026-11-23T16:00:00Z");

	/** The pass as a run that died left it: a pass going on, held by `leasedUntil`. */
	async function heldBy(leasedUntil: number) {
		await env.DB.prepare(
			"insert into reminder_pass (name, started_at, last_organisation, last_entry, finished_at, lease_token, leased_until) values ('reminders', ?, null, null, null, 'dead', ?)",
		)
			.bind(NOW, leasedUntil)
			.run();
	}

	it("held by a live run keeps another out; once it has run out, the next run takes it over", async () => {
		await joinedEarlier();
		await seedEntry(acme.id, ada.user.id, site, "2026-11-23T08:00:00Z", null);
		await heldBy(NOW + REMINDER_LEASE_MS);

		expect(await runAt(NOW + MINUTE)).toEqual({ outcome: "idle", queries: 1 });
		expect(await reminders("timer-reminder")).toEqual([]);

		expect((await runAt(NOW + REMINDER_LEASE_MS)).outcome).toBe("finished");
		expect(await reminders("timer-reminder")).toEqual([
			["ada@example.com", new Date(NOW + REMINDER_LEASE_MS).toISOString(), "timer:2026-11-23"],
		]);
		const row = await env.DB.prepare("select lease_token, leased_until from reminder_pass").first();
		expect(row).toEqual({ lease_token: null, leased_until: 0 });
	});

	it("is a couple of minutes", () => {
		expect(REMINDER_LEASE_MS).toBe(2 * MINUTE);
	});

	it("lets only one of two runs at once work: the other reads nothing more", async () => {
		await joinedEarlier();
		await timersRunning(3);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		const runs = await Promise.all([runReminders(NOW), runReminders(NOW)]);
		vi.useRealTimers();

		expect(runs.map(({ outcome }) => outcome).sort()).toEqual(["finished", "idle"]);
		expect(runs.find(({ outcome }) => outcome === "idle")?.queries).toBe(1);
		expect(await reminders("timer-reminder")).toHaveLength(3);
	});

	it("taken over from a run still going: the first can no longer write where the pass stands", async () => {
		const hour = NOW;
		const first = await takeReminderPass(env.DB, {
			token: "first",
			now: NOW,
			leasedUntil: NOW + REMINDER_LEASE_MS,
			hour,
		});
		expect(first).not.toBeNull();
		expect(
			await takeReminderPass(env.DB, {
				token: "second",
				now: NOW + MINUTE,
				leasedUntil: NOW + MINUTE + REMINDER_LEASE_MS,
				hour,
			}),
		).toBeNull();
		const second = await takeReminderPass(env.DB, {
			token: "second",
			now: NOW + REMINDER_LEASE_MS,
			leasedUntil: NOW + 2 * REMINDER_LEASE_MS,
			hour,
		});
		expect(second?.leaseToken).toBe("second");

		await leaveReminderPass(env.DB, "first", {
			startedAt: hour,
			lastOrganisation: "zzz",
			lastEntry: "",
			finishedAt: NOW,
		});
		expect(
			await env.DB.prepare(
				"select last_organisation, finished_at, lease_token from reminder_pass",
			).first(),
		).toEqual({ last_organisation: null, finished_at: 0, lease_token: "second" });
	});
});
