import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "~/db";
import { instantAt } from "~/time/calendar";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, type Role, seedMembership, value } from "../organisations/harness";
import { open, openData, type Person, pageBody, person, submit, textOf } from "./harness";

// Timesheet, /app/<slug>: the timer (TS-012a), the Day and Week views
// (TS-013), entries by hand (TS-012b), the week's grid (TS-052), a week's
// submission and History (TS-046), and the timer in the navigation (TS-051).
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
		expect(
			await post({ intent: "start", projectId: site, description: "Plans", startedAt: "0" }),
		).toBe(200);

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
			expect(await post({ intent: "start", projectId }), projectId).toBe(400);
		}
		expect(await post({ intent: "start" })).toBe(400);
		expect(await countEntries()).toBe(0);
	});

	it("stores a description of 500 characters and refuses one of 501 with 400", async () => {
		expect(await post({ intent: "start", projectId: site, description: "x".repeat(501) })).toBe(
			400,
		);
		expect(await countEntries()).toBe(0);
		expect(await post({ intent: "start", projectId: site, description: "x".repeat(500) })).toBe(
			200,
		);
		expect((await entries()).results[0]?.description).toHaveLength(500);
	});

	it("stops the caller's running entry at the server's clock, and with nothing running changes nothing", async () => {
		clockAt(T0);
		expect(await post({ intent: "stop" })).toBe(200);
		expect(await countEntries()).toBe(0);

		await post({ intent: "start", projectId: site });
		clockAt(T0 + 25 * MINUTE);
		expect(await post({ intent: "stop", entryId: "ignored" })).toBe(200);
		expect((await entries()).results[0]?.endedAt).toBe(T0 + 25 * MINUTE);
	});

	it("starting while one runs stops the first at the second's start", async () => {
		clockAt(T0);
		await post({ intent: "start", projectId: site });
		clockAt(T0 + HOUR);
		await post({ intent: "start", projectId: site });

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
		expect(main).not.toContain(">Start timer</button>");
		const timer = /<section id="timer"[\s\S]*?<\/section>/.exec(main)?.[0] ?? "";
		const links = [...timer.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)];
		expect(links.map(([, href, label]) => [href, textOf(label ?? "")])).toEqual([
			["/app/acme/projects", "Create a project"],
		]);
	});

	it("with a project shows the active projects to choose from and one button, Start timer", async () => {
		await seedProject(acme.id, "Old", true);
		const main = await mainOf(PAGE);

		expect(main.match(/>Start timer<\/button>/g)).toHaveLength(1);
		expect(main).toMatch(new RegExp(`<option value="${site}"[^>]*>Site</option>`));
		expect(main).not.toContain(">Old</option>");
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

		expect(await post({ intent: "start", projectId: site }, grace)).toBe(404);
		expect(await post({ intent: "stop" }, grace)).toBe(404);
		expect((await entries()).results.map((e) => e.endedAt)).toEqual([null]);
	});

	it("lets a person run one timer in each of two organisations", async () => {
		const globex = await createOrganisation(ada.cookie, "Globex");
		const theirs = await seedProject(globex.id, "Theirs");
		await post({ intent: "start", projectId: site });
		const response = await submit(
			"/app/globex?index",
			{ intent: "start", projectId: theirs },
			ada,
			{ byScript: true },
		);

		expect(response.status).toBe(200);
		expect(await value("select count(*) from time_entries where ended_at is null")).toBe(2);
	});
});

describe("the timer in the navigation (TS-051)", () => {
	it("shows the running project, the elapsed time and Stop on every page", async () => {
		clockAt(T0);
		await post({ intent: "start", projectId: site });
		clockAt(T0 + 65 * MINUTE + 5_000);

		for (const path of [PAGE, "/app/acme/projects", "/app/acme/account", "/app/acme/reports"]) {
			const html = await pageBody(await open(path, ada));
			const nav = /<nav aria-label="Main"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
			const timer = textOf(nav.slice(0, nav.indexOf("<ul")));
			expect(timer, path).toContain("Site");
			expect(timer, path).toContain("1:05:05");
			expect(nav, path).toMatch(/<button[^>]*aria-label="Stop timer for Site"[^>]*>Stop<\/button>/);
			expect(nav, path).not.toContain("Start timer");
		}
	});

	it("stops through the Timesheet's stop, from any page", async () => {
		await post({ intent: "start", projectId: site });
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
		expect(main.match(/<button[^>]*>Start timer<\/button>/g)).toHaveLength(1);
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

	it("shows Not submitted in its header, and Submit week at its foot", async () => {
		clockAt(T0);
		const text = await textAt(WEEK);
		expect(text).toContain("Status: Not submitted");
		expect(text).toContain("Submit week");
	});
});

describe("entries by hand (TS-012b)", () => {
	const fields = (more: Record<string, string> = {}) => ({
		intent: "add",
		projectId: site,
		date: "2026-11-10",
		start: "09:00",
		end: "10:30",
		description: "Survey",
		...more,
	});

	it("are added, changed and deleted by their person, read in their zone", async () => {
		expect(await post(fields())).toBe(200);
		const [added] = (await entries()).results;
		expect(added).toMatchObject({
			startedAt: Date.parse("2026-11-10T09:00:00Z"),
			endedAt: Date.parse("2026-11-10T10:30:00Z"),
			description: "Survey",
		});

		await setZone(ada, "Pacific/Auckland");
		expect(
			await post({
				...fields({ intent: "edit", start: "08:00", end: "09:00" }),
				entryId: added?.id ?? "",
			}),
		).toBe(200);
		expect((await entries()).results[0]?.startedAt).toBe(Date.parse("2026-11-09T19:00:00Z"));

		expect(await post({ intent: "delete", entryId: added?.id ?? "" })).toBe(200);
		expect(await countEntries()).toBe(0);
	});

	it("refuses an end before its start, and a time the clocks skip", async () => {
		expect(await post(fields({ start: "10:00", end: "09:00" }))).toBe(400);
		expect(await post(fields({ start: "10:00", end: "10:00" }))).toBe(400);
		expect(await post(fields({ date: "2026-03-29", start: "01:30", end: "03:00" }))).toBe(400);
		expect(await countEntries()).toBe(0);
	});

	it.each(["owner", "admin", "member"] as const)(
		"cannot be changed or deleted by an %s whose they are not",
		async (role) => {
			const linus = await memberOfAcme("member", "linus@example.com");
			const id = await seedEntry(linus, T0 - 2 * HOUR, T0 - HOUR, { description: "Mine" });
			const who = role === "owner" ? ada : await memberOfAcme(role, `${role}@example.com`);

			expect(await post({ ...fields({ intent: "edit" }), entryId: id }, who)).toBe(404);
			expect(await post({ intent: "delete", entryId: id }, who)).toBe(404);
			expect((await entries()).results).toEqual([
				expect.objectContaining({ id, description: "Mine", startedAt: T0 - 2 * HOUR }),
			]);
		},
	);

	it("are refused on an archived project, and a running entry is left to the timer", async () => {
		const old = await seedProject(acme.id, "Old", true);
		expect(await post(fields({ projectId: old }))).toBe(400);
		const running = await seedEntry(ada, T0, null);
		expect(await post({ intent: "delete", entryId: running })).toBe(409);
		expect(await countEntries()).toBe(1);
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
		expect(
			await post({
				intent: "add",
				projectId: site,
				date: "2026-11-12",
				start: "09:00",
				end: "10:00",
			}),
		).toBe(409);
		expect(await post({ intent: "start", projectId: site })).toBe(409);
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
		expect(await post({ intent: "cell", projectId: site, day: "2026-11-13", hours: "4" })).toBe(
			200,
		);
		expect(await post({ intent: "submit", startsOn: "2026-11-09" })).toBe(200);
		expect(await status()).toBe("submitted");
	});

	it("refuses a week that has not begun, and one with a timer running in it", async () => {
		expect(await post({ intent: "submit", startsOn: "2026-11-16" })).toBe(409);
		await post({ intent: "start", projectId: site });
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

		expect(text).toMatch(/9 – 15 November 2026 Not submitted 0:00/);
		expect(text).toMatch(/2 – 8 November 2026 Returned Reason: Add Friday 0:00/);
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

		const status = await post({ intent: "start", projectId: site, description: "Secret plans" });

		expect(status).toBe(500);
		expect(lines.join("\n")).not.toContain("Secret plans");
		expect(lines.filter((line) => line.startsWith("error: "))).toEqual([
			"error: Error at /app/:organisation.data",
		]);
	});
});
