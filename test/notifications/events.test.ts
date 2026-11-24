import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "~/db";
import type { BellItem } from "~/notifications/kinds";
import { sendWaitingNotifications } from "~/notifications/mail.server";
import { notificationsPath } from "~/notifications/paths";

import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, type Role, seedMembership, seedTeam } from "../organisations/harness";
import { open, type Person, person, submit } from "../pages/harness";
import { kindOf, seedLeave } from "../pages/leave-seed";
import { seedEntry } from "../pages/periods-seed";

// Who each event of TS-049 tells (decision 68), role by role: an owner, an
// admin, Finance, a manager, a member, a contractor and a stranger from
// another organisation. Nobody is told of their own week or request (D5,
// decision 47); a manager on leave all of today is skipped, and where no
// manager of the person is there the owners and admins are told (D6,
// decision 48). A notification says nothing its recipient may not already see,
// and the bell lists a person's own alone.

/** Wednesday 11 November 2026, 10:00 in London. */
const T0 = Date.parse("2026-11-11T10:00:00Z");
/** The week T0 is in, Monday to Sunday. */
const MONDAY = "2026-11-09";
const LONDON = "Europe/London";

const SHEET = "/app/acme?index";
const APPROVALS = "/app/acme/approvals";
const TIME_OFF = "/app/acme/time-off";
const SETTINGS = "/app/acme/settings";

type Kind = "owner" | "admin" | "finance" | "manager" | "member" | "contractor" | "stranger";
const EMAIL: Record<Kind, string> = {
	owner: "ada@example.com",
	admin: "grace@example.com",
	finance: "katherine@example.com",
	manager: "hedy@example.com",
	member: "linus@example.com",
	contractor: "carl@example.com",
	stranger: "sam@example.com",
};

let mailbox: Mailbox;
let acme: { id: string; slug: string };
let people: Record<Kind, Person>;
let site: string;
/** What the bell's address answers. */
type Bell = { items: BellItem[]; readAt: number | null };

/** Acme: Ada owns it; Grace is an admin, Katherine Finance; Hedy manages Design, where Linus and Carl, a contractor, are. Sam owns Globex. */
beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	// One at a time: signing in waits for its code in the shared mailbox.
	const signedIn: Partial<Record<Kind, Person>> = {};
	for (const kind of Object.keys(EMAIL) as Kind[]) {
		signedIn[kind] = await person(mailbox, EMAIL[kind]);
	}
	people = signedIn as Record<Kind, Person>;
	acme = await createOrganisation(people.owner.cookie, "Acme");
	await createOrganisation(people.stranger.cookie, "Globex");
	const roles: [Kind, Role][] = [
		["admin", "admin"],
		["finance", "finance"],
		["manager", "member"],
		["member", "member"],
		["contractor", "member"],
	];
	for (const [kind, role] of roles) await seedMembership(acme.id, people[kind].user.id, role);
	await env.DB.prepare(
		"update memberships set is_contractor = 1 where organisation_id = ? and user_id = ?",
	)
		.bind(acme.id, people.contractor.user.id)
		.run();
	await seedTeam(acme.id, "Design", {
		members: [people.member.user.id, people.contractor.user.id],
		managers: [people.manager.user.id],
	});
	await env.DB.prepare(
		"update organisations set time_zone = ?, overtime_policy = 'approval' where id = ?",
	)
		.bind(LONDON, acme.id)
		.run();
	site = uuidv7();
	await env.DB.prepare(
		"insert into projects (id, organisation_id, name, name_key, created_at, updated_at) values (?, ?, 'Site', 'site', 0, 0)",
	)
		.bind(site, acme.id)
		.run();
	// The whole clock, `new Date()` too, which the writers of leave read.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T0);
}, 60_000);

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function post(path: string, fields: Record<string, string>, who: Kind) {
	const response = await submit(path, fields, people[who], { byScript: true });
	expect(response.status, `${who} posting ${fields.intent}`).toBe(200);
}

/** The notifications of `kind` in the order they were made (the clock stands still), each with whom it is for. */
async function told(kind: string) {
	const { results } = await env.DB.prepare(
		"select u.email as email, n.title as title, n.body as body, n.path as path from notifications n join users u on u.id = n.user_id where n.kind = ? order by n.rowid",
	)
		.bind(kind)
		.all<{ email: string; title: string; body: string | null; path: string }>();
	return results;
}

/** Who was told of `kind`, by role, in order. */
async function whoWasTold(kind: string): Promise<Kind[]> {
	const byEmail = new Map(Object.entries(EMAIL).map(([k, email]) => [email, k as Kind]));
	return (await told(kind))
		.map(({ email }) => byEmail.get(email))
		.filter((k): k is Kind => k !== undefined)
		.sort();
}

/** A week of `who` with an hour on Tuesday, submitted by them. */
async function submitWeek(who: Kind) {
	await seedEntry(
		acme.id,
		people[who].user.id,
		site,
		"2026-11-10T09:00:00Z",
		"2026-11-10T10:00:00Z",
	);
	await post(SHEET, { intent: "submit", startsOn: MONDAY }, who);
}

const periodOf = async (who: Kind) =>
	(
		await env.DB.prepare("select id from periods where user_id = ?")
			.bind(people[who].user.id)
			.first<{ id: string }>()
	)?.id ?? "";

describe("a week submitted", () => {
	it("tells its person's manager, and nobody else", async () => {
		await submitWeek("member");
		expect(await whoWasTold("week-waiting")).toEqual(["manager"]);
		const [waiting] = await told("week-waiting");
		expect(waiting?.title).toBe(
			"linus@example.com submitted their timesheet for 9–15 November 2026.",
		);
		expect(waiting?.body).toBeNull();
		expect(waiting?.path).toBe("/approvals");
	});

	it("of a contractor tells their manager too", async () => {
		await submitWeek("contractor");
		expect(await whoWasTold("week-waiting")).toEqual(["manager"]);
	});

	it("never tells its person (D5): an owner's goes to the other owners and admins, a manager's to the owners and admins", async () => {
		await submitWeek("owner");
		expect(await whoWasTold("week-waiting")).toEqual(["admin"]);
		await submitWeek("manager");
		expect(await whoWasTold("week-waiting")).toEqual(["admin", "admin", "owner"]);
	});

	it("skips a manager on leave all of today, and tells the owners and admins instead (D6)", async () => {
		await seedLeave(acme.id, people.manager.user.id, "annual", "2026-11-11", "2026-11-11");
		await submitWeek("member");
		expect(await whoWasTold("week-waiting")).toEqual(["admin", "owner"]);
	});

	it("does not skip a manager on half a day of leave", async () => {
		await seedLeave(acme.id, people.manager.user.id, "annual", "2026-11-11", "2026-11-11", {
			startsHalf: true,
		});
		await submitWeek("member");
		expect(await whoWasTold("week-waiting")).toEqual(["manager"]);
	});

	it("waits for nobody where nobody else may approve it, as the system approves it", async () => {
		// Ada alone in Acme: nobody else may approve her week.
		for (const kind of ["admin", "finance", "manager", "member", "contractor"] as const) {
			await env.DB.prepare("delete from memberships where organisation_id = ? and user_id = ?")
				.bind(acme.id, people[kind].user.id)
				.run();
		}
		await submitWeek("owner");
		expect(await told("week-waiting")).toEqual([]);
	});
});

describe("a week decided", () => {
	it("approved, returned or reopened tells its person alone, with the reason given", async () => {
		await submitWeek("member");
		const period = await periodOf("member");
		await post(
			APPROVALS,
			{ intent: "return", periodId: period, comment: "Tuesday is missing" },
			"manager",
		);
		await submitWeek("member");
		await post(APPROVALS, { intent: "approve", periodId: period }, "manager");
		await post(
			APPROVALS,
			{ intent: "reopen", periodId: period, comment: "Wrong project" },
			"owner",
		);

		expect(await whoWasTold("week-decided")).toEqual(["member", "member", "member"]);
		expect((await told("week-decided")).map(({ title, body }) => [title, body])).toEqual([
			[
				"Your timesheet for 9–15 November 2026 was returned to you.",
				"The reason given: Tuesday is missing",
			],
			["Your timesheet for 9–15 November 2026 was approved.", null],
			["Your timesheet for 9–15 November 2026 was reopened.", "The reason given: Wrong project"],
		]);
		// The Timesheet is the organisation's first page: its week view, below the organisation.
		expect((await told("week-decided"))[0]?.path).toBe(`?view=week&start=${MONDAY}`);
	});
});

describe("a request", () => {
	const leave = async (who: Kind, startsOn = "2026-12-14", endsOn = "2026-12-15") =>
		post(
			TIME_OFF,
			{
				intent: "request",
				kindId: await kindOf(acme.id, "annual"),
				startsOn,
				endsOn,
				noticeReason: "Arranged with the team",
			},
			who,
		);
	/** The request of `who` standing at `status`: the clock stands still, so the order they were made in says nothing. */
	const requestOf = async (table: string, who: Kind, status = "pending") =>
		(
			await env.DB.prepare(`select id from ${table} where user_id = ? and status = ?`)
				.bind(people[who].user.id, status)
				.first<{ id: string }>()
		)?.id ?? "";

	it("for leave tells the person's manager what it is for; its decision tells the person alone", async () => {
		await leave("member");
		expect(await whoWasTold("request-waiting")).toEqual(["manager"]);
		expect((await told("request-waiting"))[0]?.title).toBe(
			"linus@example.com asked for Annual leave: Monday 14 December – Tuesday 15 December.",
		);

		await post(
			TIME_OFF,
			{
				intent: "refuse",
				requestId: await requestOf("leave_requests", "member"),
				comment: "Release week",
			},
			"manager",
		);
		await leave("member", "2026-12-21", "2026-12-21");
		await post(
			TIME_OFF,
			{ intent: "approve", requestId: await requestOf("leave_requests", "member") },
			"manager",
		);
		await post(
			TIME_OFF,
			{
				intent: "cancel",
				requestId: await requestOf("leave_requests", "member", "approved"),
				comment: "Plans changed",
			},
			"admin",
		);
		expect(await whoWasTold("request-decided")).toEqual(["member", "member", "member"]);
		expect((await told("request-decided")).map(({ title, body }) => [title, body])).toEqual([
			[
				"Your request for Annual leave, Monday 14 December – Tuesday 15 December, was refused.",
				"The reason given: Release week",
			],
			["Your request for Annual leave, Monday 21 December, was approved.", null],
			[
				"Your request for Annual leave, Monday 21 December, was cancelled.",
				"The reason given: Plans changed",
			],
		]);
	});

	it("for leave of a manager goes to the owners and admins, never to the manager (D5)", async () => {
		await leave("manager");
		expect(await whoWasTold("request-waiting")).toEqual(["admin", "owner"]);
	});

	it("for leave skips a manager away today (D6)", async () => {
		await seedLeave(acme.id, people.manager.user.id, "annual", "2026-11-11", "2026-11-11");
		await leave("member");
		expect(await whoWasTold("request-waiting")).toEqual(["admin", "owner"]);
	});

	it("for sick leave, approved as it is made, waits for nobody", async () => {
		await post(
			TIME_OFF,
			{
				intent: "request",
				kindId: await kindOf(acme.id, "sick"),
				startsOn: "2026-11-12",
				endsOn: "2026-11-12",
			},
			"member",
		);
		expect(await told("request-waiting")).toEqual([]);
	});

	it("for overtime tells the manager; refusing it tells the person, with the reason", async () => {
		await post(
			TIME_OFF,
			{
				intent: "request-work",
				kind: "overtime",
				startsOn: "2026-12-14",
				endsOn: "2026-12-14",
				hours: "2",
				reason: "Release",
			},
			"contractor",
		);
		expect(await whoWasTold("request-waiting")).toEqual(["manager"]);
		expect((await told("request-waiting"))[0]?.title).toBe(
			"carl@example.com asked for overtime: Monday 14 December.",
		);
		// The reason the person typed is theirs and the decider's to read on Approvals; it is not copied.
		expect((await told("request-waiting"))[0]?.body).toBeNull();

		await post(
			TIME_OFF,
			{
				intent: "refuse-work",
				requestId: await requestOf("work_requests", "contractor"),
				comment: "Not this week",
			},
			"manager",
		);
		expect(await whoWasTold("request-decided")).toEqual(["contractor"]);
		expect((await told("request-decided"))[0]).toMatchObject({
			title: "Your request for overtime, Monday 14 December, was refused.",
			body: "The reason given: Not this week",
			path: "/time-off",
		});
	});
});

describe("what the system does", () => {
	it("submitting a week at the lock date tells its person why, and its manager that it waits", async () => {
		await seedEntry(
			acme.id,
			people.member.user.id,
			site,
			"2026-11-03T09:00:00Z",
			"2026-11-03T10:00:00Z",
		);
		await post(
			SETTINGS,
			{ intent: "lock-date", lockedThrough: "2026-11-08", autoSubmit: "on" },
			"owner",
		);

		expect(await whoWasTold("system")).toEqual(["member"]);
		expect((await told("system"))[0]).toMatchObject({
			title: "Your timesheet for 2–8 November 2026 was submitted by the system.",
			body: "The lock date reached Sunday 8 November, and this organisation submits every week the lock date reaches.",
		});
		expect(await whoWasTold("week-waiting")).toEqual(["manager"]);
		expect((await told("week-waiting"))[0]?.title).toBe(
			"linus@example.com's timesheet for 2–8 November 2026 was submitted by the system and waits for your approval.",
		);
	});

	it("stopping a timer on a day the lock date takes tells its person alone", async () => {
		await seedEntry(acme.id, people.member.user.id, site, "2026-11-10T09:00:00Z", null);
		await post(SETTINGS, { intent: "lock-date", lockedThrough: "2026-11-10" }, "owner");
		expect(await whoWasTold("system")).toEqual(["member"]);
		expect((await told("system"))[0]).toMatchObject({
			title: "Your timer on Tuesday 10 November was stopped by the system.",
			body: "The lock date reached Tuesday 10 November, so no more time can be added to that day.",
			path: "?day=2026-11-10",
		});
	});
});

describe("asked to submit (Approvals › Not submitted)", () => {
	/** The week before T0's, ended. */
	const LAST_MONDAY = "2026-11-02";

	// Everyone a member since before the week, as Not submitted asks (W13).
	beforeEach(async () => {
		await env.DB.prepare("update memberships set created_at = 0 where organisation_id = ?")
			.bind(acme.id)
			.run();
	});

	it("tells the person a decider asks, once a day for the week, and nobody else", async () => {
		const remind = { intent: "remind", startsOn: LAST_MONDAY, personId: people.member.user.id };
		await post(APPROVALS, remind, "manager");
		expect(await whoWasTold("submit-reminder")).toEqual(["member"]);
		expect((await told("submit-reminder"))[0]).toEqual({
			email: EMAIL.member,
			title: "Please submit your timesheet for 2–8 November 2026.",
			body: "hedy@example.com asked you to submit it.",
			path: "?view=week&start=2026-11-02",
		});
		// A second press the same day adds nothing.
		await post(APPROVALS, remind, "manager");
		expect(await whoWasTold("submit-reminder")).toEqual(["member"]);
	});

	it("pressed twice for the same person on the same day, by two deciders, stores one notification and sends one email", async () => {
		const remind = { intent: "remind", startsOn: LAST_MONDAY, personId: people.member.user.id };
		await post(APPROVALS, remind, "manager");
		await post(APPROVALS, remind, "owner");
		const { results } = await env.DB.prepare(
			"select key from notifications where kind = 'submit-reminder' and user_id = ?",
		)
			.bind(people.member.user.id)
			.all<{ key: string }>();
		expect(results).toEqual([{ key: `asked:${LAST_MONDAY}:2026-11-11` }]);

		mailbox.send.mockClear();
		await sendWaitingNotifications(new Date());
		await sendWaitingNotifications(new Date());
		expect(mailbox.sent().map(({ to }) => to)).toEqual([EMAIL.member]);
	});

	it("Remind all tells everyone the asker decides for who has not submitted", async () => {
		await seedEntry(
			acme.id,
			people.contractor.user.id,
			site,
			"2026-11-03T09:00:00Z",
			"2026-11-03T10:00:00Z",
		);
		await post(SHEET, { intent: "submit", startsOn: LAST_MONDAY }, "contractor");
		await post(APPROVALS, { intent: "remind-all", startsOn: LAST_MONDAY }, "manager");
		// Carl submitted; Hedy decides for Linus and Carl alone.
		expect(await whoWasTold("submit-reminder")).toEqual(["member"]);

		await post(APPROVALS, { intent: "remind-all", startsOn: LAST_MONDAY }, "owner");
		// Ada decides for everyone but herself (D5); Linus already has today's.
		expect(await whoWasTold("submit-reminder")).toEqual(["admin", "finance", "manager", "member"]);
	});

	it("refuses a week still open, a person not the asker's to decide, and one who decides nobody's", async () => {
		const status = async (fields: Record<string, string>, who: Kind) =>
			(await submit(APPROVALS, fields, people[who], { byScript: true })).status;
		const stillOpen = { intent: "remind", startsOn: MONDAY, personId: people.member.user.id };
		expect(await status(stillOpen, "manager")).toBe(409);
		const notHers = { intent: "remind", startsOn: LAST_MONDAY, personId: people.admin.user.id };
		expect(await status(notHers, "manager")).toBe(409);
		const all = { intent: "remind-all", startsOn: LAST_MONDAY };
		expect(await status(all, "member")).not.toBe(200);
		expect(await whoWasTold("submit-reminder")).toEqual([]);
	});
});

describe("what nobody is told", () => {
	it("Finance, a member, a contractor and a stranger hear nothing of anybody else's week or request", async () => {
		await submitWeek("member");
		await submitWeek("contractor");
		await post(
			TIME_OFF,
			{
				intent: "request",
				kindId: await kindOf(acme.id, "annual"),
				startsOn: "2026-12-14",
				endsOn: "2026-12-14",
				noticeReason: "Arranged",
			},
			"member",
		);
		const { results } = await env.DB.prepare(
			"select distinct user_id as userId from notifications",
		).all<{ userId: string }>();
		const heard = results.map(({ userId }) => userId);
		for (const kind of ["finance", "member", "contractor", "stranger", "owner", "admin"] as const) {
			expect(heard, kind).not.toContain(people[kind].user.id);
		}
		expect(heard).toEqual([people.manager.user.id]);
	});
});

describe("the bell's list", () => {
	const bell = async (who: Kind) => {
		const response = await open(notificationsPath(acme.slug), people[who]);
		return { status: response.status, body: response.ok ? await response.json<Bell>() : null };
	};

	it("is the person's own, in their organisation alone, and opening it marks them read", async () => {
		await submitWeek("member");
		await submitWeek("contractor");

		const hedy = await bell("manager");
		expect(hedy.status).toBe(200);
		const items = hedy.body?.items ?? [];
		expect(items.map(({ title }) => title).sort()).toEqual([
			"carl@example.com submitted their timesheet for 9–15 November 2026.",
			"linus@example.com submitted their timesheet for 9–15 November 2026.",
		]);
		expect(items.every(({ href, read }) => href === "/app/acme/approvals" && !read)).toBe(true);
		// Nobody else's bell holds them.
		for (const kind of ["owner", "admin", "finance", "member", "contractor"] as const) {
			expect((await bell(kind)).body, kind).toEqual({ items: [], readAt: null });
		}
		// A stranger is answered as for any address of an organisation not theirs.
		expect((await bell("stranger")).status).toBe(404);

		// Opening it answers the list as it stood, and marks it read for Hedy alone.
		const opened = await submit(notificationsPath(acme.slug), { intent: "read" }, people.manager);
		expect(opened.status).toBe(200);
		const answer = await opened.json<Bell>();
		expect(answer.items.map(({ read }) => read)).toEqual([false, false]);
		expect(answer.readAt).toBe(T0);
		const after = (await bell("manager")).body;
		expect(after?.items.map(({ read }) => read)).toEqual([true, true]);
	});

	it("a stranger's post marks nothing of anybody's", async () => {
		await submitWeek("member");
		const theirs = await submit(notificationsPath(acme.slug), { intent: "read" }, people.stranger);
		expect(theirs.status).toBe(404);
		expect(
			await env.DB.prepare(
				"select count(*) as n from notifications where read_at is not null",
			).first("n"),
		).toBe(0);
	});
});
