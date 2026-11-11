import { beforeEach, describe, expect, it } from "vitest";

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
import { seedHoliday, seedLeave } from "./leave-seed";
import { seedEntry, seedPeriod, seedProject } from "./periods-seed";

// Approvals (TS-047): one period at a time, its timesheets in one status
// (Pending, Approved, Returned, Not submitted) and grouped by person or by
// project (TS-058); approve one or all, return with a comment, reopen with a
// reason. A manager decides only their teams' people and never their own period.

const APPROVALS = "/app/acme/approvals";
/** A week long past: it has closed, so who has not submitted it is listed. */
const WEEK = "2026-01-05";
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

const ask = async (who: Person, fields: Record<string, string>) => {
	const response = await submit(APPROVALS, fields, who, { byScript: true });
	return { status: response.status, said: await response.text() };
};

const statusOf = (id: string) => value<string>("select status from periods where id = ?", id);
const eventsOf = (id: string) =>
	value("select count(*) from period_events where period_id = ?", id);

describe("the page", () => {
	it("shows a period's pending, not submitted and decided people, with Previous and Next", async () => {
		const grace = await memberOfAcme("member", "grace@example.com");
		const linus = await memberOfAcme("member", "linus@example.com");
		await memberOfAcme("member", "mona@example.com");
		await seedPeriod(acme.id, grace.user.id, WEEK, "submitted");
		await seedPeriod(acme.id, linus.user.id, WEEK, "approved");

		const html = await pageBody(await open(`${APPROVALS}?week=${WEEK}`, ada));
		const text = textOf(html);
		expect(text).toContain("5–11 January 2026");
		expect(text).toContain("Pending (1)");
		expect(text).toContain("Approved (1)");
		expect(text).toContain("Returned (0)");
		expect(text).toContain("Not submitted (2)");
		expect(html).toContain('href="/app/acme/approvals?week=2025-12-29"');
		expect(html).toContain('href="/app/acme/approvals?week=2026-01-12"');
		// A pending person's name opens their week on Team.
		expect(html).toContain(`href="/app/acme/team?week=${WEEK}&amp;person=${grace.user.id}"`);

		const missing = textOf(
			await pageBody(await open(`${APPROVALS}?week=${WEEK}&status=not-submitted`, ada)),
		);
		expect(missing).toContain("ada@example.com");
		expect(missing).toContain("mona@example.com");
		// The current week, which a later one is shown as, has not closed, so nobody is listed yet.
		const current = textOf(
			await pageBody(await open(`${APPROVALS}?week=2099-01-05&status=not-submitted`, ada)),
		);
		expect(current).toContain("This week has not ended yet.");
	});

	it("links the other weeks that have something pending", async () => {
		const grace = await memberOfAcme("member", "grace@example.com");
		await seedPeriod(acme.id, grace.user.id, WEEK, "submitted");
		const html = await pageBody(await open(`${APPROVALS}?week=2026-01-12`, ada));
		expect(textOf(html)).toContain("Also waiting: 5–11 January 2026 (1)");
		expect(html).toContain(`href="/app/acme/approvals?week=${WEEK}"`);
	});

	it("puts the pending count on the Approvals link", async () => {
		const grace = await memberOfAcme("member", "grace@example.com");
		const linus = await memberOfAcme("member", "linus@example.com");
		await seedPeriod(acme.id, grace.user.id, WEEK, "submitted");
		await seedPeriod(acme.id, linus.user.id, "2026-01-12", "submitted");
		const html = await pageBody(await open("/app/acme/projects", ada));
		expect(textOf(html)).toMatch(/Approvals 2 pending/);
	});

	it("is not there for a member", async () => {
		const bob = await memberOfAcme("member", "bob@example.com");
		const period = await seedPeriod(acme.id, bob.user.id, WEEK);
		expect((await open(APPROVALS, bob)).status).toBe(404);
		expect((await ask(bob, { intent: "approve", periodId: period })).status).toBe(404);
		expect(await statusOf(period)).toBe("submitted");
	});
});

describe("decisions", () => {
	it("approve writes the status and an event in one go", async () => {
		const grace = await memberOfAcme("member", "grace@example.com");
		const period = await seedPeriod(acme.id, grace.user.id, WEEK);
		expect((await ask(ada, { intent: "approve", periodId: period })).said).toContain(
			"Timesheet approved.",
		);
		expect(await statusOf(period)).toBe("approved");
		expect(
			await row("select action, actor_id from period_events where period_id = ?", period),
		).toEqual({
			action: "approved",
			actor_id: ada.user.id,
		});
		expect(await value("select decided_by from periods where id = ?", period)).toBe(ada.user.id);

		// Approved already: approving again is refused and writes nothing.
		expect((await ask(ada, { intent: "approve", periodId: period })).status).toBe(409);
		expect(await eventsOf(period)).toBe(1);
	});

	it("approve all approves every pending period of the week", async () => {
		const grace = await memberOfAcme("member", "grace@example.com");
		const linus = await memberOfAcme("member", "linus@example.com");
		const a = await seedPeriod(acme.id, grace.user.id, WEEK);
		const b = await seedPeriod(acme.id, linus.user.id, WEEK);
		const other = await seedPeriod(acme.id, linus.user.id, "2026-01-12");
		expect((await ask(ada, { intent: "approve-all", startsOn: WEEK })).said).toContain(
			"2 timesheets approved.",
		);
		expect([await statusOf(a), await statusOf(b), await statusOf(other)]).toEqual([
			"approved",
			"approved",
			"submitted",
		]);
		expect(await value("select count(*) from period_events where action = 'approved'")).toBe(2);
	});

	it("return needs a comment, which the person reads", async () => {
		const grace = await memberOfAcme("member", "grace@example.com");
		const period = await seedPeriod(acme.id, grace.user.id, WEEK);
		const empty = await ask(ada, { intent: "return", periodId: period, comment: "  " });
		expect(empty.status).toBe(400);
		expect(await statusOf(period)).toBe("submitted");

		await ask(ada, { intent: "return", periodId: period, comment: "Tuesday is missing." });
		expect(await statusOf(period)).toBe("returned");
		expect(await value("select comment from period_events where period_id = ?", period)).toBe(
			"Tuesday is missing.",
		);
		const decided = textOf(
			await pageBody(await open(`${APPROVALS}?week=${WEEK}&status=returned`, ada)),
		);
		expect(decided).toContain("Returned by ada@example.com");
		expect(decided).toContain("Tuesday is missing.");
	});

	it("an owner or admin reopens an approved period with a reason; a manager cannot", async () => {
		const mona = await memberOfAcme("member", "mona@example.com");
		const grace = await memberOfAcme("member", "grace@example.com");
		await seedTeam(acme.id, "Design", { members: [grace.user.id], managers: [mona.user.id] });
		const period = await seedPeriod(acme.id, grace.user.id, WEEK, "approved");

		const refused = await ask(mona, { intent: "reopen", periodId: period, comment: "Fix it" });
		expect(refused.status).toBe(403);
		expect(refused.said).toContain(NOT_ALLOWED);
		expect(await statusOf(period)).toBe("approved");

		expect((await ask(ada, { intent: "reopen", periodId: period, comment: "" })).status).toBe(400);
		await ask(ada, { intent: "reopen", periodId: period, comment: "Wrong project on Monday." });
		expect(await statusOf(period)).toBe("returned");
		expect(await value("select action from period_events where period_id = ?", period)).toBe(
			"reopened",
		);
	});
});

describe("a manager", () => {
	it("sees and decides only their teams' people, and never their own period", async () => {
		const mona = await memberOfAcme("member", "mona@example.com");
		const grace = await memberOfAcme("member", "grace@example.com");
		const linus = await memberOfAcme("member", "linus@example.com");
		await seedTeam(acme.id, "Design", {
			members: [grace.user.id],
			managers: [mona.user.id],
		});
		const gracePeriod = await seedPeriod(acme.id, grace.user.id, WEEK);
		const linusPeriod = await seedPeriod(acme.id, linus.user.id, WEEK);
		const ownPeriod = await seedPeriod(acme.id, mona.user.id, WEEK);

		const text = textOf(await pageBody(await open(`${APPROVALS}?week=${WEEK}`, mona)));
		expect(text).toContain("grace@example.com");
		expect(text).not.toContain("linus@example.com");
		expect(text).toContain("Pending (1)");

		for (const periodId of [linusPeriod, ownPeriod]) {
			const refused = await ask(mona, { intent: "approve", periodId });
			expect(refused.status).toBe(403);
			expect(await statusOf(periodId)).toBe("submitted");
		}
		await ask(mona, { intent: "approve-all", startsOn: WEEK });
		expect(await statusOf(gracePeriod)).toBe("approved");
		expect(await statusOf(linusPeriod)).toBe("submitted");
		expect(await statusOf(ownPeriod)).toBe("submitted");

		// The count on her link leaves out her own period and Linus's.
		await seedPeriod(acme.id, grace.user.id, "2026-01-12");
		expect(textOf(await pageBody(await open("/app/acme/projects", mona)))).toMatch(
			/Approvals 1 pending/,
		);
	});

	it("whose own team manages them too still cannot decide their own", async () => {
		const mona = await memberOfAcme("member", "mona@example.com");
		await seedTeam(acme.id, "Design", { managers: [mona.user.id] });
		const own = await seedPeriod(acme.id, mona.user.id, WEEK);
		expect((await ask(mona, { intent: "approve", periodId: own })).status).toBe(403);
		// An admin decides it.
		expect((await ask(ada, { intent: "approve", periodId: own })).status).toBe(200);
	});

	it("does not reach another organisation's period", async () => {
		const other = await createOrganisation(ada.cookie, "Other");
		const theirs = await seedPeriod(other.id, ada.user.id, WEEK);
		expect((await ask(ada, { intent: "approve", periodId: theirs })).status).toBe(404);
		expect(await statusOf(theirs)).toBe("submitted");
	});
});

describe("status and grouping (TS-058)", () => {
	/** Grace and Linus, Mona managing Grace, each with time in the week, and the two projects. */
	async function seedWeek() {
		const mona = await memberOfAcme("member", "mona@example.com");
		const grace = await memberOfAcme("member", "grace@example.com");
		const linus = await memberOfAcme("member", "linus@example.com");
		await seedTeam(acme.id, "Design", { members: [grace.user.id], managers: [mona.user.id] });
		const site = await seedProject(acme.id, "Site");
		const billing = await seedProject(acme.id, "Billing");
		await seedEntry(acme.id, grace.user.id, site, "2026-01-06T09:00:00Z", "2026-01-06T11:00:00Z");
		await seedEntry(
			acme.id,
			grace.user.id,
			billing,
			"2026-01-07T09:00:00Z",
			"2026-01-07T10:30:00Z",
		);
		await seedEntry(acme.id, linus.user.id, site, "2026-01-06T09:00:00Z", "2026-01-06T13:00:00Z");
		await seedEntry(acme.id, mona.user.id, site, "2026-01-08T09:00:00Z", "2026-01-08T17:00:00Z");
		// The week after: in no total of this one.
		await seedEntry(acme.id, grace.user.id, site, "2026-01-13T09:00:00Z", "2026-01-13T18:00:00Z");
		return { mona, grace, linus };
	}
	const page = async (who: Person, query: string) => {
		const response = await open(`${APPROVALS}?week=${WEEK}${query}`, who);
		expect(response.status).toBe(200);
		return pageBody(response);
	};

	it("lists the pending timesheets by person, each with its hours, and their total", async () => {
		const { grace, linus, mona } = await seedWeek();
		await seedPeriod(acme.id, grace.user.id, WEEK);
		await seedPeriod(acme.id, linus.user.id, WEEK);
		await seedPeriod(acme.id, mona.user.id, WEEK, "approved");

		const text = textOf(await page(ada, ""));
		expect(text).toMatch(/grace@example\.com Submitted .*? 3:30/);
		expect(text).toMatch(/linus@example\.com Submitted .*? 4:00/);
		expect(text).not.toContain("mona@example.com Submitted");
		expect(text).toContain("Total 7:30");
		// The same, asked for in the address.
		expect(textOf(await page(ada, "&status=pending&group=person"))).toContain("Total 7:30");
	});

	it("groups them by project, each with its hours and its people, and the same total", async () => {
		const { grace, linus } = await seedWeek();
		await seedPeriod(acme.id, grace.user.id, WEEK);
		await seedPeriod(acme.id, linus.user.id, WEEK);

		const text = textOf(await page(ada, "&group=project"));
		// Projects in name order.
		expect(text).toMatch(
			/Billing grace@example\.com 1:30 Site grace@example\.com, linus@example\.com 6:00 Total 7:30/,
		);
	});

	it("shows each status in the address, with the period's hours", async () => {
		const { grace, linus } = await seedWeek();
		await seedPeriod(acme.id, grace.user.id, WEEK, "approved");
		await seedPeriod(acme.id, linus.user.id, WEEK, "returned");

		const approved = textOf(await page(ada, "&status=approved"));
		expect(approved).toMatch(/grace@example\.com Approved by .*? 3:30/);
		expect(approved).not.toContain("linus@example.com");
		expect(approved).toContain("Total 3:30");

		const returned = textOf(await page(ada, "&status=returned&group=project"));
		expect(returned).toMatch(/Site linus@example\.com 4:00 Total 4:00/);

		// Not submitted: Ada, who has no time, and Mona, who has eight hours.
		const missing = textOf(await page(ada, "&status=not-submitted"));
		expect(missing).toContain("ada@example.com");
		expect(missing).toMatch(/mona@example\.com Not submitted 8:00/);
		expect(missing).toContain("Total 8:00");
		expect(missing).not.toContain(grace.user.email);
	});

	it("says when a status has nothing in it", async () => {
		await seedWeek();
		expect(textOf(await page(ada, "&status=approved"))).toContain(
			"Nothing has been approved for this week.",
		);
		expect(textOf(await page(ada, "&status=returned&group=project"))).toContain(
			"Nothing has been returned for this week.",
		);
	});

	it("keeps the status and the grouping on the arrows to other weeks", async () => {
		const html = await page(ada, "&status=approved&group=project");
		expect(html).toContain(
			'href="/app/acme/approvals?week=2025-12-29&amp;status=approved&amp;group=project"',
		);
		expect(html).toContain(
			'href="/app/acme/approvals?week=2026-01-12&amp;status=approved&amp;group=project"',
		);
	});

	it.each([
		["an owner", () => ada],
		["an admin", async () => memberOfAcme("admin", "hedy@example.com")],
	])("shows %s everyone's time", async (_, who) => {
		const { grace, linus, mona } = await seedWeek();
		const viewer = await who();
		for (const each of [grace, linus, mona]) await seedPeriod(acme.id, each.user.id, WEEK);
		expect(textOf(await page(viewer, ""))).toContain("Total 15:30");
		expect(textOf(await page(viewer, "&group=project"))).toMatch(/Site .*? 14:00 Total 15:30/);
	});

	it("shows a manager only their teams' people's time, never their own", async () => {
		const { grace, linus, mona } = await seedWeek();
		for (const each of [grace, linus, mona]) await seedPeriod(acme.id, each.user.id, WEEK);

		const byPerson = textOf(await page(mona, ""));
		expect(byPerson).toContain("grace@example.com");
		expect(byPerson).not.toContain("linus@example.com");
		expect(byPerson).not.toContain("mona@example.com Submitted");
		expect(byPerson).toContain("Total 3:30");

		const byProject = textOf(await page(mona, "&group=project"));
		expect(byProject).toMatch(
			/Billing grace@example\.com 1:30 Site grace@example\.com 2:00 Total 3:30/,
		);
		expect(byProject).not.toContain("linus@example.com");

		// Not submitted holds nobody of hers either: Grace submitted, Linus and Mona are not hers.
		const missing = textOf(await page(mona, "&status=not-submitted"));
		expect(missing).toContain("Everyone has submitted this week.");
	});

	it("is not there for a member, whatever the status or grouping", async () => {
		const bob = await memberOfAcme("member", "bob@example.com");
		expect((await open(`${APPROVALS}?status=approved&group=project`, bob)).status).toBe(404);
	});

	it("answers 400 to a status or a grouping that is not one", async () => {
		expect((await open(`${APPROVALS}?status=decided`, ada)).status).toBe(400);
		expect((await open(`${APPROVALS}?group=client`, ada)).status).toBe(400);
	});

	it.each([
		["pending", "status=pending"],
		["not-submitted", "status=not-submitted"],
		["decided", "status=approved"],
	])("sends an address of the old %s tab to its status, keeping the week", async (tab, status) => {
		const response = await open(`${APPROVALS}?week=${WEEK}&tab=${tab}`, ada);
		expect(response.status).toBe(301);
		expect(response.headers.get("location")).toBe(`${APPROVALS}?week=${WEEK}&${status}`);
	});

	it("drops a tab that never was", async () => {
		const response = await open(`${APPROVALS}?tab=nothing`, ada);
		expect(response.status).toBe(301);
		expect(response.headers.get("location")).toBe(APPROVALS);
	});
});

describe("time off waiting (TS-061)", () => {
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

	const leaveStatusOf = (id: string) =>
		value<string>("select status from leave_requests where id = ?", id);

	it("lists the requests waiting for the person's decision, whatever week, and counts them on the link", async () => {
		const { grace, linus, mona } = await seedPeople();
		await seedLeave(acme.id, grace.user.id, "annual", "2026-12-14", "2026-12-18", {
			status: "pending",
		});
		await seedLeave(acme.id, linus.user.id, "study", "2026-12-21", "2026-12-21", {
			status: "pending",
			startsHalf: true,
		});
		// Decided and own requests are not waiting.
		await seedLeave(acme.id, grace.user.id, "sick", "2026-12-01", "2026-12-01");
		await seedLeave(acme.id, ada.user.id, "annual", "2026-12-07", "2026-12-07", {
			status: "pending",
		});

		const html = await pageBody(await open(`${APPROVALS}?week=${WEEK}`, ada));
		const text = textOf(html);
		expect(text).toContain("Time off waiting");
		expect(text).toContain("grace@example.com · Annual leave 14–18 December 2026 · 5 days");
		expect(text).toContain(
			"linus@example.com · Study leave 21 December 2026, half day · half a day",
		);
		expect(text).not.toContain("ada@example.com · Annual leave");
		expect(text).not.toContain("Sick leave");
		expect(html).toContain('aria-label="Approve grace@example.com&#x27;s annual leave"');
		expect(html).toContain('aria-label="Refuse linus@example.com&#x27;s study leave"');
		expect(textOf(await pageBody(await open("/app/acme/projects", ada)))).toMatch(
			/Approvals 2 pending/,
		);

		// A manager has their team's alone.
		const theirs = textOf(await pageBody(await open(APPROVALS, mona)));
		expect(theirs).toContain("grace@example.com · Annual leave");
		expect(theirs).not.toContain("linus@example.com");
		expect(textOf(await pageBody(await open("/app/acme/projects", mona)))).toMatch(
			/Approvals 1 pending/,
		);
	});

	it("is not there when nothing waits", async () => {
		await seedPeople();
		expect(textOf(await pageBody(await open(APPROVALS, ada)))).not.toContain("Time off waiting");
	});

	it("approve-leave and refuse-leave are for a manager of the person's team, an owner or an admin", async () => {
		const { grace, mona, nils, linus } = await seedPeople();
		const hedy = await memberOfAcme("admin", "hedy@example.com");
		const first = await seedLeave(acme.id, grace.user.id, "annual", "2026-12-14", "2026-12-18", {
			status: "pending",
		});
		const second = await seedLeave(acme.id, linus.user.id, "annual", "2026-12-14", "2026-12-18", {
			status: "pending",
		});
		const third = await seedLeave(acme.id, grace.user.id, "unpaid", "2026-12-21", "2026-12-21", {
			status: "pending",
		});

		for (const intent of ["approve-leave", "refuse-leave"]) {
			const refused = await ask(nils, { intent, requestId: first });
			expect(refused.status).toBe(403);
			expect(refused.said).toContain(NOT_ALLOWED);
		}
		expect(await leaveStatusOf(first)).toBe("pending");

		const approved = await ask(mona, {
			intent: "approve-leave",
			requestId: first,
			comment: "Fine.",
		});
		expect(approved.status).toBe(200);
		expect(approved.said).toContain("Leave approved.");
		expect(
			await row("select status, decided_by, comment from leave_requests where id = ?", first),
		).toEqual({ status: "approved", decided_by: mona.user.id, comment: "Fine." });

		const refused = await ask(hedy, { intent: "refuse-leave", requestId: second });
		expect(refused.status).toBe(200);
		expect(refused.said).toContain("Leave refused.");
		expect(await leaveStatusOf(second)).toBe("refused");

		expect((await ask(ada, { intent: "approve-leave", requestId: third })).status).toBe(200);
		expect(await leaveStatusOf(third)).toBe("approved");

		// Decided already: not again.
		for (const [who, id] of [
			[ada, first],
			[mona, first],
			[hedy, second],
		] as const) {
			expect((await ask(who, { intent: "approve-leave", requestId: id })).status).toBe(409);
		}
		expect((await ask(ada, { intent: "approve-leave", requestId: "nothing" })).status).toBe(404);
	});

	it("nobody decides their own, an owner included, and a member is not let in", async () => {
		const { mona, bob } = await seedPeople();
		const own = await seedLeave(acme.id, ada.user.id, "annual", "2026-12-14", "2026-12-18", {
			status: "pending",
		});
		const monas = await seedLeave(acme.id, mona.user.id, "annual", "2026-12-14", "2026-12-18", {
			status: "pending",
		});
		expect((await ask(ada, { intent: "approve-leave", requestId: own })).status).toBe(403);
		expect((await ask(mona, { intent: "approve-leave", requestId: monas })).status).toBe(403);
		expect((await ask(bob, { intent: "refuse-leave", requestId: monas })).status).toBe(404);
		expect([await leaveStatusOf(own), await leaveStatusOf(monas)]).toEqual(["pending", "pending"]);
	});

	it("leaves out of Not submitted whoever had nothing to work in the week", async () => {
		const { grace, linus, mona } = await seedPeople();
		// Grace was on leave all week; Mona on leave until Thursday, and Friday a public holiday.
		await seedLeave(acme.id, grace.user.id, "annual", WEEK, "2026-01-09");
		await seedLeave(acme.id, mona.user.id, "sick", WEEK, "2026-01-08");
		await seedHoliday(acme.id, "2026-01-09", "Founders' Day");
		// Linus worked Thursday afternoon, the holiday aside; Ada's leave was never approved.
		await seedLeave(acme.id, linus.user.id, "annual", WEEK, "2026-01-08", { endsHalf: true });
		await seedLeave(acme.id, ada.user.id, "annual", WEEK, "2026-01-09", { status: "pending" });

		const text = textOf(
			await pageBody(await open(`${APPROVALS}?week=${WEEK}&status=not-submitted`, ada)),
		);
		expect(text).toContain("Not submitted (4)");
		for (const listed of ["ada@", "linus@", "nils@", "bob@"]) expect(text).toContain(listed);
		for (const away of ["grace@", "mona@"]) expect(text).not.toContain(away);
	});
});
