import { env } from "cloudflare:workers";
import { UNSAFE_decodeViaTurboStream as decodeViaTurboStream } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "~/db";
import { type Day, instantAt } from "~/time/calendar";
import type { TimesheetData, WeekData } from "~/timesheet/timesheet.server";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, type Role, seedMembership, seedTeam } from "../organisations/harness";
import { open, openData, type Person, person, textOf } from "../pages/harness";
import { seedHoliday, seedLeave } from "../pages/leave-seed";
import { entryDay } from "../pages/periods-seed";

// A person's time shares on their Timesheet's week (TS-116, decision 78): each
// line's plan beside the time tracked on it, under its row of the grid, or
// below the grid when the line has no row. What a share plans is read from
// the person's schedule (7:30 each weekday by default) less a public holiday
// and approved leave, half for a half day. The Timesheet shows the caller's
// own week alone, whatever their role, so a manager sees their own plan there.

const PAGE = "/app/acme";
const LONDON = "Europe/London";
const HOUR = 3_600_000;
/** Wednesday 11 November 2026, 10:00 in London: the week of Monday 9 to Sunday 15. */
const T0 = Date.parse("2026-11-11T10:00:00Z");
const MONDAY = "2026-11-09";
const WEEK = `${PAGE}?view=week&start=${MONDAY}`;

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };
/** "SHOP-1 · Shop": a project with no work packages. */
let shop: string;
/** "SITE-2 · Site", whose time goes to its work packages. */
let site: string;
/** "WP2 Build" of Site. */
let build: string;
/** "WP3 Launch" of Site, with no time this week. */
let launch: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	await setZone(ada);
	shop = await seedProject("SHOP-1", "Shop");
	site = await seedProject("SITE-2", "Site");
	build = await seedWorkPackage(site, "WP2", "Build");
	launch = await seedWorkPackage(site, "WP3", "Launch");
	await seedHoliday(acme.id, "2026-11-13", "Founders' Day");
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

/** The server's clock at T0, once everyone has signed in: signing in reads the real one. */
function clockAtT0() {
	vi.spyOn(Date, "now").mockReturnValue(T0);
}

function setZone(who: Person) {
	return env.DB.prepare("update users set time_zone = ? where id = ?")
		.bind(LONDON, who.user.id)
		.run();
}

async function memberOfAcme(role: Role, email: string): Promise<Person> {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, role);
	await setZone(who);
	return who;
}

async function seedProject(code: string, name: string): Promise<string> {
	const id = uuidv7();
	await env.DB.prepare(
		"insert into projects (id, organisation_id, name, name_key, code, code_key, created_at, updated_at) values (?, ?, ?, ?, ?, ?, 0, 0)",
	)
		.bind(id, acme.id, name, name.toLowerCase(), code, code.toLowerCase())
		.run();
	return id;
}

async function seedWorkPackage(projectId: string, code: string, name: string): Promise<string> {
	const id = uuidv7();
	await env.DB.prepare(
		"insert into work_packages (id, organisation_id, project_id, code, code_key, name, created_at, updated_at) values (?, ?, ?, ?, ?, ?, 0, 0)",
	)
		.bind(id, acme.id, projectId, code, code.toLowerCase(), name)
		.run();
	return id;
}

/** A time share of `who`, open from the start of the month: `amount` in hundredths of `unit`. */
async function seedShare(
	who: Person,
	projectId: string,
	workPackageId: string | null,
	amount: number,
	unit: "days" | "hours" | "percent",
) {
	await env.DB.prepare(
		"insert into allocations (id, organisation_id, user_id, project_id, work_package_id, starts_on, ends_on, amount, unit, created_at, updated_at) values (?, ?, ?, ?, ?, '2026-11-01', null, ?, ?, 0, 0)",
	)
		.bind(uuidv7(), acme.id, who.user.id, projectId, workPackageId, amount, unit)
		.run();
}

/** A finished entry of `who` from `startHour` on `day`, London time, lasting `hours`. */
async function seedEntry(
	who: Person,
	projectId: string,
	workPackageId: string | null,
	day: Day,
	startHour: number,
	hours: number,
) {
	const startedAt = instantAt(day, startHour * 60, LONDON);
	await env.DB.prepare(
		"insert into time_entries (id, organisation_id, user_id, project_id, work_package_id, description, started_at, spent_on, ended_at, created_at, updated_at) values (?, ?, ?, ?, ?, null, ?, ?, ?, 0, 0)",
	)
		.bind(
			uuidv7(),
			acme.id,
			who.user.id,
			projectId,
			workPackageId,
			startedAt,
			await entryDay(acme.id, who.user.id, startedAt),
			startedAt + hours * HOUR,
		)
		.run();
}

/** The Week view's loader data, decoded as the browser decodes it. */
async function weekOf(who: Person): Promise<WeekData> {
	const response = await openData(WEEK, who);
	expect(response.status, who.user.email).toBe(200);
	if (!response.body) throw new Error("no body");
	const { value } = await decodeViaTurboStream(response.body, globalThis);
	const route = (value as Record<string, { data?: { data?: TimesheetData } }>)[
		"routes/app/timesheet"
	];
	const found = route?.data?.data;
	if (found?.view !== "week") throw new Error("not the Week view");
	return found;
}

/** The words of the Week view's page, as its document is first drawn. */
async function weekText(who: Person): Promise<string> {
	const response = await open(WEEK, who);
	expect(response.status, who.user.email).toBe(200);
	return textOf(await response.text());
}

/** The statements D1 is asked to prepare while `run` runs. */
async function statementsWhile(run: () => Promise<unknown>): Promise<string[]> {
	const prepare = vi.spyOn(env.DB, "prepare");
	try {
		await run();
		return prepare.mock.calls.map(([sql]) => String(sql));
	} finally {
		prepare.mockRestore();
	}
}

/** Ada's shares and time: Build three days a week, half of Shop, 11:15 a week of all of Site, none of Launch's time. */
async function seedAdasWeek() {
	await seedShare(ada, site, build, 300, "days");
	await seedShare(ada, shop, null, 5000, "percent");
	await seedShare(ada, site, null, 1125, "hours");
	await seedShare(ada, site, launch, 100, "days");
	// Tuesday morning off: half of the day's 7:30.
	await seedLeave(acme.id, ada.user.id, "annual", "2026-11-10", "2026-11-10", { startsHalf: true });
	await seedEntry(ada, site, build, "2026-11-09", 9, 3);
	await seedEntry(ada, site, build, "2026-11-11", 9, 2);
	await seedEntry(ada, shop, null, "2026-11-09", 13, 1.5);
	await seedEntry(ada, shop, null, "2026-11-12", 9, 4);
}

describe("the plan beside the time on the Timesheet's week", () => {
	it("gives each share line its plan from the schedule, less a holiday and half-day leave, beside its time", async () => {
		await seedAdasWeek();
		clockAtT0();

		const week = await weekOf(ada);
		// Available: Monday, Wednesday and Thursday 7:30 each, Tuesday half of it,
		// Friday a public holiday, the weekend not worked.
		// The lines come in the grid's order of projects; two lines of one project
		// in the order of their keys, which hold ids made at random within a
		// millisecond, so they are compared here in the order of their keys.
		const byLine = (a: { line: string }, b: { line: string }) => a.line.localeCompare(b.line);
		expect(week.plans.map((p) => p.projectId)).toEqual([shop, site, site, site]);
		expect([...week.plans].sort(byLine)).toEqual(
			[
				// Half of each day: 225 + 113 (112.5, rounded) + 225 + 225.
				{
					line: shop,
					projectId: shop,
					workPackageId: null,
					plannedMinutes: 788,
					trackedSeconds: 5.5 * 3600,
				},
				// 11:15 of the 37:30 the schedule sets a week is 30 % of each day:
				// 135 + 68 (67.5, rounded) + 135 + 135; all of Site's time is tracked on it.
				{
					line: site,
					projectId: site,
					workPackageId: null,
					plannedMinutes: 473,
					trackedSeconds: 5 * 3600,
				},
				// Three of the five days worked is 60 % of each day: 270 + 135 + 270 + 270.
				{
					line: `${site}/${build}`,
					projectId: site,
					workPackageId: build,
					plannedMinutes: 945,
					trackedSeconds: 5 * 3600,
				},
				// One of five days is 20 % of each day: 90 + 45 + 90 + 90, and no time.
				{
					line: `${site}/${launch}`,
					projectId: site,
					workPackageId: launch,
					plannedMinutes: 315,
					trackedSeconds: 0,
				},
			].sort(byLine),
		);

		// Under its row the line is named short; a line with no row in the grid
		// (Site's whole project, whose rows are its work packages, and Launch,
		// with no time) is listed below the grid by its full name. Each once.
		const text = await weekText(ada);
		expect(text).toContain("SHOP-1: 13:08 planned, 5:30 tracked");
		expect(text).toContain("WP2: 15:45 planned, 5:00 tracked");
		const below = text.slice(text.indexOf("Planned this week"));
		expect(text.indexOf("Planned this week")).toBeGreaterThan(text.indexOf("Day total"));
		expect(below).toContain("SITE-2 · Site: 7:53 planned, 5:00 tracked");
		expect(below).toContain("SITE-2 · Site › WP3 Launch: 5:15 planned, 0:00 tracked");
		for (const words of ["13:08 planned", "15:45 planned", "7:53 planned", "5:15 planned"]) {
			expect(text.split(words)).toHaveLength(2);
		}
	});

	it("shows no plan to a person with no shares", async () => {
		const bea = await memberOfAcme("member", "bea@example.com");
		await seedAdasWeek();
		await seedEntry(bea, shop, null, "2026-11-09", 9, 2);
		clockAtT0();

		expect((await weekOf(bea)).plans).toEqual([]);
		const text = await weekText(bea);
		expect(text).not.toContain("planned,");
		expect(text).not.toContain("Planned this week");
	});

	it("shows a manager their own plan, never that of the people they manage", async () => {
		const grace = await memberOfAcme("member", "grace@example.com");
		await seedTeam(acme.id, "Delivery", { members: [ada.user.id], managers: [grace.user.id] });
		await seedAdasWeek();
		await seedShare(grace, shop, null, 250, "days");
		clockAtT0();

		// Two and a half of five days worked a week is half of each day: 225 on
		// each of Monday to Thursday, none on the holiday; Grace has no leave.
		expect((await weekOf(grace)).plans).toEqual([
			{ line: shop, projectId: shop, workPackageId: null, plannedMinutes: 900, trackedSeconds: 0 },
		]);
		const text = await weekText(grace);
		expect(text).toContain("SHOP-1 · Shop: 15:00 planned, 0:00 tracked");
		expect(text).not.toContain("WP2:");
		expect(text).not.toContain("13:08 planned");
	});

	it("reads the shares in one statement, and the same statements with four shares as with none", async () => {
		// The week reads the shares once, with `plansOf`'s leave calendar, beside
		// what it read before them; more shares add no statement.
		await seedLeave(acme.id, ada.user.id, "annual", "2026-11-10", "2026-11-10", {
			startsHalf: true,
		});
		await seedEntry(ada, site, build, "2026-11-09", 9, 3);
		await seedEntry(ada, shop, null, "2026-11-12", 9, 4);
		clockAtT0();
		const none = await statementsWhile(() => weekText(ada));
		await seedShare(ada, site, build, 300, "days");
		await seedShare(ada, shop, null, 5000, "percent");
		await seedShare(ada, site, null, 1125, "hours");
		await seedShare(ada, site, launch, 100, "days");
		const four = await statementsWhile(() => weekText(ada));
		expect(four.filter((sql) => /from "allocations"/.test(sql))).toHaveLength(1);
		expect(none.filter((sql) => /from "allocations"/.test(sql))).toHaveLength(1);
		expect(four).toHaveLength(none.length);
	});
});
