import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextMondayAfter } from "~/leave/rules";
import { periodContaining } from "~/periods/periods";
import { dayOf } from "~/time/calendar";
import { formatDayWithYear } from "~/time/format";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	type Role,
	row,
	seedMembership,
	seedTeam,
	value,
} from "../organisations/harness";
import { open, type Person, pageBody, person, submit, textOf } from "./harness";
import { markOvertime, seedEntry, seedProject } from "./periods-seed";

// Workspace settings, /app/<slug>/settings, for TS-090 and TS-095: the
// timesheet rules (overtime and its caps, weekend and non-working days,
// short-notice leave), which owners
// and admins set for everyone, and the days of notice each kind of leave asks
// for. Every form is posted the way the page posts it.

const SETTINGS = "/app/acme/settings";

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	// The first request to the Worker loads the whole application, which takes
	// longer than a hook is given by default.
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

/** A person who signs in and holds `role` in Acme. */
async function memberOfAcme(role: Role, email: string): Promise<Person> {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, role);
	return who;
}

/** What an action answered a form sent by script: its status and what it said. */
async function outcome(response: Response) {
	return { status: response.status, said: await response.text() };
}

/** Today, as Acme counts it: in UTC. */
const TODAY = dayOf(Date.now(), "UTC");
/** The rules in force today (TR-10): the latest dated change from today or before, else the organisation's own. */
async function rules() {
	const own = await row(
		"select overtime_policy, non_working_days, overtime_day_cap_minutes, overtime_week_cap_minutes, short_notice from organisations where id = ?",
		acme.id,
	);
	const dated = await row(
		"select overtime_policy, non_working_days, overtime_day_cap_minutes, overtime_week_cap_minutes from timesheet_rule_versions where organisation_id = ? and effective_from <= ? order by effective_from desc limit 1",
		acme.id,
		TODAY,
	);
	return { ...own, ...dated };
}
const DEFAULT_RULES = {
	overtime_policy: "none",
	non_working_days: "overtime",
	overtime_day_cap_minutes: null,
	overtime_week_cap_minutes: null,
	short_notice: "with-reason",
};
/** The rules as the sheet sends them, every field given, applying from today. */
const SENT = {
	intent: "timesheet-rules",
	overtime: "none",
	weekend: "overtime",
	overtimeDayCap: "",
	overtimeWeekCap: "",
	shortNotice: "with-reason",
	from: TODAY,
};
const changesRecorded = () =>
	value<number>(
		"select count(*) from activity_records where action = 'timesheet_rules.changed' and organisation_id = ?",
		acme.id,
	);

const kindOf = (key: string) =>
	value<string>("select id from leave_kinds where organisation_id = ? and key = ?", acme.id, key);
const noticeOf = (key: string) =>
	value<number>(
		"select notice_days from leave_kinds where organisation_id = ? and key = ?",
		acme.id,
		key,
	);

describe("the timesheet rules (TS-090, TS-095)", () => {
	it("are shown to an owner and an admin: overtime not allowed and time on other days counted as overtime to start with", async () => {
		const grace = await memberOfAcme("admin", "grace@example.com");
		for (const who of [ada, grace]) {
			const text = textOf(await pageBody(await open(SETTINGS, who)));
			expect(text).toContain("Timesheet rules");
			expect(text).toContain(
				"Not allowed Overtime. Time past a day's expected hours, recorded as overtime.",
			);
			expect(text).toContain("Counts as overtime Weekend and non-working days.");
			expect(text).toContain("Allowed with a reason Short-notice leave requests.");
			expect(text).toContain("Change timesheet rules");
		}
		expect(await rules()).toEqual(DEFAULT_RULES);
	});

	it.each(["owner", "admin"] as const)(
		"an %s saves them all, caps included, each change recorded",
		async (role) => {
			const who = role === "owner" ? ada : await memberOfAcme("admin", "grace@example.com");
			const answer = await outcome(
				await submit(
					SETTINGS,
					{
						...SENT,
						overtime: "allowed",
						weekend: "none",
						overtimeDayCap: "2",
						overtimeWeekCap: "7:30",
						shortNotice: "refused",
					},
					who,
					{ byScript: true },
				),
			);
			expect(answer.status).toBe(200);
			expect(answer.said).toContain("The timesheet rules are saved.");
			expect(await rules()).toEqual({
				overtime_policy: "allowed",
				non_working_days: "none",
				overtime_day_cap_minutes: 120,
				overtime_week_cap_minutes: 450,
				short_notice: "refused",
			});
			const text = textOf(await pageBody(await open(SETTINGS, who)));
			expect(text).toContain(
				"Allowed Overtime. Time past a day's expected hours, recorded as overtime. Cap: 2:00 a day, 7:30 a week.",
			);
			expect(text).toContain("Not allowed Weekend and non-working days.");
			expect(text).toContain("Not allowed Short-notice leave requests.");
			expect(await changesRecorded()).toBe(1);
			const summary = JSON.parse(
				(await value<string>(
					"select summary from activity_records where action = 'timesheet_rules.changed' and organisation_id = ?",
					acme.id,
				)) ?? "{}",
			);
			expect(summary).toEqual({
				before: {
					overtime: "none",
					weekend: "overtime",
					overtimeDayCap: null,
					overtimeWeekCap: null,
					shortNotice: "with-reason",
				},
				after: {
					overtime: "allowed",
					weekend: "none",
					overtimeDayCap: 120,
					overtimeWeekCap: 450,
					shortNotice: "refused",
					appliesFrom: TODAY,
				},
			});
			const log = textOf(await pageBody(await open("/app/acme/activity", ada)));
			expect(log).toContain("Changed the timesheet rules");
			expect(log).toContain("Overtime: Not allowed → Allowed");
			expect(log).toContain("Overtime cap a day: 2:00");

			// Pre-approval; the caps taken away by leaving them empty.
			await submit(SETTINGS, { ...SENT, overtime: "approval" }, who, { byScript: true });
			expect(await rules()).toEqual({ ...DEFAULT_RULES, overtime_policy: "approval" });
			expect(textOf(await pageBody(await open(SETTINGS, who)))).toContain(
				"Only with pre-approval Overtime. Time past a day's expected hours, recorded as overtime. Cap: No cap a day, No cap a week.",
			);
			await submit(SETTINGS, SENT, who, { byScript: true });
			expect(await rules()).toEqual(DEFAULT_RULES);
			expect(await changesRecorded()).toBe(3);
			// Saving what is already there records nothing.
			await submit(SETTINGS, SENT, who, { byScript: true });
			expect(await changesRecorded()).toBe(3);
		},
	);

	it.each([
		["an overtime rule that is not one", { overtime: "free" }],
		["TS-090's weekend rule", { weekend: "approval" }],
		["a short-notice rule that is not one", { shortNotice: "none" }],
		["no weekend rule", { weekend: undefined }],
		["a cap that is not hours", { overtimeDayCap: "lots" }],
		["a cap past a week", { overtimeWeekCap: "169" }],
		["a negative cap", { overtimeDayCap: "-1" }],
	])("refuses %s with 400, and changes nothing", async (_, change) => {
		const fields: Record<string, string | undefined> = { ...SENT, overtime: "allowed", ...change };
		const sent = Object.fromEntries(
			Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined),
		);
		expect((await submit(SETTINGS, sent, ada, { byScript: true })).status).toBe(400);
		expect(await rules()).toEqual(DEFAULT_RULES);
		expect(await changesRecorded()).toBe(0);
	});

	it.each(["member", "finance"] as const)(
		"a %s cannot change them, and the page stays 404",
		async (role) => {
			const who = await memberOfAcme(role, "linus@example.com");
			expect((await open(SETTINGS, who)).status).toBe(404);
			const response = await submit(SETTINGS, { ...SENT, overtime: "allowed" }, who, {
				byScript: true,
			});
			expect(response.status).toBe(404);
			expect(await rules()).toEqual(DEFAULT_RULES);
		},
	);

	it("a manager cannot change them, and the page stays 404", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");
		const mary = await memberOfAcme("member", "mary@example.com");
		await seedTeam(acme.id, "Design", { members: [linus.user.id], managers: [mary.user.id] });
		expect((await open(SETTINGS, mary)).status).toBe(404);
		const response = await submit(SETTINGS, { ...SENT, overtime: "allowed" }, mary, {
			byScript: true,
		});
		expect(response.status).toBe(404);
		expect(await rules()).toEqual(DEFAULT_RULES);
		expect(await changesRecorded()).toBe(0);
	});

	/** This week's Monday, on which Grace and Alan each tracked 7:30 and 2:00 of overtime while overtime was allowed. */
	async function overtimeWorked() {
		await env.DB.prepare("update organisations set overtime_policy = 'allowed' where id = ?")
			.bind(acme.id)
			.run();
		const monday = periodContaining(TODAY, 1).startsOn;
		const site = await seedProject(acme.id, "Site");
		const people: Person[] = [];
		for (const email of ["grace@example.com", "alan@example.com"]) {
			const who = await memberOfAcme("member", email);
			await seedEntry(acme.id, who.user.id, site, `${monday}T08:00:00Z`, `${monday}T15:30:00Z`);
			await markOvertime(
				await seedEntry(acme.id, who.user.id, site, `${monday}T15:30:00Z`, `${monday}T17:30:00Z`),
			);
			people.push(who);
		}
		return { monday, people };
	}

	it("overtime turned off applies from next Monday, and leaves the overtime already tracked alone (TR-10)", async () => {
		const { monday, people } = await overtimeWorked();
		const from = nextMondayAfter(TODAY);
		const answer = await outcome(
			await submit(SETTINGS, { ...SENT, from: "" }, ada, { byScript: true }),
		);
		expect(answer.status).toBe(200);
		expect(answer.said).toContain(
			`The timesheet rules are saved. They apply from ${formatDayWithYear(from)}.`,
		);
		expect(answer.said).not.toContain("over their limit");
		const text = textOf(await pageBody(await open(SETTINGS, ada)));
		// Today's rules stand; the change waits for its day.
		expect(text).toContain("Allowed Overtime.");
		expect(text).toContain(
			`From ${formatDayWithYear(from)} Overtime: Not allowed. Weekend and non-working days: Counts as overtime.`,
		);
		// Grace's Monday, overtime and all, is not over: her week is submitted.
		const [grace] = people;
		const submitted = await submit(
			"/app/acme?index",
			{ intent: "submit", startsOn: monday },
			grace ?? ada,
			{ byScript: true },
		);
		expect(submitted.status).toBe(200);
	});

	it("says how many days of how many people a change from an earlier day puts over their limit (TR-10)", async () => {
		const { monday } = await overtimeWorked();
		const answer = await outcome(
			await submit(SETTINGS, { ...SENT, from: monday }, ada, { byScript: true }),
		);
		expect(answer.status).toBe(200);
		expect(answer.said).toContain(
			`The timesheet rules are saved. They apply from ${formatDayWithYear(monday)}. This puts 2 days of 2 people over their limit.`,
		);
	});
});

describe("the notice each kind of leave asks for (TS-090)", () => {
	const kindFields = async (key: string, name: string, noticeDays?: string) => ({
		intent: "kind",
		kindId: (await kindOf(key)) ?? "",
		name,
		enabled: "on",
		...(noticeDays === undefined ? {} : { noticeDays }),
	});

	it("a new organisation's kinds ask for 14, 0, 28, 56, 14 and 0 days", async () => {
		const other = await createOrganisation(ada.cookie, "Other");
		for (const organisationId of [acme.id, other.id]) {
			const notice = (
				await env.DB.prepare(
					"select key, notice_days from leave_kinds where organisation_id = ? order by key",
				)
					.bind(organisationId)
					.all<{ key: string; notice_days: number }>()
			).results;
			expect(Object.fromEntries(notice.map((k) => [k.key, k.notice_days]))).toEqual({
				annual: 14,
				sick: 0,
				study: 28,
				parental: 56,
				unpaid: 14,
				holiday: 0,
			});
		}
	});

	it("are shown on each kind's row, and sick leave never needs notice", async () => {
		const text = textOf(await pageBody(await open(SETTINGS, ada)));
		expect(text).toMatch(/Annual leave On · Needs approval · [^·]+ · 14 working days' notice/);
		expect(text).toMatch(/Sick leave On · Needs no approval · No allowance · Never needs notice/);
		expect(text).toContain("56 working days' notice");
	});

	it.each(["owner", "admin"] as const)(
		"an %s sets annual leave's notice, and empty is none",
		async (role) => {
			const who = role === "owner" ? ada : await memberOfAcme("admin", "grace@example.com");
			const answer = await outcome(
				await submit(SETTINGS, await kindFields("annual", "Annual leave", " 21 "), who, {
					byScript: true,
				}),
			);
			expect(answer.status).toBe(200);
			expect(answer.said).toContain("Annual leave is saved.");
			expect(await noticeOf("annual")).toBe(21);
			expect(textOf(await pageBody(await open(SETTINGS, who)))).toContain(
				"21 working days' notice",
			);

			await submit(SETTINGS, await kindFields("annual", "Annual leave", ""), who, {
				byScript: true,
			});
			expect(await noticeOf("annual")).toBe(0);
			await submit(SETTINGS, await kindFields("annual", "Annual leave", "365"), who, {
				byScript: true,
			});
			expect(await noticeOf("annual")).toBe(365);
		},
	);

	it("keeps sick leave and public holidays at no notice, whatever is sent", async () => {
		for (const [key, name] of [
			["sick", "Sick leave"],
			["holiday", "Public holiday"],
		] as const) {
			const response = await submit(SETTINGS, await kindFields(key, name, "10"), ada, {
				byScript: true,
			});
			expect(response.status, key).toBe(200);
			expect(await noticeOf(key), key).toBe(0);
		}
	});

	it.each(["1.5", "366", "-1", "ten", "1e2"])(
		"refuses %s days of notice with 400, and changes nothing",
		async (noticeDays) => {
			const answer = await outcome(
				await submit(SETTINGS, await kindFields("annual", "Annual leave", noticeDays), ada, {
					byScript: true,
				}),
			);
			expect(answer.status).toBe(400);
			expect(answer.said).toContain("Type whole days, at most 365.");
			expect(await noticeOf("annual")).toBe(14);
		},
	);

	it("a member cannot change a kind's notice", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");
		const response = await submit(
			SETTINGS,
			await kindFields("annual", "Annual leave", "1"),
			linus,
			{
				byScript: true,
			},
		);
		expect(response.status).toBe(404);
		expect(await noticeOf("annual")).toBe(14);
	});
});
