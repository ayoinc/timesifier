import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "~/db";
import { addDays, dayOf, instantAt } from "~/time/calendar";
import { gridEntryStart } from "~/time/grid";
import { GETTING_STARTED_COOKIE } from "~/timesheet/getting-started.server";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, type Role, seedMembership, value } from "../organisations/harness";
import { open, openData, type Person, pageBody, person, submit, textOf } from "./harness";
import { seedHoliday, seedLeave } from "./leave-seed";

// Timesheet, /app/<slug>: the timer (TS-012a), the Day and Week views
// (TS-013), entries by hand (TS-012b), the week's grid (TS-052), a week's
// submission and History (TS-046), the timer in the navigation (TS-051), and
// "Track time", the week's days above the day, the submission at the Day
// view's foot and getting started (TS-056).
// Every request goes through the Worker, as a browser makes it.

const PAGE = "/app/acme";
/** Where the page's forms post: the index route, not the organisation's layout at the same address. */
const ACTION = "/app/acme?index";
const LONDON = "Europe/London";
const HOUR = 3_600_000;
const MINUTE = 60_000;
/** A Wednesday, 10:00 in London. */
const T0 = Date.parse("2026-11-11T10:00:00Z");

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };
let site: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	site = await seedProject(acme.id, "Site");
	await setZone(ada, LONDON);
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

async function seedProject(organisationId: string, name: string, archived = false) {
	const id = uuidv7();
	await env.DB.prepare(
		"insert into projects (id, organisation_id, name, name_key, archived_at, created_at, updated_at) values (?, ?, ?, ?, ?, 0, 0)",
	)
		.bind(id, organisationId, name, name.toLowerCase(), archived ? 1 : null)
		.run();
	return id;
}

async function seedEntry(
	who: Person,
	startedAt: number,
	endedAt: number | null,
	{ project = site, description = null as string | null, organisationId = acme.id } = {},
) {
	const id = uuidv7();
	await env.DB.prepare(
		"insert into time_entries (id, organisation_id, user_id, project_id, description, started_at, ended_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, 0, 0)",
	)
		.bind(id, organisationId, who.user.id, project, description, startedAt, endedAt)
		.run();
	return id;
}

function setZone(who: Person, zone: string | null) {
	return env.DB.prepare("update users set time_zone = ? where id = ?")
		.bind(zone, who.user.id)
		.run();
}

/** A person who signs in and holds `role` in Acme. */
async function memberOfAcme(role: Role, email: string): Promise<Person> {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, role);
	await setZone(who, LONDON);
	return who;
}

/** The server's clock, fixed at `at` for what follows. */
function clockAt(at: number) {
	vi.spyOn(Date, "now").mockReturnValue(at);
}

/** Posts one of the page's forms by script, and returns the status. */
async function post(fields: Record<string, string>, who: Person = ada) {
	return (await submit(ACTION, fields, who, { byScript: true })).status;
}

/** "Track time" on the day the server's clock is in, in London: with no hours, it starts the timer. */
function track(fields: Record<string, string> = {}) {
	return { intent: "track", day: dayOf(Date.now(), LONDON), ...fields };
}

const entries = () =>
	env.DB.prepare(
		"select id, user_id as userId, project_id as projectId, description, started_at as startedAt, ended_at as endedAt from time_entries order by started_at",
	).all<{
		id: string;
		userId: string;
		projectId: string;
		description: string | null;
		startedAt: number;
		endedAt: number | null;
	}>();

const countEntries = () => value("select count(*) from time_entries");

async function textAt(path: string, who: Person = ada) {
	const response = await open(path, who);
	expect(response.status, path).toBe(200);
	return textOf(await pageBody(response));
}

/** The main region of a page, as HTML. */
async function mainOf(path: string, who: Person = ada) {
	const html = await pageBody(await open(path, who));
	return /<main\b[\s\S]*<\/main>/.exec(html)?.[0] ?? "";
}

describe("the timer (TS-012a)", () => {
	it("starts one entry at the server's clock, whatever the request claims", async () => {
		clockAt(T0);
		expect(await post(track({ projectId: site, description: "Plans", startedAt: "0" }))).toBe(200);

		const { results } = await entries();
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			userId: ada.user.id,
			projectId: site,
			description: "Plans",
			startedAt: T0,
			endedAt: null,
		});
	});

	it("refuses no project, an archived one and another organisation's with 400, and stores nothing", async () => {
		const archived = await seedProject(acme.id, "Old", true);
		const grace = await person(mailbox, "grace@example.com");
		const initech = await createOrganisation(grace.cookie, "Initech");
		const theirs = await seedProject(initech.id, "Theirs");

		for (const projectId of ["", "no-such-project", archived, theirs]) {
			expect(await post(track({ projectId })), projectId).toBe(400);
		}
		expect(await post(track())).toBe(400);
		expect(await countEntries()).toBe(0);
	});

	it("stores a description of 500 characters and refuses one of 501 with 400", async () => {
		expect(await post(track({ projectId: site, description: "x".repeat(501) }))).toBe(400);
		expect(await countEntries()).toBe(0);
		expect(await post(track({ projectId: site, description: "x".repeat(500) }))).toBe(200);
		expect((await entries()).results[0]?.description).toHaveLength(500);
	});

	it("stops the caller's running entry at the server's clock, and with nothing running changes nothing", async () => {
		clockAt(T0);
		expect(await post({ intent: "stop" })).toBe(200);
		expect(await countEntries()).toBe(0);

		await post(track({ projectId: site }));
		clockAt(T0 + 25 * MINUTE);
		expect(await post({ intent: "stop", entryId: "ignored" })).toBe(200);
		expect((await entries()).results[0]?.endedAt).toBe(T0 + 25 * MINUTE);
	});

	it("starting while one runs stops the first at the second's start", async () => {
		clockAt(T0);
		await post(track({ projectId: site }));
		clockAt(T0 + HOUR);
		await post(track({ projectId: site }));

		const { results } = await entries();
		expect(results.map((e) => [e.startedAt, e.endedAt])).toEqual([
			[T0, T0 + HOUR],
			[T0 + HOUR, null],
		]);
	});

	it("with no active project shows a heading and exactly one link, Create a project, to Projects", async () => {
		await env.DB.prepare("update projects set archived_at = 1").run();
		const main = await mainOf(PAGE);

		expect(textOf(main)).toContain("No project to track yet");
		expect(main).not.toContain(">Track time</button>");
		const timer = /<section id="timer"[\s\S]*?<\/section>/.exec(main)?.[0] ?? "";
		const links = [...timer.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)];
		expect(links.map(([, href, label]) => [href, textOf(label ?? "")])).toEqual([
			["/app/acme/projects", "Create a project"],
		]);
	});

	it("with a project shows one button, Track time, and no form of its own", async () => {
		const main = await mainOf(PAGE);
		const timer = /<section id="timer"[\s\S]*?<\/section>/.exec(main)?.[0] ?? "";

		expect(timer.match(/<button\b/g)).toHaveLength(1);
		expect(timer).toMatch(/>Track time<\/button>/);
		expect(timer).not.toContain("<form");
	});

	it("shows a start time in the person's zone, across the clock change", async () => {
		const first = await seedEntry(
			ada,
			Date.parse("2026-03-29T00:30:00Z"),
			Date.parse("2026-03-29T01:30:00Z"),
		);
		expect(first).toBeTruthy();
		const text = await textAt(`${PAGE}?day=2026-03-29`);

		// 00:30Z is 00:30 in London, and 01:30Z is 02:30 after the clocks go forward.
		expect(text).toContain("00:30–02:30");
		// It lasted an hour of real time, although the clock moved two.
		expect(text).toContain("1:00");
	});

	it("is started and stopped from another organisation's address by nobody: 404 for both intents", async () => {
		const grace = await person(mailbox, "grace@example.com");
		await createOrganisation(grace.cookie, "Initech");
		await seedEntry(ada, T0 - HOUR, null);

		expect(await post(track({ projectId: site }), grace)).toBe(404);
		expect(await post({ intent: "stop" }, grace)).toBe(404);
		expect((await entries()).results.map((e) => e.endedAt)).toEqual([null]);
	});

	it("lets a person run one timer in each of two organisations", async () => {
		const globex = await createOrganisation(ada.cookie, "Globex");
		const theirs = await seedProject(globex.id, "Theirs");
		await post(track({ projectId: site }));
		const response = await submit("/app/globex?index", track({ projectId: theirs }), ada, {
			byScript: true,
		});

		expect(response.status).toBe(200);
		expect(await value("select count(*) from time_entries where ended_at is null")).toBe(2);
	});
});

describe("the timer in the navigation (TS-051)", () => {
	it("shows the running project, the elapsed time and Stop on every page", async () => {
		clockAt(T0);
		await post(track({ projectId: site }));
		clockAt(T0 + 65 * MINUTE + 5_000);

		for (const path of [PAGE, "/app/acme/projects", "/app/acme/account", "/app/acme/reports"]) {
			const html = await pageBody(await open(path, ada));
			const nav = /<nav aria-label="Main"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
			const timer = textOf(nav.slice(0, nav.indexOf("<ul")));
			expect(timer, path).toContain("Site");
			expect(timer, path).toContain("1:05:05");
			expect(nav, path).toMatch(/<button[^>]*aria-label="Stop timer for Site"[^>]*>Stop<\/button>/);
			expect(nav, path).not.toContain("Track time");
		}
	});

	it("stops through the Timesheet's stop, from any page", async () => {
		await post(track({ projectId: site }));
		const html = await pageBody(await open("/app/acme/reports", ada));
		const form = /<form[^>]*action="([^"]*)"[^>]*>(?:(?!<\/form>)[\s\S])*Stop timer for Site/.exec(
			html,
		);
		expect(form?.[1]).toBe(ACTION);

		expect(await post({ intent: "stop" })).toBe(200);
		expect(await value("select count(*) from time_entries where ended_at is null")).toBe(0);
	});
});

describe("the person's time zone (TS-012a)", () => {
	const ACCOUNT = "/app/acme/account";
	const zone = () => value<string>("select time_zone from users where id = ?", ada.user.id);
	const sendZone = async (intent: string, timeZone: string) =>
		(await submit(ACCOUNT, { intent, timeZone }, ada, { byScript: true })).status;

	it("is shown on My account and changed there; an unknown name answers 400 and stores nothing", async () => {
		expect(await textAt(ACCOUNT)).toContain(LONDON);
		expect(await sendZone("time-zone", "Pacific/Auckland")).toBe(200);
		expect(await zone()).toBe("Pacific/Auckland");
		expect(await sendZone("time-zone", "Mars/Olympus_Mons")).toBe(400);
		expect(await zone()).toBe("Pacific/Auckland");
	});

	it("is set from the browser's while the person has none, and never replaces one they chose", async () => {
		await setZone(ada, null);
		expect(await sendZone("time-zone-detected", "Mars/Olympus_Mons")).toBe(400);
		expect(await zone()).toBeNull();
		expect(await sendZone("time-zone-detected", "Asia/Tokyo")).toBe(200);
		expect(await zone()).toBe("Asia/Tokyo");
		expect(await sendZone("time-zone-detected", "UTC")).toBe(200);
		expect(await zone()).toBe("Asia/Tokyo");
	});

	it("is shown as the organisation's until the person has one, and the navigation asks the browser for it", async () => {
		await setZone(ada, null);
		expect(await textAt(ACCOUNT)).toContain("UTC, your organisation's, until you choose one");
		const data = await (await openData(PAGE, ada)).text();
		expect(data).toContain("hasTimeZone");
	});
});

describe("the Day view (TS-013)", () => {
	it("lists the caller's entries of the chosen day, earliest first, with project, description, times, duration and total", async () => {
		const ops = await seedProject(acme.id, "Ops", true);
		await seedEntry(
			ada,
			instantAt("2026-11-11", 13 * 60, LONDON),
			instantAt("2026-11-11", 14 * 60 + 30, LONDON),
			{
				description: "Review",
			},
		);
		await seedEntry(
			ada,
			instantAt("2026-11-11", 9 * 60, LONDON),
			instantAt("2026-11-11", 10 * 60, LONDON),
			{
				project: ops,
				description: "Standup",
			},
		);
		const text = textOf(await mainOf(`${PAGE}?day=2026-11-11`));

		expect(text.indexOf("Standup")).toBeLessThan(text.indexOf("Review"));
		expect(text).toContain("09:00–10:00");
		expect(text).toContain("Ops");
		expect(text).toContain("13:00–14:30");
		expect(text).toContain("1:30");
		expect(text).toMatch(/Day total 2:30/);
	});

	it("lists a running entry as Running, counted to the time of the request", async () => {
		clockAt(T0);
		await seedEntry(ada, T0 - 45 * MINUTE, null);
		const text = await textAt(`${PAGE}?day=2026-11-11`);

		expect(text).toContain("09:15–Running");
		expect(text).toMatch(/Day total 0:45/);
	});

	it("puts an entry from 23:30 to 00:30 under the first day only", async () => {
		const start = instantAt("2026-11-10", 23 * 60 + 30, LONDON);
		await seedEntry(ada, start, start + HOUR);

		expect(await textAt(`${PAGE}?day=2026-11-10`)).toMatch(/Day total 1:00/);
		expect(await textAt(`${PAGE}?day=2026-11-11`)).toContain("Nothing tracked on this day.");
	});

	it("with nothing tracked says so and adds no button to the list", async () => {
		const main = await mainOf(`${PAGE}?day=2026-11-01`);
		expect(textOf(main)).toContain("Nothing tracked on this day.");
		expect(main.match(/>Track time<\/button>/g)).toHaveLength(1);
		expect(main).not.toContain("Add entry");
	});

	it("answers a day that is not a date with 400", async () => {
		for (const query of [
			"day=2026-02-30",
			"day=today",
			"view=week&start=2026-11-11",
			"view=week&start=x",
		]) {
			expect((await open(`${PAGE}?${query}`, ada)).status, query).toBe(400);
		}
	});

	it("shows neither member the other's entries, nor counts them", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");
		await seedEntry(
			ada,
			instantAt("2026-11-11", 9 * 60, LONDON),
			instantAt("2026-11-11", 10 * 60, LONDON),
			{
				description: "Ada's work",
			},
		);
		await seedEntry(
			linus,
			instantAt("2026-11-11", 9 * 60, LONDON),
			instantAt("2026-11-11", 12 * 60, LONDON),
			{
				description: "Linus's work",
			},
		);

		const forAda = await textAt(`${PAGE}?day=2026-11-11`);
		const forLinus = await textAt(`${PAGE}?day=2026-11-11`, linus);
		expect(forAda).not.toContain("Linus's work");
		expect(forAda).toMatch(/Day total 1:00/);
		expect(forLinus).not.toContain("Ada's work");
		expect(forLinus).toMatch(/Day total 3:00/);
		const week = await textAt(`${PAGE}?view=week&start=2026-11-09`);
		expect(week).toMatch(/Week total 1:00/);
	});
});

describe("the Week view (TS-013, TS-052)", () => {
	const WEEK = `${PAGE}?view=week&start=2026-11-09`;

	it("shows seven days from the week's start, a total per day, per project, an archived project by name, and the week's", async () => {
		const ops = await seedProject(acme.id, "Ops", true);
		await seedEntry(
			ada,
			instantAt("2026-11-09", 9 * 60, LONDON),
			instantAt("2026-11-09", 11 * 60, LONDON),
		);
		await seedEntry(
			ada,
			instantAt("2026-11-15", 9 * 60, LONDON),
			instantAt("2026-11-15", 10 * 60, LONDON),
			{
				project: ops,
			},
		);
		const main = await mainOf(WEEK);
		const text = textOf(main);

		expect(main.match(/<th scope="col"/g)).toHaveLength(9);
		expect(text).toContain("Mon 9");
		expect(text).toContain("Sun 15");
		expect(text).toContain("Ops (archived)");
		expect(text).toMatch(/Day total 2:00 0:00 0:00 0:00 0:00 0:00 1:00 Week total 3:00/);
	});

	it("follows the organisation's week start", async () => {
		await env.DB.prepare("update organisations set week_starts_on = 7").run();
		expect((await open(WEEK, ada)).status).toBe(400);
		expect(await textAt(`${PAGE}?view=week&start=2026-11-08`)).toContain("Sun 8");
	});

	it("a typed hour makes one entry from 09:00 local on an empty day, and the next from the day's last end", async () => {
		clockAt(T0);
		expect(await post({ intent: "cell", projectId: site, day: "2026-11-09", hours: "1.5" })).toBe(
			200,
		);
		const other = await seedProject(acme.id, "Other");
		expect(await post({ intent: "cell", projectId: other, day: "2026-11-09", hours: "1:00" })).toBe(
			200,
		);

		const nine = instantAt("2026-11-09", 9 * 60, LONDON);
		expect((await entries()).results.map((e) => [e.projectId, e.startedAt, e.endedAt])).toEqual([
			[site, nine, nine + 90 * MINUTE],
			[other, nine + 90 * MINUTE, nine + 150 * MINUTE],
		]);
		expect(await textAt(WEEK)).toMatch(/Week total 2:30/);
	});

	it("changes the one entry of a cell, and an emptied cell removes the project's time that day", async () => {
		await post({ intent: "cell", projectId: site, day: "2026-11-10", hours: "2" });
		await post({ intent: "cell", projectId: site, day: "2026-11-10", hours: "3" });
		const { results } = await entries();
		expect(results).toHaveLength(1);
		expect((results[0]?.endedAt ?? 0) - (results[0]?.startedAt ?? 0)).toBe(3 * HOUR);

		expect(await post({ intent: "cell", projectId: site, day: "2026-11-10", hours: "" })).toBe(200);
		expect(await countEntries()).toBe(0);
	});

	it("refuses hours that are not hours, without storing anything", async () => {
		expect(await post({ intent: "cell", projectId: site, day: "2026-11-10", hours: "lots" })).toBe(
			400,
		);
		expect(await post({ intent: "cell", projectId: site, day: "2026-11-10", hours: "25" })).toBe(
			400,
		);
		expect(await countEntries()).toBe(0);
	});

	it("leaves a cell of more than one entry, or of a running one, to the Day view", async () => {
		clockAt(T0);
		await seedEntry(
			ada,
			instantAt("2026-11-09", 9 * 60, LONDON),
			instantAt("2026-11-09", 10 * 60, LONDON),
		);
		await seedEntry(
			ada,
			instantAt("2026-11-09", 11 * 60, LONDON),
			instantAt("2026-11-09", 12 * 60, LONDON),
		);
		await seedEntry(ada, T0 - HOUR, null);

		expect(await post({ intent: "cell", projectId: site, day: "2026-11-09", hours: "1" })).toBe(
			409,
		);
		expect(await post({ intent: "cell", projectId: site, day: "2026-11-11", hours: "1" })).toBe(
			409,
		);
		expect(await countEntries()).toBe(3);
		const main = await mainOf(WEEK);
		expect(main).toMatch(/aria-label="Site, Monday 9 November: 2:00. Change it in the Day view"/);
		expect(main).toMatch(
			/aria-label="Site, Wednesday 11 November: 1:00, running. Change it in the Day view"/,
		);
		expect(main).toContain('href="/app/acme?day=2026-11-09"');
	});

	it("offers Copy last week's rows when the week before has time, and copies no hours", async () => {
		await seedEntry(
			ada,
			instantAt("2026-11-03", 9 * 60, LONDON),
			instantAt("2026-11-03", 12 * 60, LONDON),
		);
		const main = await mainOf(WEEK);

		expect(main).toContain("Copy last week&#x27;s rows");
		expect(await textAt(WEEK)).toMatch(/Week total 0:00/);
		// The rows it adds are the browser's until hours are typed; the grid sheet
		// gives them empty cells (test/timesheet/sheets.test.ts).
	});

	it("shows Not submitted and Submit week in its header", async () => {
		clockAt(T0);
		const text = await textAt(WEEK);
		expect(text).toContain("Status: Not submitted");
		expect(text).toContain("Submit week");
	});
});

describe("entries by hand (TS-012b)", () => {
	const fields = (entryId: string, more: Record<string, string> = {}) => ({
		intent: "edit",
		entryId,
		projectId: site,
		date: "2026-11-10",
		start: "09:00",
		end: "10:30",
		description: "Survey",
		...more,
	});
	const anEntry = () =>
		seedEntry(
			ada,
			instantAt("2026-11-10", 13 * 60, LONDON),
			instantAt("2026-11-10", 14 * 60, LONDON),
		);

	it("are changed and deleted by their person, read in their zone", async () => {
		const id = await anEntry();
		expect(await post(fields(id))).toBe(200);
		expect((await entries()).results[0]).toMatchObject({
			startedAt: Date.parse("2026-11-10T09:00:00Z"),
			endedAt: Date.parse("2026-11-10T10:30:00Z"),
			description: "Survey",
		});

		await setZone(ada, "Pacific/Auckland");
		expect(await post(fields(id, { start: "08:00", end: "09:00" }))).toBe(200);
		expect((await entries()).results[0]?.startedAt).toBe(Date.parse("2026-11-09T19:00:00Z"));

		expect(await post({ intent: "delete", entryId: id })).toBe(200);
		expect(await countEntries()).toBe(0);
	});

	it("are no longer added with a start and an end: the intent is refused with 400", async () => {
		expect(await post({ ...fields("x"), intent: "add" })).toBe(400);
		expect(await countEntries()).toBe(0);
	});

	it("refuses an end before its start, and a time the clocks skip", async () => {
		const id = await anEntry();
		expect(await post(fields(id, { start: "10:00", end: "09:00" }))).toBe(400);
		expect(await post(fields(id, { start: "10:00", end: "10:00" }))).toBe(400);
		expect(await post(fields(id, { date: "2026-03-29", start: "01:30", end: "03:00" }))).toBe(400);
		expect((await entries()).results[0]?.startedAt).toBe(instantAt("2026-11-10", 13 * 60, LONDON));
	});

	it.each(["owner", "admin", "member"] as const)(
		"cannot be changed or deleted by an %s whose they are not",
		async (role) => {
			const linus = await memberOfAcme("member", "linus@example.com");
			const id = await seedEntry(linus, T0 - 2 * HOUR, T0 - HOUR, { description: "Mine" });
			const who = role === "owner" ? ada : await memberOfAcme(role, `${role}@example.com`);

			expect(await post(fields(id), who)).toBe(404);
			expect(await post({ intent: "delete", entryId: id }, who)).toBe(404);
			expect((await entries()).results).toEqual([
				expect.objectContaining({ id, description: "Mine", startedAt: T0 - 2 * HOUR }),
			]);
		},
	);

	it("are refused on an archived project, and a running entry is left to the timer", async () => {
		const old = await seedProject(acme.id, "Old", true);
		const id = await anEntry();
		expect(await post(fields(id, { projectId: old }))).toBe(400);
		const running = await seedEntry(ada, T0, null);
		expect(await post({ intent: "delete", entryId: running })).toBe(409);
		expect(await countEntries()).toBe(2);
	});
});

describe("submitting a week (TS-046)", () => {
	const WEEK = `${PAGE}?view=week&start=2026-11-09`;
	const status = () => value<string>("select status from periods where user_id = ?", ada.user.id);
	const events = async () =>
		(
			await env.DB.prepare(
				"select action, actor_id as actor from period_events order by rowid",
			).all<{
				action: string;
				actor: string;
			}>()
		).results;

	beforeEach(() => {
		clockAt(T0);
	});

	it("locks its entries once submitted, until it is withdrawn; both steps are recorded", async () => {
		const id = await seedEntry(
			ada,
			instantAt("2026-11-10", 9 * 60, LONDON),
			instantAt("2026-11-10", 10 * 60, LONDON),
		);
		expect(await post({ intent: "submit", startsOn: "2026-11-09" })).toBe(200);
		expect(await status()).toBe("submitted");
		expect(await textAt(WEEK)).toContain("Status: Submitted");

		expect(await post({ intent: "delete", entryId: id })).toBe(409);
		expect(await post({ intent: "cell", projectId: site, day: "2026-11-10", hours: "3" })).toBe(
			409,
		);
		expect(await post(track({ projectId: site, day: "2026-11-12", hours: "1" }))).toBe(409);
		expect(await post(track({ projectId: site }))).toBe(409);
		expect(await post({ intent: "submit", startsOn: "2026-11-09" })).toBe(409);
		expect(await countEntries()).toBe(1);

		expect(await post({ intent: "withdraw", startsOn: "2026-11-09" })).toBe(200);
		expect(await status()).toBe("withdrawn");
		expect(await post({ intent: "delete", entryId: id })).toBe(200);
		expect(await events()).toEqual([
			{ action: "submitted", actor: ada.user.id },
			{ action: "withdrawn", actor: ada.user.id },
		]);
	});

	it("cannot be withdrawn once decided", async () => {
		await post({ intent: "submit", startsOn: "2026-11-09" });
		await env.DB.prepare("update periods set status = 'approved'").run();

		expect(await post({ intent: "withdraw", startsOn: "2026-11-09" })).toBe(409);
		expect(await textAt(WEEK)).toContain("Status: Approved");
		expect(await post({ intent: "cell", projectId: site, day: "2026-11-10", hours: "3" })).toBe(
			409,
		);
	});

	it("a returned week shows the reason, can be corrected and submitted again", async () => {
		await post({ intent: "submit", startsOn: "2026-11-09" });
		await env.DB.prepare("update periods set status = 'returned', comment = 'Add Friday'").run();

		const text = await textAt(WEEK);
		expect(text).toContain("Status: Returned");
		expect(text).toContain("Returned: Add Friday");
		expect(await post({ intent: "cell", projectId: site, day: "2026-11-10", hours: "4" })).toBe(
			200,
		);
		expect(await post({ intent: "submit", startsOn: "2026-11-09" })).toBe(200);
		expect(await status()).toBe("submitted");
	});

	it("refuses a week that has not begun, and one with a timer running in it", async () => {
		expect(await post({ intent: "submit", startsOn: "2026-11-16" })).toBe(409);
		await post(track({ projectId: site }));
		expect(await post({ intent: "submit", startsOn: "2026-11-09" })).toBe(409);
		expect(await value("select count(*) from periods")).toBe(0);
	});
});

describe("History (TS-046)", () => {
	it("lists each period with its status and total, newest first, each opening its week", async () => {
		clockAt(T0);
		await seedEntry(
			ada,
			instantAt("2026-10-27", 9 * 60, LONDON),
			instantAt("2026-10-27", 11 * 60, LONDON),
		);
		await env.DB.prepare(
			"insert into periods (id, organisation_id, user_id, starts_on, ends_on, status, submitted_at, comment, created_at, updated_at) values (?, ?, ?, '2026-10-26', '2026-11-01', 'approved', 0, null, 0, 0), (?, ?, ?, '2026-11-02', '2026-11-08', 'returned', 0, 'Add Friday', 0, 0)",
		)
			.bind(uuidv7(), acme.id, ada.user.id, uuidv7(), acme.id, ada.user.id)
			.run();
		const main = await mainOf(`${PAGE}?view=history`);
		const text = textOf(main);

		expect(text).toMatch(/9–15 November 2026 Not submitted 0:00/);
		expect(text).toMatch(/2–8 November 2026 Returned Reason: Add Friday 0:00/);
		expect(text).toMatch(/26 October – 1 November 2026 Approved 2:00/);
		expect(main).toContain('href="/app/acme?view=week&amp;start=2026-10-26"');
	});

	it("shows nobody else's periods", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");
		await env.DB.prepare(
			"insert into periods (id, organisation_id, user_id, starts_on, ends_on, status, submitted_at, created_at, updated_at) values (?, ?, ?, '2026-11-02', '2026-11-08', 'approved', 0, 0, 0)",
		)
			.bind(uuidv7(), acme.id, linus.user.id)
			.run();
		clockAt(T0);
		expect(await textAt(`${PAGE}?view=history`)).not.toContain("Approved");
	});
});

describe("Track time (TS-056)", () => {
	it("is the Day view's one primary action: its one filled button, and no Add entry", async () => {
		clockAt(T0);
		await seedEntry(
			ada,
			instantAt("2026-11-10", 9 * 60, LONDON),
			instantAt("2026-11-10", 10 * 60, LONDON),
		);
		const main = await mainOf(`${PAGE}?day=2026-11-11`);
		const filled = [
			...main.matchAll(
				/<button\b[^>]*class="[^"]*\bover-primary\b[^"]*"[^>]*>([\s\S]*?)<\/button>/g,
			),
		].map(([, label]) => textOf(label ?? ""));

		expect(filled).toEqual(["Track time"]);
		expect(main).toMatch(/>Submit week<\/button>/);
		expect(main).not.toContain("Add entry");
		expect(main).not.toContain(">Start timer</button>");
	});

	it("is where Track time in the navigation leads: today's Day view, at Track time", async () => {
		clockAt(T0);
		const html = await pageBody(await open("/app/acme/projects", ada));
		const nav = /<nav aria-label="Main"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
		expect(nav).toMatch(/<a[^>]*href="\/app\/acme#timer"[^>]*>[\s\S]*?Track time/);
		expect(await mainOf(PAGE)).toMatch(/<section id="timer"[\s\S]*?>Track time<\/button>/);
	});

	it("with no hours starts the timer at the server's clock", async () => {
		clockAt(T0);
		expect(await post(track({ projectId: site, description: "Plans", hours: " " }))).toBe(200);
		expect((await entries()).results).toEqual([
			expect.objectContaining({
				projectId: site,
				description: "Plans",
				startedAt: T0,
				endedAt: null,
			}),
		]);
	});

	it.each(["1.5", "1,5", "1:30"])(
		"with hours %s saves one entry of 90 minutes on the day shown, where gridEntryStart places it",
		async (hours) => {
			clockAt(T0);
			const day = "2026-11-09";
			expect(await post(track({ projectId: site, day, hours, description: "Survey" }))).toBe(200);
			const first = gridEntryStart(day, LONDON, [], T0);
			expect((await entries()).results).toEqual([
				expect.objectContaining({
					userId: ada.user.id,
					projectId: site,
					description: "Survey",
					startedAt: first,
					endedAt: first + 90 * MINUTE,
				}),
			]);

			expect(await post(track({ projectId: site, day, hours: "1" }))).toBe(200);
			const second = gridEntryStart(
				day,
				LONDON,
				[{ startedAt: first, endedAt: first + 90 * MINUTE }],
				T0,
			);
			expect(second).toBe(first + 90 * MINUTE);
			expect((await entries()).results.map((e) => [e.startedAt, e.endedAt])).toEqual([
				[first, first + 90 * MINUTE],
				[second, second + HOUR],
			]);
		},
	);

	it("asks for hours on a day other than today, and refuses hours that are not hours or none", async () => {
		clockAt(T0);
		for (const hours of ["", "0", "0:00", "lots", "25", "1.5.5"]) {
			expect(await post(track({ projectId: site, day: "2026-11-09", hours })), hours).toBe(400);
		}
		expect(await post(track({ projectId: site, hours: "0" }))).toBe(400);
		expect(await post(track({ projectId: site, day: "11 November", hours: "1" }))).toBe(400);
		expect(await countEntries()).toBe(0);
	});

	it("refuses an archived project and another organisation's, with hours and without", async () => {
		const archived = await seedProject(acme.id, "Old", true);
		const grace = await person(mailbox, "grace@example.com");
		const theirs = await seedProject(
			(await createOrganisation(grace.cookie, "Initech")).id,
			"Theirs",
		);
		clockAt(T0);

		for (const projectId of [archived, theirs]) {
			expect(await post(track({ projectId })), projectId).toBe(400);
			expect(await post(track({ projectId, day: "2026-11-09", hours: "1" })), projectId).toBe(400);
		}
		expect(await countEntries()).toBe(0);
	});

	it("is refused on a locked day, with hours and without, and a locked day does not offer it", async () => {
		clockAt(T0);
		await seedEntry(
			ada,
			instantAt("2026-11-09", 9 * 60, LONDON),
			instantAt("2026-11-09", 10 * 60, LONDON),
		);
		expect(await post({ intent: "submit", startsOn: "2026-11-09" })).toBe(200);

		expect(await post(track({ projectId: site, day: "2026-11-10", hours: "1" }))).toBe(409);
		expect(await post(track({ projectId: site }))).toBe(409);
		expect(await countEntries()).toBe(1);
		const main = await mainOf(`${PAGE}?day=2026-11-10`);
		expect(main).not.toContain(">Track time</button>");
		expect(textOf(main)).toContain("so nothing can be tracked or changed on it");

		// The week after is not locked. Hours are tracked on a day that has begun
		// (TS-091, W08), so the clock moves into it.
		clockAt(instantAt("2026-11-16", 18 * 60, LONDON));
		expect(await post(track({ projectId: site, day: "2026-11-16", hours: "1" }))).toBe(200);
	});
});

describe("the week's days above the day (TS-056)", () => {
	/** The links of the period's days on the Day view of `day`: each day, its total, and whether it is marked. */
	async function weekDays(day: string) {
		const main = await mainOf(`${PAGE}?day=${day}`);
		const group =
			/<legend[^>]*>Days of the week<\/legend>([\s\S]*?)<\/fieldset>/.exec(main)?.[1] ?? "";
		return {
			main,
			days: [...group.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(
				([, attributes = "", inner = ""]) => ({
					day: /href="\/app\/acme\?day=([\d-]+)"/.exec(attributes)?.[1],
					// The day's total is its last duration: a day off, a holiday or leave is named after it (TS-061).
					total: textOf(inner)
						.match(/\d+:\d\d/g)
						?.at(-1),
					away:
						/<span class="sr-only">, <\/span><span aria-hidden="true">[^<]*<\/span><span class="sr-only">([^<]+)<\/span>/.exec(
							inner,
						)?.[1] ?? null,
					shown: /aria-current="date"/.test(attributes),
				}),
			),
		};
	}

	it("links each of the period's seven days with its total, marks the day shown, and adds them up as the Week view does", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");
		clockAt(T0);
		const ops = await seedProject(acme.id, "Ops", true);
		await seedEntry(
			ada,
			instantAt("2026-11-09", 9 * 60, LONDON),
			instantAt("2026-11-09", 11 * 60, LONDON),
		);
		await seedEntry(
			ada,
			instantAt("2026-11-10", 23 * 60 + 30, LONDON),
			instantAt("2026-11-11", 30, LONDON),
		);
		await seedEntry(ada, T0 - 45 * MINUTE, null);
		await seedEntry(
			ada,
			instantAt("2026-11-15", 9 * 60, LONDON),
			instantAt("2026-11-15", 10 * 60, LONDON),
			{ project: ops },
		);
		// The day before the period, and another person's time, count for nothing here.
		await seedEntry(
			ada,
			instantAt("2026-11-08", 9 * 60, LONDON),
			instantAt("2026-11-08", 10 * 60, LONDON),
		);
		await seedEntry(linus, T0 - 3 * HOUR, T0 - HOUR);

		const { main, days } = await weekDays("2026-11-11");
		expect(days).toEqual(
			[0, 1, 2, 3, 4, 5, 6].map((step) => ({
				day: addDays("2026-11-09", step),
				total: ["2:00", "1:00", "0:45", "0:00", "0:00", "0:00", "1:00"][step],
				away: step < 5 ? null : "Not a working day",
				shown: step === 2,
			})),
		);
		expect(textOf(main)).toContain("Week total 4:45");

		const week = await textAt(`${PAGE}?view=week&start=2026-11-09`);
		const [, dayTotals = "", weekTotal] =
			/Day total ((?:\d+:\d\d ){7})Week total (\d+:\d\d)/.exec(week) ?? [];
		expect(days.map((each) => each.total)).toEqual(dayTotals.trim().split(" "));
		expect(weekTotal).toBe("4:45");

		const sunday = await weekDays("2026-11-15");
		expect(sunday.days.filter((each) => each.shown).map((each) => each.day)).toEqual([
			"2026-11-15",
		]);
		expect(sunday.days.map((each) => each.total)).toEqual(days.map((each) => each.total));
	});

	it("follows the organisation's week start", async () => {
		await env.DB.prepare("update organisations set week_starts_on = 7").run();
		const { days } = await weekDays("2026-11-11");
		expect(days.map((each) => each.day)).toEqual(
			[0, 1, 2, 3, 4, 5, 6].map((step) => addDays("2026-11-08", step)),
		);
	});
});

describe("the Day view's foot (TS-056)", () => {
	const DAY = `${PAGE}?day=2026-11-10`;

	beforeEach(() => {
		clockAt(T0);
	});

	it("shows the period and its status, and Submit week, whose submission both views then show", async () => {
		await seedEntry(
			ada,
			instantAt("2026-11-10", 9 * 60, LONDON),
			instantAt("2026-11-10", 10 * 60, LONDON),
		);
		const before = await mainOf(DAY);
		expect(textOf(before)).toMatch(/9–15 November 2026 Status: Not submitted/);
		expect(before.match(/>Submit week<\/button>/g)).toHaveLength(1);

		// The Week view's own action, for the period the day is in.
		expect(await post({ intent: "submit", startsOn: "2026-11-09" })).toBe(200);
		const after = await mainOf(DAY);
		expect(textOf(after)).toMatch(/9–15 November 2026 Status: Submitted/);
		expect(after).toMatch(/>Withdraw submission<\/button>/);
		expect(after).not.toContain(">Submit week</button>");
		expect(await textAt(`${PAGE}?view=week&start=2026-11-09`)).toContain("Status: Submitted");
	});

	it("says why a week was returned, and why a week cannot be submitted yet", async () => {
		await env.DB.prepare(
			"insert into periods (id, organisation_id, user_id, starts_on, ends_on, status, submitted_at, comment, created_at, updated_at) values (?, ?, ?, '2026-11-09', '2026-11-15', 'returned', 0, 'Add Friday', 0, 0)",
		)
			.bind(uuidv7(), acme.id, ada.user.id)
			.run();
		const returned = textOf(await mainOf(DAY));
		expect(returned).toContain("Status: Returned");
		expect(returned).toContain("Returned: Add Friday");
		expect(returned).toContain("Submit week");

		const toCome = await mainOf(`${PAGE}?day=2026-11-17`);
		expect(textOf(toCome)).toContain("This week can be submitted once it has begun.");
		expect(toCome).not.toContain(">Submit week</button>");

		await seedEntry(ada, T0 - HOUR, null);
		const running = await mainOf(DAY);
		expect(textOf(running)).toContain("Stop the timer before you submit the week.");
		expect(running).not.toContain(">Submit week</button>");
	});
});

describe("getting started (TS-056)", () => {
	const WEEK = `${PAGE}?view=week&start=2026-11-09`;

	/** The list as a person reads it on the Day view, or null when it is not there. */
	async function gettingStarted(who: Person = ada) {
		const main = await mainOf(PAGE, who);
		const section =
			/<section[^>]*aria-labelledby="getting-started-heading"[\s\S]*?<\/section>/.exec(main)?.[0];
		return section === undefined ? null : section;
	}

	/** The getting-started cookie a response sets, as `name=value`, or null. */
	function cookieSet(response: Response) {
		const set = response.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith(`${GETTING_STARTED_COOKIE}=`));
		return set ?? null;
	}

	const pairOf = (set: string | null) => set?.split(";")[0] ?? "";

	/** `who` in a browser that also holds the cookie `pair`. */
	const withCookie = (who: Person, pair: string): Person => ({
		...who,
		cookie: `${who.cookie}; ${pair}`,
	});

	it("counts its three steps, each a link until the database shows it done", async () => {
		await env.DB.prepare("update projects set archived_at = 1").run();
		const none = (await gettingStarted()) ?? "";
		expect(textOf(none)).toBe(
			"Getting started 0 of 3 Add a project Track an entry Open the week Put away",
		);
		const links = [...none.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)];
		expect(links.map(([, href, label]) => [href, textOf(label ?? "")])).toEqual([
			["/app/acme/projects", "Add a project"],
			["/app/acme#timer", "Track an entry"],
			["/app/acme?view=week", "Open the week"],
		]);

		// Any active project ticks the first.
		await env.DB.prepare("update projects set archived_at = null").run();
		expect(textOf((await gettingStarted()) ?? "")).toContain("1 of 3 Add a project (done)");

		// Another person's entry ticks nothing of Ada's; her own ticks the second.
		const linus = await memberOfAcme("member", "linus@example.com");
		await seedEntry(linus, T0 - HOUR, T0);
		expect(textOf((await gettingStarted()) ?? "")).toContain("1 of 3");
		expect(textOf((await gettingStarted(linus)) ?? "")).toContain("2 of 3");
		await seedEntry(ada, T0 - HOUR, null);
		expect(textOf((await gettingStarted()) ?? "")).toContain(
			"2 of 3 Add a project (done) Track an entry (done) Open the week Put away",
		);
	});

	it("ticks Open the week once the person has opened the Week view, in their own name", async () => {
		const opened = await open(WEEK, ada);
		const set = cookieSet(opened);
		expect(set).toBe(
			`${GETTING_STARTED_COOKIE}=w:${ada.user.id}; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=Lax`,
		);
		// A move to the Week view by script sets it too.
		expect(cookieSet(await openData(WEEK, ada))).toBe(set);

		const browser = withCookie(ada, pairOf(set));
		expect(textOf((await gettingStarted(browser)) ?? "")).toContain("Open the week (done)");
		// Opened again, the mark is already there.
		expect(cookieSet(await open(WEEK, browser))).toBeNull();
		// The Day view sets nothing.
		expect(cookieSet(await open(PAGE, ada))).toBeNull();

		// Linus, signed in on the same browser, has not opened the week.
		const linus = await memberOfAcme("member", "linus@example.com");
		expect(textOf((await gettingStarted(withCookie(linus, pairOf(set)))) ?? "")).not.toContain(
			"(done) Put away",
		);
		// A value that is not a mark ticks nothing.
		for (const value of [`w:${ada.user.id}x"`, `x:${ada.user.id}`, `w:${ada.user.id}<`, "w:"]) {
			const forged = withCookie(ada, `${GETTING_STARTED_COOKIE}=${value}`);
			expect(textOf((await gettingStarted(forged)) ?? ""), value).toContain(
				"Open the week Put away",
			);
		}
	});

	it("Put away hides it for that person alone, and keeps their other marks", async () => {
		const week = pairOf(cookieSet(await open(WEEK, ada)));
		const response = await submit(ACTION, { intent: "put-away" }, withCookie(ada, week), {
			byScript: true,
		});
		expect(response.status).toBe(200);
		const both = pairOf(cookieSet(response));
		expect(both).toBe(`${GETTING_STARTED_COOKIE}=a:${ada.user.id}.w:${ada.user.id}`);

		expect(await gettingStarted(withCookie(ada, both))).toBeNull();
		const linus = await memberOfAcme("member", "linus@example.com");
		expect(await gettingStarted(withCookie(linus, both))).not.toBeNull();
		// Ada's marks stay beside Linus's when he puts it away too.
		const his = await submit(ACTION, { intent: "put-away" }, withCookie(linus, both), {
			byScript: true,
		});
		expect(pairOf(cookieSet(his))).toBe(
			`${GETTING_STARTED_COOKIE}=a:${linus.user.id}.a:${ada.user.id}.w:${ada.user.id}`,
		);
	});

	it("is gone once all three steps are done", async () => {
		const week = pairOf(cookieSet(await open(WEEK, ada)));
		expect(await gettingStarted(withCookie(ada, week))).not.toBeNull();
		await seedEntry(ada, T0 - HOUR, T0);
		expect(await gettingStarted(withCookie(ada, week))).toBeNull();
	});
});

describe("the Calendar view (TS-062)", () => {
	const WEEK = `${PAGE}?view=calendar&date=2026-11-11`;
	const MONTH = `${PAGE}?view=calendar&scale=month&date=2026-11-11`;

	beforeEach(async () => {
		clockAt(T0);
		await seedEntry(
			ada,
			instantAt("2026-11-09", 9 * 60, LONDON),
			instantAt("2026-11-09", 11 * 60, LONDON),
			{ description: "Plans" },
		);
		// From 23:30 on the Tuesday to 00:30 on the Wednesday: an hour of the Tuesday's.
		await seedEntry(
			ada,
			instantAt("2026-11-10", 23 * 60 + 30, LONDON),
			instantAt("2026-11-11", 30, LONDON),
		);
	});

	it("shows the week's days with the Week view's totals, and each entry as a block", async () => {
		const text = await textAt(WEEK);
		expect(text).toMatch(/Week total 3:00/);
		expect(text).toMatch(/Mon 9 Monday 9 November, 2:00 tracked/);
		expect(text).toMatch(/Tue 10 Tuesday 10 November, 1:00 tracked/);
		expect(text).toMatch(/Today, Wednesday 11 November, 0:00 tracked/);
		expect(text).toContain("Plans, Site, 09:00–11:00, 2:00, edit");
		expect(text).toContain("continued from the day before");
		expect(await textAt(`${PAGE}?view=week&start=2026-11-09`)).toMatch(/Week total 3:00/);
	});

	it("shows the month's days, the weeks' totals and the month's", async () => {
		const text = await textAt(MONTH);
		expect(text).toContain("November 2026");
		expect(text).toMatch(/Month total 3:00/);
		expect(text).toContain("Monday 9 November, 2:00");
		expect(text).toContain("Week of 9 November, 3:00");
		expect(text).toContain("Week of 26 October, 0:00");
		// The day as leave sees it (TS-061), in the place each day keeps for it.
		expect(text).toContain("Saturday 14 November, 0:00, Not a working day");
	});

	it("offers a free slot as a new entry, and marks the days of a submitted week, which offer none", async () => {
		expect(await mainOf(WEEK)).toContain("New entry, Monday 9 November, from 12:00");
		expect(await post({ intent: "submit", startsOn: "2026-11-09" })).toBe(200);
		const main = await mainOf(WEEK);
		expect(textOf(main)).toContain("Submitted");
		expect(main).not.toContain("New entry, Monday 9 November");
		expect(await textAt(MONTH)).toContain("Monday 9 November, 2:00, submitted");
	});

	it("answers an address it cannot read with 400", async () => {
		for (const query of ["scale=year", "zoom=huge", "scale=month&zoom=compact"]) {
			expect((await open(`${PAGE}?view=calendar&${query}`, ada)).status, query).toBe(400);
		}
	});

	it("tracks time from a slot: the entry starts at the time chosen, in the person's zone", async () => {
		// A day that has passed: hours never run past now (TS-091, W08).
		expect(
			await post(track({ projectId: site, day: "2026-11-10", start: "14:30", hours: "1.5" })),
		).toBe(200);
		const start = instantAt("2026-11-10", 14 * 60 + 30, LONDON);
		const added = (await entries()).results.find((entry) => entry.startedAt === start);
		expect(added?.endedAt).toBe(instantAt("2026-11-10", 16 * 60, LONDON));
	});

	it("keeps the slot's start, and refuses hours that would cross midnight or end after now (TS-091, W08)", async () => {
		const before = await countEntries();
		expect(
			await post(track({ projectId: site, day: "2026-11-10", start: "23:00", hours: "2" })),
		).toBe(400);
		expect(
			await post(track({ projectId: site, day: "2026-11-12", start: "14:30", hours: "1" })),
		).toBe(400);
		expect(await countEntries()).toBe(before);
	});

	it("asks for the hours from a slot, and refuses a time the clocks skip, storing nothing", async () => {
		const before = await countEntries();
		expect(await post(track({ projectId: site, start: "14:30" }))).toBe(400);
		expect(
			await post(track({ projectId: site, day: "2026-03-29", start: "01:30", hours: "1" })),
		).toBe(400);
		expect(await post(track({ projectId: site, start: "25:00", hours: "1" }))).toBe(400);
		expect(await countEntries()).toBe(before);
	});
});

describe("an error while starting", () => {
	it("logs the error's name and the path alone, never the description", async () => {
		const lines: string[] = [];
		for (const level of ["debug", "log", "info", "warn", "error"] as const) {
			vi.spyOn(console, level).mockImplementation((...parts: unknown[]) => {
				lines.push(parts.map(String).join(" "));
			});
		}
		await env.DB.exec("drop table period_events");
		await env.DB.exec("drop table periods");

		const status = await post(track({ projectId: site, description: "Secret plans" }));

		expect(status).toBe(500);
		expect(lines.join("\n")).not.toContain("Secret plans");
		expect(lines.filter((line) => line.startsWith("error: "))).toEqual([
			"error: Error at /app/:organisation.data",
		]);
	});
});

describe("days not worked (TS-061)", () => {
	it("names a public holiday and a day the week does not work, with the time expected on each", async () => {
		clockAt(T0);
		await seedHoliday(acme.id, "2026-12-25", "Christmas Day");

		// Track time's warning on such a day is drawn only once its sheet opens, which no page test does.
		expect(await textAt(`${PAGE}?day=2026-12-25`)).toContain("Christmas Day. 0:00 expected.");
		expect(await textAt(`${PAGE}?day=2026-12-26`)).toContain("Not a working day. 0:00 expected.");
		const eve = await textAt(`${PAGE}?day=2026-12-24`);
		expect(eve).toContain("7:30 expected.");
		// The days above name Christmas Day; the line of Christmas Eve itself names nothing.
		expect(eve).not.toContain("Christmas Day. ");
	});

	it("names approved leave on its days, half a day expecting half the time, and leave not approved nowhere", async () => {
		clockAt(T0);
		await seedLeave(acme.id, ada.user.id, "annual", "2026-11-12", "2026-11-12");
		await seedLeave(acme.id, ada.user.id, "annual", "2026-11-13", "2026-11-13", {
			startsHalf: true,
		});
		await seedLeave(acme.id, ada.user.id, "study", "2026-11-10", "2026-11-10", {
			status: "pending",
		});

		expect(await textAt(`${PAGE}?day=2026-11-12`)).toContain("Annual leave. 0:00 expected.");
		expect(await textAt(`${PAGE}?day=2026-11-13`)).toContain(
			"Annual leave (half day). 3:45 expected.",
		);
		const pending = await textAt(`${PAGE}?day=2026-11-10`);
		expect(pending).toContain("7:30 expected.");
		expect(pending).not.toContain("Study leave");
		// The week's total says what the week expects.
		expect(pending).toContain("Week total 0:00 of 26:15 expected");

		// The days above the day mark them, by name to a screen reader.
		const strip = await mainOf(`${PAGE}?day=2026-11-11`);
		expect(strip).toContain('<span class="sr-only">Annual leave</span>');
		expect(strip).toContain('<span class="sr-only">Annual leave (half day)</span>');
		expect(strip).toContain('<span class="sr-only">Not a working day</span>');
		expect(strip).not.toContain('<span class="sr-only">Study leave</span>');

		// The Week view marks each day and adds a row of the time expected.
		const week = await textAt(`${PAGE}?view=week&start=2026-11-09`);
		expect(week).toMatch(
			/Annual leave .*Annual leave \(half day\) .*Not a working day .*Not a working day/,
		);
		expect(week).toContain("Expected 7:30 7:30 7:30 0:00 3:45 0:00 0:00 Week expected 26:15");
	});

	it("a working week that works Sundays expects 7:30 on the day the clocks go back", async () => {
		clockAt(Date.parse("2026-10-25T12:00:00Z"));
		await env.DB.prepare("update working_days set minutes = 450 where organisation_id = ?")
			.bind(acme.id)
			.run();
		expect(await textAt(`${PAGE}?day=2026-10-25`)).toContain("7:30 expected.");
		expect(await textAt(`${PAGE}?view=week&start=2026-10-19`)).toContain(
			"Expected 7:30 7:30 7:30 7:30 7:30 7:30 7:30 Week expected 52:30",
		);
	});
});
