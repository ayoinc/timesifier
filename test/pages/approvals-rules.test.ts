import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { uuidv7 } from "~/db";
import type { LeaveStatus } from "~/leave/kinds";
import type { WorkKind } from "~/leave/rules";

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
import { seedLeave } from "./leave-seed";
import { seedEntry, seedPeriod, seedProject } from "./periods-seed";

// Approvals and Reports with the timesheet rules (TS-090): requests for
// overtime and weekend work wait on Approvals beside leave and are decided the
// same way, by a manager of the person's team, an owner or an admin, never by
// the person; each request for leave shows the notice it gave; Reports counts
// each person's short-notice requests by the day their leave starts.

const APPROVALS = "/app/acme/approvals";
const REPORTS = "/app/acme/reports";
/** Monday 5 to Sunday 11 October 2026. */
const WEEK = "range=custom&from=2026-10-05&to=2026-10-11";
const NOT_ALLOWED = "Your role in this organisation does not allow that.";

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
}, 30_000);

async function memberOfAcme(role: Role, email: string): Promise<Person> {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, role);
	return who;
}

/** Grace in Design, which Mona manages; Linus in Ops, which Nils manages; Bob in no team. */
async function seedPeople() {
	const grace = await memberOfAcme("member", "grace@example.com");
	const mona = await memberOfAcme("member", "mona@example.com");
	const linus = await memberOfAcme("member", "linus@example.com");
	const nils = await memberOfAcme("member", "nils@example.com");
	const bob = await memberOfAcme("member", "bob@example.com");
	await seedTeam(acme.id, "Design", { members: [grace.user.id], managers: [mona.user.id] });
	await seedTeam(acme.id, "Ops", { members: [linus.user.id], managers: [nils.user.id] });
	return { grace, mona, linus, nils, bob };
}

/** A request of `userId` for overtime or weekend work, written straight to the database. */
async function seedWork(
	userId: string,
	kind: WorkKind,
	startsOn: string,
	endsOn: string,
	{ minutesPerDay = 120, reason = null as string | null, status = "pending" as LeaveStatus } = {},
): Promise<string> {
	const id = uuidv7();
	const now = Date.now();
	await env.DB.prepare(
		"insert into work_requests (id, organisation_id, user_id, kind, starts_on, ends_on, minutes_per_day, reason, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(id, acme.id, userId, kind, startsOn, endsOn, minutesPerDay, reason, status, now, now)
		.run();
	return id;
}

/** Marks a request for leave as made `days` before it starts, at short notice or not, with its reason. */
async function giveNotice(id: string, days: number, short: boolean, reason: string | null = null) {
	await env.DB.prepare(
		"update leave_requests set notice_days = ?, short_notice = ?, notice_reason = ? where id = ?",
	)
		.bind(days, short ? 1 : 0, reason, id)
		.run();
}

const ask = async (who: Person, fields: Record<string, string>) => {
	const response = await submit(APPROVALS, fields, who, { byScript: true });
	return { status: response.status, said: await response.text() };
};

const workStatusOf = (id: string) =>
	value<string>("select status from work_requests where id = ?", id);

describe("overtime and weekend work on Approvals", () => {
	it("lists the requests waiting for the person's decision, with kind, days, hours a day and reason", async () => {
		const { grace, linus, mona } = await seedPeople();
		await seedWork(grace.user.id, "overtime", "2099-12-14", "2099-12-15", {
			minutesPerDay: 90,
			reason: "Release week",
		});
		await seedWork(linus.user.id, "weekend", "2099-12-19", "2099-12-19", { minutesPerDay: 240 });
		// Decided and own requests are not waiting.
		await seedWork(grace.user.id, "weekend", "2099-12-12", "2099-12-12", { status: "approved" });
		await seedWork(ada.user.id, "overtime", "2099-12-14", "2099-12-14");

		const html = await pageBody(await open(APPROVALS, ada));
		const text = textOf(html);
		expect(text).toContain("Time off waiting");
		expect(text).toContain("Overtime and weekend work 2");
		expect(text).toContain(
			"grace@example.com · Overtime 14–15 December 2099 · 1:30 a day “Release week”",
		);
		expect(text).toContain("linus@example.com · Weekend work 19 December 2099 · 4:00 a day");
		expect(text).not.toContain("ada@example.com · Overtime");
		expect(text).not.toContain("grace@example.com · Weekend work");
		expect(html).toContain('aria-label="Approve grace@example.com&#x27;s overtime"');
		expect(html).toContain('aria-label="Refuse linus@example.com&#x27;s weekend work"');
		expect(textOf(await pageBody(await open("/app/acme/projects", ada)))).toMatch(
			/Approvals 2 pending/,
		);

		// A manager has their team's alone.
		const theirs = textOf(await pageBody(await open(APPROVALS, mona)));
		expect(theirs).toContain("grace@example.com · Overtime");
		expect(theirs).not.toContain("linus@example.com");
	});

	it("approve-work and refuse-work are for a manager of the person's team, an owner or an admin", async () => {
		const { grace, mona, nils, linus } = await seedPeople();
		const hedy = await memberOfAcme("admin", "hedy@example.com");
		const first = await seedWork(grace.user.id, "overtime", "2099-12-14", "2099-12-15");
		const second = await seedWork(linus.user.id, "weekend", "2099-12-19", "2099-12-19");
		const third = await seedWork(grace.user.id, "weekend", "2099-12-20", "2099-12-20");

		// Nils manages another team.
		for (const intent of ["approve-work", "refuse-work"]) {
			const refused = await ask(nils, { intent, requestId: first });
			expect(refused.status).toBe(403);
			expect(refused.said).toContain(NOT_ALLOWED);
		}
		expect(await workStatusOf(first)).toBe("pending");

		const approved = await ask(mona, {
			intent: "approve-work",
			requestId: first,
			comment: "Fine.",
		});
		expect(approved.status).toBe(200);
		expect(approved.said).toContain("Request approved.");
		expect(
			await row("select status, decided_by, comment from work_requests where id = ?", first),
		).toEqual({ status: "approved", decided_by: mona.user.id, comment: "Fine." });

		const refused = await ask(hedy, { intent: "refuse-work", requestId: second });
		expect(refused.status).toBe(200);
		expect(refused.said).toContain("Request refused.");
		expect(await workStatusOf(second)).toBe("refused");

		// The owner decides anyone's.
		expect((await ask(ada, { intent: "approve-work", requestId: third })).status).toBe(200);
		expect(await workStatusOf(third)).toBe("approved");

		// Decided already: not again.
		for (const [who, id] of [
			[ada, first],
			[mona, first],
			[hedy, second],
		] as const) {
			const again = await ask(who, { intent: "approve-work", requestId: id });
			expect(again.status).toBe(409);
		}
		const missing = await ask(ada, { intent: "refuse-work", requestId: "nothing" });
		expect(missing.status).toBe(404);
		expect(missing.said).toContain("That request is no longer there.");
	});

	it("nobody decides their own, an owner or a manager included, and a member is not let in", async () => {
		const { grace, mona, bob } = await seedPeople();
		const own = await seedWork(ada.user.id, "overtime", "2099-12-14", "2099-12-15");
		const monas = await seedWork(mona.user.id, "weekend", "2099-12-19", "2099-12-19");
		const graces = await seedWork(grace.user.id, "overtime", "2099-12-14", "2099-12-14");

		expect((await ask(ada, { intent: "approve-work", requestId: own })).status).toBe(403);
		expect((await ask(mona, { intent: "approve-work", requestId: monas })).status).toBe(403);
		expect(textOf(await pageBody(await open(APPROVALS, mona)))).not.toContain(
			"mona@example.com · Weekend work",
		);
		expect((await open(APPROVALS, bob)).status).toBe(404);
		expect((await ask(bob, { intent: "approve-work", requestId: graces })).status).toBe(404);
		expect([
			await workStatusOf(own),
			await workStatusOf(monas),
			await workStatusOf(graces),
		]).toEqual(["pending", "pending", "pending"]);
	});
});

describe("notice on Approvals", () => {
	it("shows the notice each request for leave gave, short notice marked with its reason", async () => {
		const { grace, linus } = await seedPeople();
		const short = await seedLeave(acme.id, grace.user.id, "annual", "2099-12-14", "2099-12-18", {
			status: "pending",
		});
		await giveNotice(short, 3, true, "Family wedding");
		const noticed = await seedLeave(acme.id, linus.user.id, "annual", "2099-12-21", "2099-12-21", {
			status: "pending",
		});
		await giveNotice(noticed, 20, false);

		const html = await pageBody(await open(APPROVALS, ada));
		const text = textOf(html);
		expect(text).toContain(
			"grace@example.com · Annual leave 14–18 December 2099 · 5 days Short notice (3 days): “Family wedding”",
		);
		expect(text).toContain(
			"linus@example.com · Annual leave 21 December 2099 · 1 day 20 days' notice",
		);
		expect(text).not.toContain("Short notice (20");
	});
});

describe("short notice on Reports", () => {
	/** The People section of the report of the week, as text. */
	async function peopleOf(who: Person) {
		const response = await open(`${REPORTS}?${WEEK}`, who);
		expect(response.status).toBe(200);
		const text = textOf(await pageBody(response));
		return text.slice(text.indexOf("Worked, expected and leave"));
	}

	it("counts each person's short-notice requests whose leave starts in the range, for whoever may see them", async () => {
		const { grace, mona, linus, bob } = await seedPeople();
		// Two in the week, whatever became of them.
		for (const [startsOn, status] of [
			["2026-10-06", "pending"],
			["2026-10-09", "refused"],
		] as const) {
			const id = await seedLeave(acme.id, grace.user.id, "annual", startsOn, startsOn, { status });
			await giveNotice(id, 2, true, "Something came up");
		}
		// Not counted: withdrawn, starting after the week, or given with notice.
		const withdrawn = await seedLeave(
			acme.id,
			grace.user.id,
			"annual",
			"2026-10-07",
			"2026-10-07",
			{
				status: "withdrawn",
			},
		);
		await giveNotice(withdrawn, 1, true, "Changed my mind");
		const later = await seedLeave(acme.id, grace.user.id, "annual", "2026-10-12", "2026-10-12", {
			status: "pending",
		});
		await giveNotice(later, 1, true, "Later");
		const noticed = await seedLeave(acme.id, linus.user.id, "annual", "2026-10-08", "2026-10-08", {
			status: "pending",
		});
		await giveNotice(noticed, 30, false);

		const everyone = await peopleOf(ada);
		expect(everyone).toMatch(/grace@example\.com [^@]*Short-notice requests: 2 /);
		expect(everyone).not.toMatch(/linus@example\.com [^@]*Short-notice requests/);
		expect(everyone).not.toMatch(/ada@example\.com [^@]*Short-notice requests/);

		// Grace's manager sees it; a member sees only their own line.
		expect(await peopleOf(mona)).toMatch(/grace@example\.com [^@]*Short-notice requests: 2 /);
		const own = await peopleOf(bob);
		expect(own).not.toContain("grace@example.com");
		expect(own).not.toContain("Short-notice requests");
	});
});

describe("weeks on locked days (TR-07)", () => {
	it("a week on locked days is not returned as if it could be changed", async () => {
		// L1: Grace's week 2–8 November is submitted, then the lock date reaches it.
		const grace = await memberOfAcme("member", "grace@example.com");
		const site = await seedProject(acme.id, "Site");
		const entry = await seedEntry(
			acme.id,
			grace.user.id,
			site,
			"2026-11-03T09:00:00Z",
			"2026-11-03T16:30:00Z",
		);
		const periodId = await seedPeriod(acme.id, grace.user.id, "2026-11-02");
		const settings = "/app/acme/settings";
		await submit(settings, { intent: "lock-date", lockedThrough: "2026-11-08" }, ada, {
			byScript: true,
		});
		const week = `${APPROVALS}?week=2026-11-02`;
		const say = async (fields: Record<string, string>) => {
			const response = await submit(week, fields, ada, { byScript: true });
			return { status: response.status, said: await response.text() };
		};

		const returned = await say({
			intent: "return",
			periodId,
			comment: "Tuesday is on the wrong project.",
		});
		expect(returned.status).toBe(409);
		expect(returned.said).toContain(
			"This week is on or before the lock date, Sunday 8 November. Move the lock date back first, or approve it as it is.",
		);
		expect(await value("select status from periods where id = ?", periodId)).toBe("submitted");
		expect((await say({ intent: "approve", periodId })).status).toBe(200);
		const reopened = await say({ intent: "reopen", periodId, comment: "Wrong project." });
		expect(reopened.status).toBe(409);
		expect(reopened.said).toContain("Move the lock date back first");
		expect(await value("select status from periods where id = ?", periodId)).toBe("approved");

		// Moved back, with a reason, the week is reopened and she can change it.
		await submit(
			settings,
			{ intent: "lock-date", lockedThrough: "2026-11-01", reason: "Corrections" },
			ada,
			{
				byScript: true,
			},
		);
		expect((await say({ intent: "reopen", periodId, comment: "Wrong project." })).status).toBe(200);
		const edit = await submit(
			"/app/acme?index",
			{
				intent: "edit",
				entryId: entry,
				projectId: site,
				date: "2026-11-03",
				start: "09:00",
				end: "16:00",
			},
			grace,
			{ byScript: true },
		);
		expect(edit.status).toBe(200);
	});
});

describe("who approves (D5)", () => {
	const ADA_WEEK = `${APPROVALS}?week=2026-11-02`;

	it("nobody approves their own week, owners and admins included", async () => {
		const hedy = await memberOfAcme("admin", "hedy@example.com");
		const mine = await seedPeriod(acme.id, ada.user.id, "2026-11-02");
		const theirs = await seedPeriod(acme.id, hedy.user.id, "2026-11-02");
		const approve = (who: Person, periodId: string) =>
			submit(ADA_WEEK, { intent: "approve", periodId }, who, { byScript: true });
		expect((await approve(ada, mine)).status).toBe(403);
		expect((await approve(hedy, theirs)).status).toBe(403);
		// Nor in Approve all, and their own does not wait for them.
		await submit(ADA_WEEK, { intent: "approve-all", startsOn: "2026-11-02" }, ada, {
			byScript: true,
		});
		expect(await value("select status from periods where id = ?", mine)).toBe("submitted");
		expect(await value("select status from periods where id = ?", theirs)).toBe("approved");
		expect(textOf(await pageBody(await open("/app/acme/projects", ada)))).not.toMatch(
			/Approvals 1 pending/,
		);
		expect((await approve(hedy, mine)).status).toBe(200);
	});

	it("the system approves a week nobody else may approve, and says so", async () => {
		const site = await seedProject(acme.id, "Site");
		await seedEntry(acme.id, ada.user.id, site, "2026-11-03T09:00:00Z", "2026-11-03T10:00:00Z");
		const response = await submit(
			"/app/acme?index",
			{ intent: "submit", startsOn: "2026-11-02" },
			ada,
			{
				byScript: true,
			},
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("approved automatically: nobody else can approve it");
		expect(
			await row(
				"select status, decided_by as decidedBy, comment from periods where user_id = ?",
				ada.user.id,
			),
		).toEqual({
			status: "approved",
			decidedBy: null,
			comment: "Approved automatically: nobody else can approve it",
		});
		expect(
			await value(
				"select count(*) from period_events where action = 'approved' and actor_id is null",
			),
		).toBe(1);
	});

	async function inTwoTeams() {
		const { grace, mona, nils } = await seedPeople();
		const ops = await value<string>("select id from teams where name = 'Ops'");
		await env.DB.prepare(
			"insert into team_members (id, organisation_id, team_id, user_id, is_manager, created_at, updated_at) values (?, ?, ?, ?, 0, 0, 0)",
		)
			.bind(uuidv7(), acme.id, ops, grace.user.id)
			.run();
		return { grace, mona, nils };
	}

	it("after a manager refuses, only they or an owner or admin approve a request for the same days", async () => {
		const { grace, mona, nils } = await inTwoTeams();
		const first = await seedWork(grace.user.id, "overtime", "2099-11-10", "2099-11-10");
		expect((await ask(nils, { intent: "refuse-work", requestId: first })).status).toBe(200);
		const again = await seedWork(grace.user.id, "overtime", "2099-11-09", "2099-11-10");
		const blocked = await ask(mona, { intent: "approve-work", requestId: again });
		expect(blocked.status).toBe(403);
		expect(blocked.said).toContain(
			"nils@example.com refused these days before, so only they, an owner or an admin can approve this.",
		);
		expect(await workStatusOf(again)).toBe("pending");
		expect(textOf(await pageBody(await open(APPROVALS, mona)))).toContain(
			"nils@example.com refused these days before",
		);
		expect((await ask(nils, { intent: "approve-work", requestId: again })).status).toBe(200);

		// Leave the same: refused by Mona, asked again, approved by the owner.
		const leave = await seedLeave(acme.id, grace.user.id, "annual", "2099-12-14", "2099-12-15", {
			status: "pending",
		});
		expect((await ask(mona, { intent: "refuse-leave", requestId: leave })).status).toBe(200);
		const asked = await seedLeave(acme.id, grace.user.id, "annual", "2099-12-15", "2099-12-15", {
			status: "pending",
		});
		expect((await ask(nils, { intent: "approve-leave", requestId: asked })).status).toBe(403);
		expect((await ask(ada, { intent: "approve-leave", requestId: asked })).status).toBe(200);
	});
});

describe("a manager on leave (D6)", () => {
	it("is skipped: what waits on them is shown to owners and admins as theirs", async () => {
		const { grace, mona } = await seedPeople();
		// Mona is on annual leave all of this week and next.
		const today = new Date().toISOString().slice(0, 10);
		const until = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
		await seedLeave(acme.id, mona.user.id, "annual", today, until);
		await seedLeave(acme.id, grace.user.id, "annual", "2099-12-14", "2099-12-15", {
			status: "pending",
		});
		const owners = textOf(await pageBody(await open(APPROVALS, ada)));
		expect(owners).toContain("mona@example.com is on leave, so this waits for an owner or admin.");
		expect(textOf(await pageBody(await open("/app/acme/projects", ada)))).toMatch(
			/Approvals 1 pending/,
		);
		// Nothing waits on Mona while she is away.
		expect(textOf(await pageBody(await open("/app/acme/projects", mona)))).not.toMatch(
			/Approvals 1 pending/,
		);
	});
});
