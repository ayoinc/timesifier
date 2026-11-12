import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "~/db";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, seedMembership, value } from "../organisations/harness";
import { open, type Person, pageBody, person, submit, textOf } from "./harness";
import { seedHoliday, seedLeave } from "./leave-seed";

// The Timesheet as Harvest makes it feel (TS-093, research/harvest-taste.md):
// a deletion answered with Undo (HT-A), "Start again" on a finished entry
// (HT-A), amber for the running timer and today (HT-B), the Track time
// sheet's own data for any date (HT-C), the month of the day title's picker
// (HT-D), and copying a day or a week forward (HT-F), each through the Worker
// as a browser asks, each refusing what the leave rules and the locks refuse.

const PAGE = "/app/acme";
const ACTION = "/app/acme?index";
const LONDON = "Europe/London";
const HOUR = 3_600_000;
const MINUTE = 60_000;
/** Wednesday 11 November 2026, 10:00 in London (GMT). */
const T0 = Date.parse("2026-11-11T10:00:00Z");
/** Monday 9 November 2026, 15:00 in London. */
const MONDAY = Date.parse("2026-11-09T15:00:00Z");

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };
let site: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	site = await seedProject("Site");
	await setZone(ada, LONDON);
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

async function seedProject(name: string) {
	const id = uuidv7();
	await env.DB.prepare(
		"insert into projects (id, organisation_id, name, name_key, created_at, updated_at) values (?, ?, ?, ?, 0, 0)",
	)
		.bind(id, acme.id, name, name.toLowerCase())
		.run();
	return id;
}

async function seedEntry(
	who: Person,
	startedAt: number,
	endedAt: number | null,
	description: string | null = null,
) {
	const id = uuidv7();
	await env.DB.prepare(
		"insert into time_entries (id, organisation_id, user_id, project_id, description, started_at, ended_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, 0, 0)",
	)
		.bind(id, acme.id, who.user.id, site, description, startedAt, endedAt)
		.run();
	return id;
}

function setZone(who: Person, zone: string) {
	return env.DB.prepare("update users set time_zone = ? where id = ?")
		.bind(zone, who.user.id)
		.run();
}

function clockAt(at: number) {
	vi.spyOn(Date, "now").mockReturnValue(at);
}

async function answerTo(fields: Record<string, string>, who: Person = ada) {
	const response = await submit(ACTION, fields, who, { byScript: true });
	return { status: response.status, body: await response.text() };
}

async function post(fields: Record<string, string>, who: Person = ada) {
	return (await answerTo(fields, who)).status;
}

/** The Undo token a deletion answered with: its signed body and its 64-digit keyed hash. */
function tokenOf(body: string): string {
	const token = /[A-Za-z0-9_-]{20,}\.[0-9a-f]{64}/.exec(body)?.[0];
	if (!token) throw new Error(`no undo token in ${body.slice(0, 300)}`);
	return token;
}

const rows = async () =>
	(
		await env.DB.prepare(
			"select id, description, started_at as startedAt, ended_at as endedAt from time_entries order by started_at",
		).all<{ id: string; description: string | null; startedAt: number; endedAt: number | null }>()
	).results;

async function mainOf(path: string, who: Person = ada) {
	const html = await pageBody(await open(path, who));
	return /<main\b[\s\S]*<\/main>/.exec(html)?.[0] ?? "";
}

describe("deleting an entry, with Undo (HT-A)", () => {
	it("deletes at once, and Undo puts back the same entry with its id and times", async () => {
		clockAt(T0);
		const id = await seedEntry(ada, T0 - 3 * HOUR, T0 - 2 * HOUR, "Plans");
		const deleted = await answerTo({ intent: "delete", entryId: id });
		expect(deleted.status).toBe(200);
		expect(deleted.body).toContain("Entry deleted.");
		expect(await value("select count(*) from time_entries")).toBe(0);

		clockAt(T0 + 8_000);
		const undone = await answerTo({ intent: "undo", token: tokenOf(deleted.body) });
		expect(undone.status).toBe(200);
		expect(undone.body).toContain("Entry restored.");
		expect(await rows()).toEqual([
			{ id, description: "Plans", startedAt: T0 - 3 * HOUR, endedAt: T0 - 2 * HOUR },
		]);
		// The log has the deletion and the entry made again.
		expect(
			await value(
				"select count(*) from activity_records where subject_id = ? and action in ('time_entry.deleted', 'time_entry.created')",
				id,
			),
		).toBe(2);
	});

	it("puts nothing back for another person, a changed token, or after its window", async () => {
		const bola = await person(mailbox, "bola@example.com");
		await seedMembership(acme.id, bola.user.id, "admin");
		clockAt(T0);
		const id = await seedEntry(ada, T0 - 3 * HOUR, T0 - 2 * HOUR);
		const token = tokenOf((await answerTo({ intent: "delete", entryId: id })).body);

		expect(await post({ intent: "undo", token }, bola)).toBe(409);
		const [body = "", hash = ""] = token.split(".");
		expect(await post({ intent: "undo", token: `${body}A.${hash}` })).toBe(409);
		clockAt(T0 + 61_000);
		expect(await post({ intent: "undo", token })).toBe(409);
		expect(await value("select count(*) from time_entries")).toBe(0);
	});

	it("puts nothing back on a day locked since", async () => {
		clockAt(T0);
		const monday = Date.parse("2026-11-09T09:00:00Z");
		const id = await seedEntry(ada, monday, monday + HOUR);
		const token = tokenOf((await answerTo({ intent: "delete", entryId: id })).body);
		expect(await post({ intent: "submit", startsOn: "2026-11-09" })).toBe(200);

		expect(await post({ intent: "undo", token })).toBe(409);
		expect(await value("select count(*) from time_entries")).toBe(0);
	});
});

describe("the Day view's entries (HT-A, HT-B)", () => {
	it("offers Start again on a finished entry, and starts the same project and description", async () => {
		clockAt(T0);
		await seedEntry(ada, T0 - 3 * HOUR, T0 - 2 * HOUR, "Plans");
		const main = await mainOf(PAGE);
		expect(main).toContain('aria-label="Start again: Plans"');

		expect(
			await post({
				intent: "track",
				day: "2026-11-11",
				projectId: site,
				description: "Plans",
			}),
		).toBe(200);
		const started = (await rows()).at(-1);
		expect(started).toMatchObject({ description: "Plans", startedAt: T0, endedAt: null });
	});

	it("offers no Start again on a submitted week", async () => {
		clockAt(T0);
		await seedEntry(ada, T0 - 3 * HOUR, T0 - 2 * HOUR, "Plans");
		expect(await post({ intent: "submit", startsOn: "2026-11-09" })).toBe(200);
		expect(await mainOf(PAGE)).not.toContain("Start again");
	});

	it("marks today and the running entry in amber, and nothing on a week without either", async () => {
		clockAt(T0);
		const running = await seedEntry(ada, T0 - HOUR, null, "Plans");
		const main = await mainOf(PAGE);
		// Today's chip, the running bar and the running row.
		expect(main.match(/bg-primary-container/g)?.length).toBe(3);
		expect(main).toContain("timer running");

		await env.DB.prepare("update time_entries set ended_at = ? where id = ?")
			.bind(T0, running)
			.run();
		expect(await mainOf(PAGE)).toContain("bg-primary-container");

		expect(await mainOf(`${PAGE}?day=2026-10-14`)).not.toContain("bg-primary-container");
		expect(await mainOf(`${PAGE}?view=week&start=2026-10-12`)).not.toContain(
			"bg-primary-container",
		);
		expect(await mainOf(`${PAGE}?view=week`)).toContain('aria-current="date"');
	});

	it("leads the navigation's Track time to a sheet, not to another page", async () => {
		clockAt(T0);
		const response = await open("/app/acme/projects", ada);
		expect(response.status).toBe(200);
		const html = await pageBody(response);
		expect(html).not.toContain("#timer");
		expect(textOf(html)).toContain("Track time");
	});
});

describe("Track time's own data for any date (HT-C) and the picker's month (HT-D)", () => {
	it("says what a day takes: its leave, a lock and its limit", async () => {
		clockAt(T0);
		await seedLeave(acme.id, ada.user.id, "annual", "2026-11-12", "2026-11-12");
		const day = await (await open("/app/acme/timesheet/day?day=2026-11-12", ada)).json<{
			day: string;
			today: string;
			rule: { closedReason: string | null } | null;
			lockReason: string | null;
			track: { recent: string[] };
		}>();
		expect(day.day).toBe("2026-11-12");
		expect(day.today).toBe("2026-11-11");
		expect(day.rule?.closedReason).toMatch(/leave/i);
		expect(day.lockReason).toBeNull();

		expect(await post({ intent: "submit", startsOn: "2026-11-09" })).toBe(200);
		const locked = await (await open("/app/acme/timesheet/day?day=2026-11-10", ada)).json<{
			lockReason: string | null;
		}>();
		expect(locked.lockReason).toBe("submitted");
		// The server refuses what the sheet holds back.
		expect(await post({ intent: "track", day: "2026-11-12", projectId: site, hours: "1" })).toBe(
			409,
		);
	});

	it("gives today for a date that is not one, and only to a member", async () => {
		const stranger = await person(mailbox, "stranger@example.com");
		clockAt(T0);
		const day = await (await open("/app/acme/timesheet/day?day=nope", ada)).json<{ day: string }>();
		expect(day.day).toBe("2026-11-11");
		expect((await open("/app/acme/timesheet/day", stranger)).status).toBe(404);
	});

	it("gives the month's days with each one's time", async () => {
		clockAt(T0);
		await seedEntry(ada, T0 - 3 * HOUR, T0 - HOUR - 30 * MINUTE);
		const month = await (await open("/app/acme/timesheet/month?date=2026-11-20", ada)).json<{
			month: string;
			days: { day: string; total: number; inMonth: boolean }[];
		}>();
		expect(month.month).toBe("2026-11-01");
		expect(month.days.length % 7).toBe(0);
		expect(month.days.find((d) => d.day === "2026-11-11")?.total).toBe(90 * MINUTE);
		expect(month.days.find((d) => d.day === "2026-11-01")?.inMonth).toBe(true);
	});
});

describe("copying forward (HT-F)", () => {
	const at = (iso: string) => Date.parse(iso);

	it("copies the last working day's entries onto an empty Monday, end to end from 09:00", async () => {
		clockAt(MONDAY);
		await seedEntry(ada, at("2026-11-06T08:00:00Z"), at("2026-11-06T09:30:00Z"), "Plans");
		await seedEntry(ada, at("2026-11-06T13:00:00Z"), at("2026-11-06T14:00:00Z"), "Calls");
		expect(textOf(await mainOf(PAGE))).toContain("Copy Fri 6's entries");

		const copied = await answerTo({ intent: "copy-day", day: "2026-11-09" });
		expect(copied.status).toBe(200);
		expect(copied.body).toContain("Copied 2 entries from Fri 6.");
		const monday = (await rows()).filter((r) => r.startedAt >= at("2026-11-09T00:00:00Z"));
		expect(monday).toEqual([
			expect.objectContaining({
				description: "Plans",
				startedAt: at("2026-11-09T09:00:00Z"),
				endedAt: at("2026-11-09T10:30:00Z"),
			}),
			expect.objectContaining({
				description: "Calls",
				startedAt: at("2026-11-09T10:30:00Z"),
				endedAt: at("2026-11-09T11:30:00Z"),
			}),
		]);
		// The total after the copy is the sum of what was copied.
		const total = monday.reduce((sum, r) => sum + ((r.endedAt ?? 0) - r.startedAt), 0);
		expect(total).toBe(150 * MINUTE);

		// Never onto a day that has time.
		expect(await post({ intent: "copy-day", day: "2026-11-09" })).toBe(409);
		expect(await value("select count(*) from time_entries")).toBe(4);
	});

	it("passes over a day of leave to the working day before it", async () => {
		clockAt(MONDAY);
		await seedEntry(ada, at("2026-11-05T09:00:00Z"), at("2026-11-05T10:00:00Z"), "Thursday");
		await seedLeave(acme.id, ada.user.id, "annual", "2026-11-06", "2026-11-06");
		await seedEntry(ada, at("2026-11-06T09:00:00Z"), at("2026-11-06T10:00:00Z"), "On leave");

		const copied = await answerTo({ intent: "copy-day", day: "2026-11-09" });
		expect(copied.body).toContain("from Thu 5");
		expect((await rows()).at(-1)?.description).toBe("Thursday");
	});

	it("copies nothing onto a public holiday, a day of leave or a locked day", async () => {
		clockAt(T0);
		await seedEntry(ada, at("2026-11-06T09:00:00Z"), at("2026-11-06T10:00:00Z"));
		await seedHoliday(acme.id, "2026-11-10", "A holiday");
		await seedLeave(acme.id, ada.user.id, "annual", "2026-11-11", "2026-11-11");
		expect(await post({ intent: "copy-day", day: "2026-11-10" })).toBe(409);
		expect(await post({ intent: "copy-day", day: "2026-11-11" })).toBe(409);
		expect(await post({ intent: "submit", startsOn: "2026-11-09" })).toBe(200);
		expect(await post({ intent: "copy-day", day: "2026-11-09" })).toBe(409);
		expect(await value("select count(*) from time_entries")).toBe(1);
		expect(textOf(await mainOf(`${PAGE}?day=2026-11-09`))).not.toContain("Copy");
	});

	it("copies last week with its hours, day by day, leaving a day with time as it is", async () => {
		clockAt(T0);
		await seedEntry(ada, at("2026-11-02T09:00:00Z"), at("2026-11-02T11:00:00Z"), "Mon");
		await seedEntry(ada, at("2026-11-03T09:00:00Z"), at("2026-11-03T10:00:00Z"), "Tue");
		await seedEntry(ada, at("2026-11-10T14:00:00Z"), at("2026-11-10T15:00:00Z"), "Kept");
		expect(textOf(await mainOf(`${PAGE}?view=week`))).toContain("Copy last week with hours");

		const copied = await answerTo({ intent: "copy-week", startsOn: "2026-11-09" });
		expect(copied.status).toBe(200);
		expect(copied.body).toContain("Copied 1 entry onto 1 day.");
		const week = (await rows()).filter((r) => r.startedAt >= at("2026-11-09T00:00:00Z"));
		expect(week.map((r) => r.description)).toEqual(["Mon", "Kept"]);
		expect(week[0]).toMatchObject({
			startedAt: at("2026-11-09T09:00:00Z"),
			endedAt: at("2026-11-09T11:00:00Z"),
		});
	});
});
