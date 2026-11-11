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
import { seedPeriod } from "./periods-seed";

// Approvals (TS-047): one period at a time, Pending, Not submitted and
// Decided; approve one or all, return with a comment, reopen with a reason.
// A manager decides only their teams' people and never their own period.

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
		expect(text).toContain("5 to 11 January 2026");
		expect(text).toContain("Pending (1)");
		expect(text).toContain("Not submitted (2)");
		expect(text).toContain("Decided (1)");
		expect(html).toContain('href="/app/acme/approvals?week=2025-12-29"');
		expect(html).toContain('href="/app/acme/approvals?week=2026-01-12"');
		// A pending person's name opens their week on Team.
		expect(html).toContain(`href="/app/acme/team?week=${WEEK}&amp;person=${grace.user.id}"`);

		const missing = textOf(
			await pageBody(await open(`${APPROVALS}?week=${WEEK}&tab=not-submitted`, ada)),
		);
		expect(missing).toContain("ada@example.com");
		expect(missing).toContain("mona@example.com");
		// The current week, which a later one is shown as, has not closed, so nobody is listed yet.
		const current = textOf(
			await pageBody(await open(`${APPROVALS}?week=2099-01-05&tab=not-submitted`, ada)),
		);
		expect(current).toContain("This week has not ended yet.");
	});

	it("opens on the latest week with something pending", async () => {
		const grace = await memberOfAcme("member", "grace@example.com");
		await seedPeriod(acme.id, grace.user.id, WEEK, "submitted");
		expect(textOf(await pageBody(await open(APPROVALS, ada)))).toContain("5 to 11 January 2026");
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
			await pageBody(await open(`${APPROVALS}?week=${WEEK}&tab=decided`, ada)),
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
