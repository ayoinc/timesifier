import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "~/db";
import type { WorkRule } from "~/leave/rules";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, type Role, seedMembership, value } from "../organisations/harness";
import { type Person, person, submit } from "./harness";
import { seedHoliday, seedLeave } from "./leave-seed";
import { seedEntry, seedProject } from "./periods-seed";

// The Timesheet's action and the limits of a day (TS-090): no time on a
// public holiday or a day of whole-day leave, what is left of a half day, the
// organisation's rules for overtime and weekend work, a week over its limits
// refused at submission, and a timer stopped past the limit kept but flagged.
// Every request goes through the Worker, as the page's own forms make it, for
// an owner and a member alike: each acts on their own time.

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
	await seedMembership(acme.id, grace.user.id, "member");
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

/** The instant of `clock` on `day` in London, where November is GMT. */
const at = (day: string, clock: string) => Date.parse(`${day}T${clock}:00Z`);

/** The organisation's rules for overtime and weekend work, set as Workspace settings would. */
function setRules({ overtime, weekend }: { overtime?: WorkRule; weekend?: WorkRule }) {
	return env.DB.prepare(
		"update organisations set overtime_rule = coalesce(?, overtime_rule), weekend_rule = coalesce(?, weekend_rule) where id = ?",
	)
		.bind(overtime ?? null, weekend ?? null, acme.id)
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

/** The minutes `who` has tracked on `day` in London. */
async function minutesOn(who: Person, day: string) {
	const from = at(day, "00:00");
	const total = await value<number>(
		"select coalesce(sum(ended_at - started_at), 0) from time_entries where user_id = ? and started_at >= ? and started_at < ?",
		who.user.id,
		from,
		from + 24 * HOUR,
	);
	return (total ?? 0) / 60_000;
}

const countEntries = () => value<number>("select count(*) from time_entries");
const periodStatus = () => value<string>("select status from periods");

describe.each(["owner", "member"] as const)("for an %s's own time", (role) => {
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

		it("takes only approved overtime beyond its half, whatever the overtime rule", async () => {
			await seedWork(me, "overtime", TUESDAY, TUESDAY, 60);
			await seedWork(me, "overtime", TUESDAY, TUESDAY, 120, "pending");
			expect((await ask(me, trackHours(TUESDAY, "4:45"))).status).toBe(200);
			const refused = await ask(me, trackHours(TUESDAY, "0:01"));
			expect(refused.status).toBe(409);
			expect(refused.said).toContain("This day has 0:00 left.");
		});
	});

	describe("overtime with pre-approval", () => {
		beforeEach(async () => {
			await setRules({ overtime: "approval" });
		});

		it("caps a working day at its 7:30", async () => {
			expect((await ask(me, trackHours(WEDNESDAY, "7:30"))).status).toBe(200);
			const refused = await ask(me, trackHours(WEDNESDAY, "0:01"));
			expect(refused.status).toBe(409);
			expect(refused.said).toContain("This day has 0:00 left.");
			const typed = await ask(me, { intent: "cell", projectId: site, day: MONDAY, hours: "8" });
			expect(typed.status).toBe(409);
			expect(typed.said).toContain("This day has 7:30 left.");
		});

		it("raises the cap by approved overtime, and not by a request still waiting or refused", async () => {
			await seedWork(me, "overtime", MONDAY, WEDNESDAY, 60);
			await seedWork(me, "overtime", WEDNESDAY, WEDNESDAY, 30);
			await seedWork(me, "overtime", WEDNESDAY, WEDNESDAY, 120, "pending");
			await seedWork(me, "overtime", WEDNESDAY, WEDNESDAY, 120, "refused");
			expect((await ask(me, trackHours(WEDNESDAY, "9"))).status).toBe(200);
			const refused = await ask(me, trackHours(WEDNESDAY, "0:01"));
			expect(refused.status).toBe(409);
			expect(refused.said).toContain("This day has 0:00 left.");
			// Thursday has none approved.
			const thursday = await ask(me, trackHours(THURSDAY, "7:31"));
			expect(thursday.status).toBe(409);
			expect(thursday.said).toContain("This day has 7:30 left.");
		});

		it("starts no timer on a day already full", async () => {
			await seedEntry(acme.id, me.user.id, site, at(WEDNESDAY, "00:30"), at(WEDNESDAY, "08:00"));
			const refused = await ask(me, { intent: "track", projectId: site, day: WEDNESDAY });
			expect(refused.status).toBe(409);
			expect(refused.said).toContain("This day has 0:00 left.");
		});
	});

	describe("weekend work", () => {
		it("is refused when not allowed, approved work or not", async () => {
			await setRules({ weekend: "none" });
			await seedWork(me, "weekend", SATURDAY, SATURDAY, 120);
			const refused = await ask(me, trackHours(SATURDAY, "1"));
			expect(refused.status).toBe(409);
			expect(refused.said).toContain(
				"Saturday is not a working day, and this organisation does not allow time on it.",
			);
			expect(await countEntries()).toBe(0);
		});

		it("with pre-approval, is refused without approved work, and takes up to its hours with it", async () => {
			await setRules({ weekend: "approval" });
			const refused = await ask(me, trackHours(SATURDAY, "1"));
			expect(refused.status).toBe(409);
			expect(refused.said).toContain(
				"Saturday is not a working day: time on it needs approved weekend work. Request it on Time off.",
			);

			await seedWork(me, "weekend", SATURDAY, SATURDAY, 120, "pending");
			expect((await ask(me, trackHours(SATURDAY, "1"))).status).toBe(409);

			await seedWork(me, "weekend", SATURDAY, SATURDAY, 120);
			expect((await ask(me, trackHours(SATURDAY, "2"))).status).toBe(200);
			const more = await ask(me, trackHours(SATURDAY, "0:01"));
			expect(more.status).toBe(409);
			expect(more.said).toContain("This day has 0:00 left.");
			expect(await minutesOn(me, SATURDAY)).toBe(120);
		});

		it("is taken freely by default", async () => {
			expect((await ask(me, trackHours(SATURDAY, "10"))).status).toBe(200);
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

	it("stops a timer that ran past the limit, keeps the entry and says the day is over", async () => {
		await seedLeave(acme.id, me.user.id, "annual", WEDNESDAY, WEDNESDAY, { startsHalf: true });
		expect((await ask(me, { intent: "track", projectId: site, day: WEDNESDAY })).status).toBe(200);

		clockAt(T0 + 4 * HOUR);
		const stopped = await ask(me, { intent: "stop" });
		expect(stopped.status).toBe(200);
		expect(stopped.said).toContain(
			"Timer stopped. Wed 11 is over by 0:15: trim or move an entry before you submit the week.",
		);
		expect(await minutesOn(me, WEDNESDAY)).toBe(240);

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
});
