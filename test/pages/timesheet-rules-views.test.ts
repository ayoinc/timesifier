import { env } from "cloudflare:workers";
import { UNSAFE_decodeViaTurboStream as decodeViaTurboStream } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "~/db";
import type { DayRule } from "~/leave/rules";
import { type Day, instantAt } from "~/time/calendar";
import type { TimesheetData } from "~/timesheet/timesheet.server";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, type Role, seedMembership, seedTeam } from "../organisations/harness";
import { open, openData, type Person, person, submit, textOf } from "./harness";
import { seedHoliday, seedLeave } from "./leave-seed";

// The limits of each day (TS-090) as the Timesheet's Day, Week and Calendar
// views read them: a half-day of leave leaves the other half of the day, a
// public holiday takes no time, and time past a day's limit is over it and
// keeps the week from being submitted. Each person reads their own days alone,
// whatever their role. The data is what a move to the page asks for.

const PAGE = "/app/acme";
const ACTION = "/app/acme?index";
const LONDON = "Europe/London";
const HOUR = 3_600_000;
/** Wednesday 11 November 2026, 10:00 in London: the week of Monday 9 to Sunday 15. */
const T0 = Date.parse("2026-11-11T10:00:00Z");
const MONDAY = "2026-11-09";
const HOLIDAY = "2026-11-13";
/** Half of the default working day of 7:30. */
const HALF_DAY = 225;

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };
let site: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	site = uuidv7();
	await env.DB.prepare(
		"insert into projects (id, organisation_id, name, name_key, archived_at, created_at, updated_at) values (?, ?, 'Site', 'site', null, 0, 0)",
	)
		.bind(site, acme.id)
		.run();
	await setZone(ada);
	await seedHoliday(acme.id, HOLIDAY, "Founders' Day");
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

/** A finished entry of `who` from `startHour` on `day`, London time, lasting `hours`. */
async function seedEntry(who: Person, day: Day, startHour: number, hours: number) {
	const startedAt = instantAt(day, startHour * 60, LONDON);
	await env.DB.prepare(
		"insert into time_entries (id, organisation_id, user_id, project_id, description, started_at, ended_at, created_at, updated_at) values (?, ?, ?, ?, null, ?, ?, 0, 0)",
	)
		.bind(uuidv7(), acme.id, who.user.id, site, startedAt, startedAt + hours * HOUR)
		.run();
}

/** The Timesheet's loader data at `path`, decoded as the browser decodes it. */
async function dataOf(path: string, who: Person): Promise<TimesheetData> {
	const response = await openData(path, who);
	expect(response.status, `${who.user.email} at ${path}`).toBe(200);
	if (!response.body) throw new Error("no body");
	const { value } = await decodeViaTurboStream(response.body, globalThis);
	const route = (value as Record<string, { data?: { data?: TimesheetData } }>)[
		"routes/app/timesheet"
	];
	const found = route?.data?.data;
	if (!found) throw new Error(`no timesheet data at ${path}`);
	return found;
}

/** The rules of the Day, Week or week Calendar data at `path`. */
async function rulesAt(path: string, who: Person): Promise<DayRule[]> {
	const data = await dataOf(path, who);
	if (data.view === "history") throw new Error("History has no rules");
	return data.rules;
}

const ruleOn = (rules: readonly DayRule[], day: string) => {
	const rule = rules.find((each) => each.day === day);
	if (!rule) throw new Error(`no rule for ${day}`);
	return rule;
};

const WEEK = `${PAGE}?view=week&start=${MONDAY}`;
const CALENDAR = `${PAGE}?view=calendar&date=${MONDAY}`;
const dayAt = (day: string) => `${PAGE}?day=${day}`;

describe("the limits of the days in the Timesheet's views", () => {
	it("gives a half-day of leave half the day, closes a public holiday, and leaves other days open", async () => {
		clockAtT0();
		await seedLeave(acme.id, ada.user.id, "annual", "2026-11-10", "2026-11-10", {
			startsHalf: true,
		});

		const week = await rulesAt(WEEK, ada);
		expect(week.map((rule) => rule.day)).toEqual([
			"2026-11-09",
			"2026-11-10",
			"2026-11-11",
			"2026-11-12",
			"2026-11-13",
			"2026-11-14",
			"2026-11-15",
		]);
		expect(ruleOn(week, "2026-11-10")).toMatchObject({
			limitMinutes: HALF_DAY,
			leftMinutes: HALF_DAY,
			closedReason: null,
			overMinutes: 0,
		});
		expect(ruleOn(week, HOLIDAY).closedReason).toBe(
			"Founders' Day is a public holiday: no time can be tracked on it.",
		);
		expect(ruleOn(week, HOLIDAY).leftMinutes).toBe(0);
		// A working day takes its expected hours, a day not worked none: its time is
		// overtime, which no organisation allows until it says so (TS-095).
		expect(ruleOn(week, "2026-11-11")).toMatchObject({
			limitMinutes: 450,
			closedReason: null,
			overtimeOpen: false,
		});
		expect(ruleOn(week, "2026-11-14")).toMatchObject({
			limitMinutes: 0,
			closedReason: null,
			overtimeOpen: false,
		});

		// The Day view and the week calendar read the same days.
		const day = await rulesAt(dayAt("2026-11-10"), ada);
		expect(day).toEqual(week);
		expect(await rulesAt(CALENDAR, ada)).toEqual(week);
	});

	it("counts time past a day's limit as over it, and keeps the week from being submitted", async () => {
		clockAtT0();
		await seedLeave(acme.id, ada.user.id, "annual", "2026-11-10", "2026-11-10", {
			startsHalf: true,
		});
		await seedEntry(ada, "2026-11-10", 9, 3);
		let rule = ruleOn(await rulesAt(dayAt("2026-11-10"), ada), "2026-11-10");
		expect(rule).toMatchObject({ trackedMinutes: 180, leftMinutes: 45, overMinutes: 0 });

		await seedEntry(ada, "2026-11-10", 13, 1);
		rule = ruleOn(await rulesAt(dayAt("2026-11-10"), ada), "2026-11-10");
		expect(rule).toMatchObject({ trackedMinutes: 240, leftMinutes: 0, overMinutes: 15 });

		const week = await dataOf(WEEK, ada);
		if (week.view !== "week") throw new Error("not the Week view");
		expect(week.over.map((each) => [each.day, each.overMinutes])).toEqual([["2026-11-10", 15]]);
		const day = await dataOf(dayAt("2026-11-12"), ada);
		if (day.view !== "day") throw new Error("not the Day view");
		expect(day.submission.over.map((each) => each.day)).toEqual(["2026-11-10"]);
		const calendar = await dataOf(CALENDAR, ada);
		if (calendar.view !== "calendar") throw new Error("not the Calendar view");
		expect(calendar.submission?.over.map((each) => each.day)).toEqual(["2026-11-10"]);

		const refused = await submit(ACTION, { intent: "submit", startsOn: MONDAY }, ada, {
			byScript: true,
		});
		expect(refused.status).toBe(409);
	});

	it("says on each view what a day has left, why a day takes no time, and what is over", async () => {
		clockAtT0();
		await seedLeave(acme.id, ada.user.id, "annual", "2026-11-10", "2026-11-10", {
			startsHalf: true,
		});
		const textAt = async (path: string) => {
			const response = await open(path, ada);
			expect(response.status, path).toBe(200);
			return textOf(await response.text());
		};

		expect(await textAt(dayAt("2026-11-10"))).toContain("3:45 left of 3:45");
		const holiday = await textAt(dayAt(HOLIDAY));
		expect(holiday).toContain("Founders' Day is a public holiday: no time can be tracked on it.");

		await seedEntry(ada, "2026-11-10", 9, 4);
		const over = await textAt(dayAt("2026-11-10"));
		expect(over).toContain("This day has 0:00 left.");
		expect(over).toContain("Over by 0:15");
		expect(over).toContain("Correct Tue 10 (over by 0:15) before you submit.");

		const week = await textAt(WEEK);
		expect(week).toContain("Over by 0:15");
		expect(week).toContain("Fri 13: Founders' Day is a public holiday");
		expect(week).toContain("Correct Tue 10 (over by 0:15) before you submit.");
		const calendar = await textAt(CALENDAR);
		expect(calendar).toContain("Over by 0:15");
		expect(calendar).toContain("Correct Tue 10 (over by 0:15) before you submit.");
		expect(await textAt(`${PAGE}?view=calendar&scale=month&date=${MONDAY}`)).toContain("Closed");
	});

	it("shows the month calendar the limits of its days, with no one week's submission", async () => {
		clockAtT0();
		const month = await dataOf(`${PAGE}?view=calendar&scale=month&date=${MONDAY}`, ada);
		if (month.view !== "calendar") throw new Error("not the Calendar view");
		expect(month.submission).toBeNull();
		expect(ruleOn(month.rules, HOLIDAY).closedReason).toContain("Founders' Day");
		expect(month.rules).toHaveLength(month.days.length);
	});

	it("shows a member, a manager and an owner their own days alone", async () => {
		const grace = await memberOfAcme("member", "grace@example.com");
		// A manager is a member who manages a team: Mary manages Grace's.
		const mary = await memberOfAcme("member", "mary@example.com");
		await seedTeam(acme.id, "Crew", { members: [grace.user.id], managers: [mary.user.id] });
		clockAtT0();
		const leaveOn = new Map<Person, string>([
			[ada, "2026-11-10"],
			[mary, "2026-11-11"],
			[grace, "2026-11-12"],
		]);
		for (const [who, day] of leaveOn) {
			await seedLeave(acme.id, who.user.id, "annual", day, day, { startsHalf: true });
		}
		await seedEntry(grace, "2026-11-12", 9, 4);

		for (const [who, own] of leaveOn) {
			for (const path of [WEEK, dayAt(own), CALENDAR]) {
				const rules = await rulesAt(path, who);
				for (const [, day] of leaveOn) {
					const rule = ruleOn(rules, day);
					expect(rule.limitMinutes, `${who.user.email} on ${day} at ${path}`).toBe(
						day === own ? HALF_DAY : 450,
					);
				}
				// The holiday is the organisation's: everyone's.
				expect(ruleOn(rules, HOLIDAY).closedReason).not.toBeNull();
				// Grace's time is hers: nobody else is over on her day.
				expect(ruleOn(rules, "2026-11-12").overMinutes).toBe(who === grace ? 15 : 0);
			}
		}
	});
});
