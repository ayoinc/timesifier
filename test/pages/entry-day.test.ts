import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, type Role, seedMembership, value } from "../organisations/harness";
import { type Person, person, submit } from "./harness";
import { seedEntry, seedProject } from "./periods-seed";

// Every write of the Timesheet stores the day an entry belongs to (TS-111):
// the day it starts on in the person's zone when it is tracked. The person
// here is in Auckland, thirteen hours ahead of UTC in November, so the day
// stored is never the day UTC would give. Every request goes through the
// Worker, as the page's own forms make it, for an owner, an admin and a
// member alike, each on their own time. The API and the CSV import store it
// too (test/integrations/api.test.ts, test/integrations/import.test.ts).

const ACTION = "/app/acme?index";
const AUCKLAND = "Pacific/Auckland";
const HOUR = 3_600_000;
/** The instant of `iso`, written in UTC. */
const at = (iso: string) => Date.parse(iso);
/** Wednesday 11 November 2026, 23:00 in Auckland: the server's clock unless a test moves it. */
const T0 = at("2026-11-11T10:00:00Z");

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

/** Acme, owned by Ada, with Grace in it, both in Auckland; the person of `role` returned. */
async function acmeWith(role: Role): Promise<Person> {
	const ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	const grace = await person(mailbox, "grace@example.com");
	await seedMembership(acme.id, grace.user.id, role === "owner" ? "member" : role);
	for (const who of [ada, grace]) await setZone(who, AUCKLAND);
	site = await seedProject(acme.id, "Site");
	clockAt(T0);
	return role === "owner" ? ada : grace;
}

function setZone(who: Person, zone: string) {
	return env.DB.prepare("update users set time_zone = ? where id = ?")
		.bind(zone, who.user.id)
		.run();
}

function clockAt(instant: number) {
	vi.spyOn(Date, "now").mockReturnValue(instant);
}

async function ask(who: Person, fields: Record<string, string>) {
	const response = await submit(ACTION, fields, who, { byScript: true });
	return { status: response.status, said: await response.text() };
}

/** The entries of `who`, oldest first: start, end, kind and the day stored. */
async function entriesOf(who: Person) {
	const { results } = await env.DB.prepare(
		"select id, started_at, ended_at, overtime, spent_on, description from time_entries where user_id = ? order by started_at",
	)
		.bind(who.user.id)
		.all<{
			id: string;
			started_at: number;
			ended_at: number | null;
			overtime: number;
			spent_on: string;
			description: string | null;
		}>();
	return results.map((row) => ({
		id: row.id,
		from: row.started_at,
		to: row.ended_at,
		overtime: row.overtime === 1,
		day: row.spent_on,
		description: row.description,
	}));
}

const daysOf = async (who: Person) => (await entriesOf(who)).map((entry) => entry.day);

/** The Undo token a deletion answered with. */
function tokenOf(body: string): string {
	const token = /[A-Za-z0-9_-]{20,}\.[0-9a-f]{64}/.exec(body)?.[0];
	if (!token) throw new Error(`no undo token in ${body.slice(0, 300)}`);
	return token;
}

describe.each(["owner", "admin", "member"] as const)("for an %s's own time", (role) => {
	let me: Person;

	beforeEach(async () => {
		me = await acmeWith(role);
	});

	it("a timer is on the day it starts, in the person's zone, and stays there when stopped after midnight", async () => {
		// 00:30 on Wednesday in Auckland, still Tuesday in UTC.
		clockAt(at("2026-11-10T11:30:00Z"));
		expect((await ask(me, { intent: "track", projectId: site, day: "2026-11-11" })).status).toBe(
			200,
		);
		expect(await daysOf(me)).toEqual(["2026-11-11"]);
		clockAt(at("2026-11-10T12:00:00Z"));
		expect((await ask(me, { intent: "stop" })).status).toBe(200);

		// 23:30 on Wednesday, stopped at 00:30 on Thursday.
		clockAt(at("2026-11-11T10:30:00Z"));
		await ask(me, { intent: "track", projectId: site, day: "2026-11-11" });
		clockAt(at("2026-11-11T11:30:00Z"));
		expect((await ask(me, { intent: "stop" })).status).toBe(200);
		expect(await daysOf(me)).toEqual(["2026-11-11", "2026-11-11"]);
	});

	it("a timer cut at the limit after midnight keeps its overtime on the day it started (TR-06)", async () => {
		await env.DB.prepare("update organisations set overtime_policy = 'allowed' where id = ?")
			.bind(acme.id)
			.run();
		// 6:45 of Wednesday's 7:30 tracked, 09:00 to 15:45 in Auckland.
		await ask(me, {
			intent: "track",
			projectId: site,
			day: "2026-11-11",
			start: "09:00",
			hours: "6:45",
		});
		// A timer from 23:30 Wednesday to 01:30 Thursday: the limit is reached at 00:15.
		clockAt(at("2026-11-11T10:30:00Z"));
		await ask(me, { intent: "track", projectId: site, day: "2026-11-11" });
		clockAt(at("2026-11-11T12:30:00Z"));
		expect((await ask(me, { intent: "stop" })).status).toBe(200);
		const [, regular, overtime] = await entriesOf(me);
		expect(regular).toMatchObject({
			from: at("2026-11-11T10:30:00Z"),
			to: at("2026-11-11T11:15:00Z"),
			overtime: false,
			day: "2026-11-11",
		});
		expect(overtime).toMatchObject({
			from: at("2026-11-11T11:15:00Z"),
			to: at("2026-11-11T12:30:00Z"),
			overtime: true,
			day: "2026-11-11",
		});
	});

	it("a timer started before days were stored takes the day it started when it stops, or when another starts", async () => {
		// Started at 00:30 on Tuesday in Auckland by the Worker before TS-111: no day.
		await seedEntry(acme.id, me.user.id, site, at("2026-11-09T11:30:00Z"), null);
		expect(await daysOf(me)).toEqual([""]);
		clockAt(at("2026-11-09T12:00:00Z"));
		expect((await ask(me, { intent: "stop" })).status).toBe(200);
		expect(await daysOf(me)).toEqual(["2026-11-10"]);

		await env.DB.prepare("delete from time_entries").run();
		await seedEntry(acme.id, me.user.id, site, at("2026-11-09T11:30:00Z"), null);
		clockAt(at("2026-11-09T12:00:00Z"));
		expect((await ask(me, { intent: "track", projectId: site, day: "2026-11-10" })).status).toBe(
			200,
		);
		expect(await daysOf(me)).toEqual(["2026-11-10", "2026-11-10"]);
	});

	it("hours tracked, on a slot of the calendar, and typed into a cell are on the day chosen", async () => {
		await ask(me, { intent: "track", projectId: site, day: "2026-11-09", hours: "1" });
		// 00:30 on Tuesday in Auckland is Monday in UTC.
		await ask(me, {
			intent: "track",
			projectId: site,
			day: "2026-11-10",
			start: "00:30",
			hours: "1",
		});
		await ask(me, { intent: "cell", projectId: site, day: "2026-11-11", hours: "2" });
		expect(await daysOf(me)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11"]);
		const slot = (await entriesOf(me))[1];
		expect(new Date(slot?.from ?? 0).toISOString().slice(0, 10)).toBe("2026-11-09");

		// A cell changed keeps its day.
		await ask(me, { intent: "cell", projectId: site, day: "2026-11-11", hours: "3" });
		expect(await daysOf(me)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11"]);
	});

	it("an edit keeps the entry's day unless its start moves, then takes the day typed", async () => {
		await ask(me, {
			intent: "track",
			projectId: site,
			day: "2026-11-10",
			start: "00:30",
			hours: "1",
		});
		const [entry] = await entriesOf(me);
		if (!entry) throw new Error("not tracked");
		// The person moves to London: the entry's start reads 11:30 on Monday 9 there.
		await setZone(me, "Europe/London");
		const edit = {
			intent: "edit",
			entryId: entry.id,
			projectId: site,
			date: "2026-11-09",
			start: "11:30",
			end: "12:30",
		};
		expect((await ask(me, { ...edit, description: "Plans" })).status).toBe(200);
		expect(await entriesOf(me)).toEqual([
			expect.objectContaining({ from: entry.from, description: "Plans", day: "2026-11-10" }),
		]);

		expect(
			(await ask(me, { ...edit, date: "2026-11-11", start: "09:00", end: "10:00" })).status,
		).toBe(200);
		expect(await daysOf(me)).toEqual(["2026-11-11"]);
	});

	it("Undo puts an entry back on the day it was on, though the person's zone has changed since", async () => {
		await ask(me, {
			intent: "track",
			projectId: site,
			day: "2026-11-10",
			start: "00:30",
			hours: "1",
		});
		const [entry] = await entriesOf(me);
		const deleted = await ask(me, { intent: "delete", entryId: entry?.id ?? "" });
		expect(deleted.status).toBe(200);
		await setZone(me, "Europe/London");
		const undone = await ask(me, { intent: "undo", token: tokenOf(deleted.said) });
		expect(undone.status).toBe(200);
		expect(await entriesOf(me)).toEqual([
			expect.objectContaining({ id: entry?.id, day: "2026-11-10" }),
		]);
	});

	it("Copy day and Copy week put each copy on the day it is copied onto", async () => {
		// Monday 2, 10:00 to 11:00 in Auckland, Sunday 1 in UTC.
		await seedEntry(
			acme.id,
			me.user.id,
			site,
			at("2026-11-01T21:00:00Z"),
			at("2026-11-01T22:00:00Z"),
		);
		await env.DB.prepare("update time_entries set spent_on = '2026-11-02'").run();
		expect((await ask(me, { intent: "copy-day", day: "2026-11-09" })).status).toBe(200);
		expect(await daysOf(me)).toEqual(["2026-11-02", "2026-11-09"]);

		await env.DB.prepare("delete from time_entries where spent_on = '2026-11-09'").run();
		expect((await ask(me, { intent: "copy-week", startsOn: "2026-11-09" })).status).toBe(200);
		expect(await daysOf(me)).toEqual(["2026-11-02", "2026-11-09"]);
		expect(await value("select count(*) from time_entries where spent_on = ''")).toBe(0);
	});
});

it("leaves no entry without its day after a week of every write path", async () => {
	const me = await acmeWith("member");
	await ask(me, { intent: "track", projectId: site, day: "2026-11-09", hours: "2" });
	await ask(me, { intent: "cell", projectId: site, day: "2026-11-10", hours: "1" });
	await ask(me, { intent: "track", projectId: site, day: "2026-11-11" });
	clockAt(T0 + HOUR);
	await ask(me, { intent: "stop" });
	expect(await value("select count(*) from time_entries")).toBe(3);
	expect(
		await value("select count(*) from time_entries where date(spent_on) is not spent_on"),
	).toBe(0);
});
