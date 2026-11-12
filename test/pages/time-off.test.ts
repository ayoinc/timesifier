import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { kindOf, seedLeave } from "./leave-seed";

// Time off (TS-061): asking for leave, withdrawing it, deciding it and
// cancelling it, through the page's own actions, for each role. Ada owns Acme,
// Hedy is an admin, Mona manages Design, which holds Grace, Nils manages Ops,
// which holds Linus, and Bob is in no team.

const TIME_OFF = "/app/acme/time-off";
const SETTINGS = "/app/acme/settings";
const NOT_ALLOWED = "Your role in this organisation does not allow that.";
/** A Wednesday: the server's clock for every test here. */
const T0 = Date.parse("2026-11-11T10:00:00Z");

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

async function memberOfAcme(role: Role, email: string): Promise<Person> {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, role);
	return who;
}

/**
 * Everyone in Acme, in their teams, and the server's clock fixed at T0 for
 * what follows. Signing in reads the real clock, so it comes first.
 */
async function seedPeople() {
	const hedy = await memberOfAcme("admin", "hedy@example.com");
	const mona = await memberOfAcme("member", "mona@example.com");
	const grace = await memberOfAcme("member", "grace@example.com");
	const nils = await memberOfAcme("member", "nils@example.com");
	const linus = await memberOfAcme("member", "linus@example.com");
	const bob = await memberOfAcme("member", "bob@example.com");
	await seedTeam(acme.id, "Design", { members: [grace.user.id], managers: [mona.user.id] });
	await seedTeam(acme.id, "Ops", { members: [linus.user.id], managers: [nils.user.id] });
	vi.spyOn(Date, "now").mockReturnValue(T0);
	return { hedy, mona, grace, nils, linus, bob };
}

/** What the page's action answered a form sent by script. */
async function ask(who: Person, fields: Record<string, string>, path = TIME_OFF) {
	const response = await submit(path, fields, who, { byScript: true });
	return { status: response.status, said: await response.text() };
}

/** Asks for leave of `key` as `who`, and returns the answer and the id of the request made, if any. */
async function requestLeave(
	who: Person,
	key: "annual" | "sick" | "study" | "parental" | "unpaid" | "holiday",
	startsOn: string,
	endsOn: string,
	more: Record<string, string> = {},
) {
	const before = await value<number>("select count(*) from leave_requests");
	const answer = await ask(who, {
		intent: "request",
		kindId: await kindOf(acme.id, key),
		startsOn,
		endsOn,
		...more,
	});
	const made = (await value<number>("select count(*) from leave_requests")) !== before;
	const id = made
		? await value<string>(
				"select id from leave_requests where user_id = ? order by created_at desc, id desc limit 1",
				who.user.id,
			)
		: null;
	return { ...answer, id };
}

const statusOf = (id: string | null) =>
	value<string>("select status from leave_requests where id = ?", id);
const countRequests = () => value<number>("select count(*) from leave_requests");

async function textAt(path: string, who: Person) {
	const response = await open(path, who);
	expect(response.status, path).toBe(200);
	return textOf(await pageBody(response));
}

describe("asking for leave", () => {
	it("a kind that needs approval waits; sick leave is approved at once", async () => {
		const { grace } = await seedPeople();
		const annual = await requestLeave(grace, "annual", "2026-11-16", "2026-11-20", {
			note: "Family visit",
		});
		expect(annual.status).toBe(200);
		expect(annual.said).toContain("Requested. It waits for a manager's approval.");
		expect(
			await row(
				"select status, starts_half, ends_half, note, decided_at from leave_requests where id = ?",
				annual.id,
			),
		).toEqual({
			status: "pending",
			starts_half: 0,
			ends_half: 0,
			note: "Family visit",
			decided_at: null,
		});

		const sick = await requestLeave(grace, "sick", "2026-11-10", "2026-11-10");
		expect(sick.status).toBe(200);
		expect(sick.said).toContain("Recorded. It needs nobody's approval.");
		expect(await statusOf(sick.id)).toBe("approved");
		expect(
			await value("select decided_at is not null from leave_requests where id = ?", sick.id),
		).toBe(1);

		const text = await textAt(TIME_OFF, grace);
		expect(text).toMatch(/Annual leave · Waiting for approval 16–20 November 2026 · 5 days/);
		expect(text).toContain("Your note: “Family visit”");
		expect(text).toMatch(/Sick leave · Approved 10 November 2026 · 1 day/);
	});

	it("takes half days: one day's, and the first and last of a longer request", async () => {
		const { grace } = await seedPeople();
		const half = await requestLeave(grace, "annual", "2026-11-16", "2026-11-16", {
			startsHalf: "on",
			// A request of one day has no second half to take.
			endsHalf: "on",
		});
		expect(half.status).toBe(200);
		expect(
			await row("select starts_half, ends_half from leave_requests where id = ?", half.id),
		).toEqual({
			starts_half: 1,
			ends_half: 0,
		});
		await requestLeave(grace, "annual", "2026-11-23", "2026-11-27", {
			startsHalf: "on",
			endsHalf: "on",
		});
		const text = await textAt(TIME_OFF, grace);
		expect(text).toContain("16 November 2026, half day · half a day");
		expect(text).toContain("23–27 November 2026, half days at the start and the end · 4 days");
	});

	it("refuses a kind switched off and the public holidays, which nobody asks for", async () => {
		const { grace, hedy } = await seedPeople();
		expect(
			(
				await ask(
					hedy,
					{ intent: "kind", kindId: await kindOf(acme.id, "study"), name: "Study leave" },
					SETTINGS,
				)
			).status,
		).toBe(200);
		for (const key of ["study", "holiday"] as const) {
			const refused = await requestLeave(grace, key, "2026-11-16", "2026-11-16");
			expect(refused.status, key).toBe(400);
			expect(refused.said).toContain("Choose a kind of leave.");
		}
		// The kinds she may choose leave them out.
		const html = await pageBody(await open(TIME_OFF, grace));
		expect(html).toContain(await kindOf(acme.id, "annual"));
		expect(html).not.toContain(await kindOf(acme.id, "study"));
		expect(await countRequests()).toBe(0);
	});

	it("refuses days that hold no working day: a weekend, a public holiday, both", async () => {
		const { grace } = await seedPeople();
		await ask(ada, { intent: "add-holiday", day: "2026-12-25", name: "Christmas Day" }, SETTINGS);
		await ask(ada, { intent: "add-holiday", day: "2026-12-28", name: "Boxing Day" }, SETTINGS);
		for (const [startsOn, endsOn] of [
			["2026-11-21", "2026-11-22"],
			["2026-12-25", "2026-12-25"],
			["2026-12-25", "2026-12-28"],
		] as const) {
			const refused = await requestLeave(grace, "annual", startsOn, endsOn);
			expect(refused.status).toBe(400);
			expect(refused.said).toContain("These days hold no working day to take.");
		}
		// Over them, it takes the working days alone: the 24th and the 29th.
		await requestLeave(grace, "annual", "2026-12-24", "2026-12-29");
		expect(await textAt(TIME_OFF, grace)).toContain("24–29 December 2026 · 2 days");
	});

	it("refuses a last day before the first, and a day that is not one", async () => {
		const { grace } = await seedPeople();
		expect((await requestLeave(grace, "annual", "2026-11-20", "2026-11-16")).status).toBe(400);
		expect((await requestLeave(grace, "annual", "2026-11-31", "2026-12-01")).status).toBe(400);
		expect(await countRequests()).toBe(0);
	});

	it("refuses days already asked for, pending or approved, and not those withdrawn or refused", async () => {
		const { grace, mona } = await seedPeople();
		const first = await requestLeave(grace, "annual", "2026-11-16", "2026-11-20");
		const overlapping = await requestLeave(grace, "sick", "2026-11-20", "2026-11-24");
		expect(overlapping.status).toBe(400);
		expect(overlapping.said).toContain("You have already asked for leave on some of these days.");

		await ask(grace, { intent: "withdraw", requestId: first.id ?? "" });
		const second = await requestLeave(grace, "annual", "2026-11-18", "2026-11-19");
		expect(second.status).toBe(200);
		await ask(mona, { intent: "refuse", requestId: second.id ?? "" });
		expect((await requestLeave(grace, "annual", "2026-11-19", "2026-11-19")).status).toBe(200);
		// Another person's days are their own.
		expect((await requestLeave(mona, "annual", "2026-11-19", "2026-11-19")).status).toBe(200);
		// Approved leave holds its days too.
		await requestLeave(grace, "sick", "2026-11-25", "2026-11-25");
		expect((await requestLeave(grace, "annual", "2026-11-25", "2026-11-26")).status).toBe(400);
	});

	it("refuses more than the allowance leaves in the year, counting pending and approved days", async () => {
		const { grace, mona } = await seedPeople();
		// 20 days, approved, and 4.5 more waiting: half a day is left of 25.
		const june = await requestLeave(grace, "annual", "2026-06-01", "2026-06-26");
		await ask(mona, { intent: "approve", requestId: june.id ?? "" });
		await requestLeave(grace, "annual", "2026-07-06", "2026-07-10", { startsHalf: "on" });

		const over = await requestLeave(grace, "annual", "2026-12-01", "2026-12-01");
		expect(over.status).toBe(400);
		expect(over.said).toContain("That is more annual leave than you have left in 2026.");
		expect(
			(await requestLeave(grace, "annual", "2026-12-01", "2026-12-01", { startsHalf: "on" }))
				.status,
		).toBe(200);
		// A kind with no allowance has no limit.
		expect((await requestLeave(grace, "unpaid", "2026-08-03", "2026-10-30")).status).toBe(200);
	});

	it("counts a request over the year's end against each year's allowance", async () => {
		const { grace } = await seedPeople();
		await ask(ada, { intent: "add-holiday", day: "2027-01-01", name: "New Year's Day" }, SETTINGS);
		// 20 days of 2026 waiting: 5 days left of it.
		await requestLeave(grace, "annual", "2026-06-01", "2026-06-26");

		// 28 December 2026 to 5 January 2027 takes 4 days of 2026 and 2 of 2027.
		const winter = await requestLeave(grace, "annual", "2026-12-28", "2027-01-05");
		expect(winter.status).toBe(200);
		// One day of 2026 is left: 14 to 24 December would take 9.
		const longer = await requestLeave(grace, "annual", "2026-12-14", "2026-12-24");
		expect(longer.status).toBe(400);
		expect(longer.said).toContain("than you have left in 2026");
		// 2027 has 23 days left: 6 weeks of it are more.
		const next = await requestLeave(grace, "annual", "2027-01-11", "2027-02-19");
		expect(next.status).toBe(400);
		expect(next.said).toContain("than you have left in 2027");
		expect((await requestLeave(grace, "annual", "2027-01-11", "2027-02-10")).status).toBe(200);

		expect(await textAt(TIME_OFF, grace)).toContain(
			"Annual leave 25 days a year. Taken: 0 days; waiting: 24 days. 1 day left",
		);
	});
});

describe("the balance", () => {
	it("starts at 25 days of annual leave, and takes the approved and the pending days from it", async () => {
		const { grace, mona } = await seedPeople();
		let text = await textAt(TIME_OFF, grace);
		expect(text).toContain("Your balance, 2026");
		expect(text).toContain("Annual leave 25 days a year. Taken: 0 days. 25 days left");
		expect(text).toContain("Sick leave No allowance. Taken: 0 days.");
		expect(text).toContain("You have not asked for any time off yet.");

		const approved = await requestLeave(grace, "annual", "2026-11-16", "2026-11-17");
		await ask(mona, { intent: "approve", requestId: approved.id ?? "" });
		await requestLeave(grace, "annual", "2026-11-23", "2026-11-24", { startsHalf: "on" });
		await requestLeave(grace, "sick", "2026-11-10", "2026-11-10");
		// Neither refused nor withdrawn leave is counted.
		const refused = await requestLeave(grace, "annual", "2026-12-01", "2026-12-04");
		await ask(mona, { intent: "refuse", requestId: refused.id ?? "", comment: "Not that week." });
		const withdrawn = await requestLeave(grace, "annual", "2026-12-07", "2026-12-07");
		await ask(grace, { intent: "withdraw", requestId: withdrawn.id ?? "" });

		text = await textAt(TIME_OFF, grace);
		expect(text).toContain(
			"Annual leave 25 days a year. Taken: 2 days; waiting: 1.5 days. 21.5 days left",
		);
		expect(text).toContain("Sick leave No allowance. Taken: 1 day.");
		expect(text).toMatch(/Annual leave · Refused 1–4 December 2026 · 4 days “Not that week.”/);
		expect(text).toContain("Annual leave · Withdrawn");
	});

	it("follows the allowance an owner sets", async () => {
		const { grace } = await seedPeople();
		await ask(
			ada,
			{
				intent: "kind",
				kindId: await kindOf(acme.id, "annual"),
				name: "Holiday",
				enabled: "on",
				needsApproval: "on",
				allowanceDays: "30.5",
			},
			SETTINGS,
		);
		expect(await textAt(TIME_OFF, grace)).toContain(
			"Holiday 30.5 days a year. Taken: 0 days. 30.5 days left",
		);
	});
});

describe("withdrawing a request", () => {
	it("is for its own person, while it is pending", async () => {
		const { grace, mona, hedy } = await seedPeople();
		const pending = await requestLeave(grace, "annual", "2026-11-16", "2026-11-20");

		for (const who of [ada, hedy, mona]) {
			const refused = await ask(who, { intent: "withdraw", requestId: pending.id ?? "" });
			expect(refused.status).toBe(403);
			expect(refused.said).toContain(NOT_ALLOWED);
		}
		expect(await statusOf(pending.id)).toBe("pending");

		const done = await ask(grace, { intent: "withdraw", requestId: pending.id ?? "" });
		expect(done.status).toBe(200);
		expect(done.said).toContain("Request withdrawn.");
		expect(await statusOf(pending.id)).toBe("withdrawn");
		// Withdrawn already: not again.
		expect((await ask(grace, { intent: "withdraw", requestId: pending.id ?? "" })).status).toBe(
			409,
		);
	});

	it("is refused once it is decided, and for a request that is not there", async () => {
		const { grace } = await seedPeople();
		const sick = await requestLeave(grace, "sick", "2026-11-16", "2026-11-16");
		expect((await ask(grace, { intent: "withdraw", requestId: sick.id ?? "" })).status).toBe(409);
		expect(await statusOf(sick.id)).toBe("approved");
		expect((await ask(grace, { intent: "withdraw", requestId: "nothing" })).status).toBe(404);
	});
});

describe("approving and refusing", () => {
	it("a manager of the person's team decides; a manager of another team and a member may not", async () => {
		const { grace, mona, nils, bob, linus } = await seedPeople();
		const pending = await requestLeave(grace, "annual", "2026-11-16", "2026-11-20");

		for (const who of [nils, bob, linus]) {
			for (const intent of ["approve", "refuse"]) {
				const refused = await ask(who, { intent, requestId: pending.id ?? "" });
				expect(refused.status).toBe(403);
				expect(refused.said).toContain(NOT_ALLOWED);
			}
		}
		expect(await statusOf(pending.id)).toBe("pending");

		const approved = await ask(mona, {
			intent: "approve",
			requestId: pending.id ?? "",
			comment: "Enjoy it.",
		});
		expect(approved.status).toBe(200);
		expect(approved.said).toContain("Leave approved.");
		expect(
			await row("select status, decided_by, comment from leave_requests where id = ?", pending.id),
		).toEqual({ status: "approved", decided_by: mona.user.id, comment: "Enjoy it." });
		expect(await textAt(TIME_OFF, grace)).toContain("Annual leave · Approved");
	});

	it.each([
		["an owner", () => ada],
		["an admin", (people: { hedy: Person }) => people.hedy],
	])("%s decides anybody's but their own", async (_, pick) => {
		const people = await seedPeople();
		const decider = pick(people);
		const theirs = await requestLeave(people.linus, "parental", "2026-11-16", "2026-11-20");
		const refused = await ask(decider, { intent: "refuse", requestId: theirs.id ?? "" });
		expect(refused.status).toBe(200);
		expect(refused.said).toContain("Leave refused.");
		expect(await statusOf(theirs.id)).toBe("refused");

		const own = await requestLeave(decider, "annual", "2026-11-16", "2026-11-20");
		expect((await ask(decider, { intent: "approve", requestId: own.id ?? "" })).status).toBe(403);
		expect(await statusOf(own.id)).toBe("pending");
	});

	it("a manager never decides their own, even in a team they are in", async () => {
		const { mona, nils } = await seedPeople();
		// Mona manages Design and is in Leads, which Nils manages.
		await seedTeam(acme.id, "Leads", { members: [mona.user.id], managers: [nils.user.id] });
		const own = await requestLeave(mona, "annual", "2026-11-16", "2026-11-20");
		expect((await ask(mona, { intent: "approve", requestId: own.id ?? "" })).status).toBe(403);
		expect(await statusOf(own.id)).toBe("pending");
		expect((await ask(nils, { intent: "approve", requestId: own.id ?? "" })).status).toBe(200);
	});

	it("never decides a request twice", async () => {
		const { grace, mona } = await seedPeople();
		const pending = await requestLeave(grace, "annual", "2026-11-16", "2026-11-20");
		await ask(mona, { intent: "approve", requestId: pending.id ?? "" });
		for (const [who, intent] of [
			[mona, "approve"],
			[mona, "refuse"],
			[ada, "refuse"],
		] as const) {
			expect((await ask(who, { intent, requestId: pending.id ?? "" })).status).toBe(409);
		}
		expect(
			await row("select status, decided_by from leave_requests where id = ?", pending.id),
		).toEqual({ status: "approved", decided_by: mona.user.id });

		const withdrawn = await requestLeave(grace, "annual", "2026-11-23", "2026-11-23");
		await ask(grace, { intent: "withdraw", requestId: withdrawn.id ?? "" });
		expect((await ask(mona, { intent: "approve", requestId: withdrawn.id ?? "" })).status).toBe(
			409,
		);
	});

	it("does not reach another organisation's request", async () => {
		const other = await createOrganisation(ada.cookie, "Other");
		const theirs = await seedLeave(other.id, ada.user.id, "annual", "2026-11-16", "2026-11-20", {
			status: "pending",
		});
		expect((await ask(ada, { intent: "approve", requestId: theirs })).status).toBe(404);
		expect(await statusOf(theirs)).toBe("pending");
	});
});

describe("cancelling approved leave", () => {
	/** Grace's annual leave in December, approved by Mona. */
	async function approvedLeave() {
		const people = await seedPeople();
		const made = await requestLeave(people.grace, "annual", "2026-12-14", "2026-12-18");
		await ask(people.mona, { intent: "approve", requestId: made.id ?? "" });
		return { ...people, id: made.id ?? "" };
	}

	it.each([
		["an owner", () => ada],
		["an admin", (people: { hedy: Person }) => people.hedy],
	])("%s cancels another's leave to come, with a reason they read", async (_, pick) => {
		const people = await approvedLeave();
		const canceller = pick(people);
		const empty = await ask(canceller, { intent: "cancel", requestId: people.id, comment: "  " });
		expect(empty.status).toBe(400);
		expect(empty.said).toContain("Say why, in 1 to 500 characters.");
		expect(await statusOf(people.id)).toBe("approved");

		const done = await ask(canceller, {
			intent: "cancel",
			requestId: people.id,
			comment: "The launch moved.",
		});
		expect(done.status).toBe(200);
		expect(done.said).toContain("Leave cancelled.");
		expect(
			await row("select status, decided_by, comment from leave_requests where id = ?", people.id),
		).toEqual({ status: "cancelled", decided_by: canceller.user.id, comment: "The launch moved." });
		expect(await textAt(TIME_OFF, people.grace)).toMatch(
			/Annual leave · Cancelled 14–18 December 2026 · 5 days “The launch moved\.”/,
		);
		// The days are hers to ask for again.
		expect((await requestLeave(people.grace, "annual", "2026-12-14", "2026-12-14")).status).toBe(
			200,
		);
	});

	it("is not for a manager, the person, or a member", async () => {
		const { mona, grace, bob, id } = await approvedLeave();
		for (const who of [mona, grace, bob]) {
			const refused = await ask(who, { intent: "cancel", requestId: id, comment: "No." });
			expect(refused.status).toBe(403);
		}
		expect(await statusOf(id)).toBe("approved");
	});

	it("is never an owner's own", async () => {
		const { hedy } = await seedPeople();
		const own = await requestLeave(ada, "annual", "2026-12-14", "2026-12-18");
		await ask(hedy, { intent: "approve", requestId: own.id ?? "" });
		expect(
			(await ask(ada, { intent: "cancel", requestId: own.id ?? "", comment: "Mine." })).status,
		).toBe(403);
		expect(await statusOf(own.id)).toBe("approved");
	});

	it("is refused for leave that has begun or ended, and for leave not approved", async () => {
		const { grace } = await seedPeople();
		const started = await requestLeave(grace, "sick", "2026-11-11", "2026-11-12");
		const past = await requestLeave(grace, "sick", "2026-11-02", "2026-11-03");
		const pending = await requestLeave(grace, "annual", "2026-12-01", "2026-12-01");
		for (const id of [started.id, past.id, pending.id]) {
			expect(
				(await ask(ada, { intent: "cancel", requestId: id ?? "", comment: "Why" })).status,
			).toBe(409);
		}
		expect([
			await statusOf(started.id),
			await statusOf(past.id),
			await statusOf(pending.id),
		]).toEqual(["approved", "approved", "pending"]);
	});
});

describe("the Requests tab", () => {
	it("is not there for a member, who sees nobody's requests but their own", async () => {
		const { grace, linus, bob } = await seedPeople();
		await requestLeave(grace, "annual", "2026-11-16", "2026-11-20");
		await requestLeave(linus, "sick", "2026-11-16", "2026-11-16");
		await requestLeave(bob, "study", "2026-11-23", "2026-11-23");

		for (const path of [TIME_OFF, `${TIME_OFF}?show=requests`]) {
			const html = await pageBody(await open(path, bob));
			const text = textOf(html);
			expect(html).not.toContain('aria-label="Time off pages"');
			expect(text).toContain("Your balance, 2026");
			expect(text).not.toContain("Waiting for you");
			expect(text).toContain("Study leave · Waiting for approval");
			for (const other of ["grace@example.com", "linus@example.com", "Sick leave · Approved"]) {
				expect(text).not.toContain(other);
			}
		}
	});

	it("lists for a manager their team's requests alone, to decide, and leave to come with no Cancel", async () => {
		const { grace, linus, mona } = await seedPeople();
		await requestLeave(grace, "annual", "2026-11-16", "2026-11-20", { note: "Wedding" });
		await requestLeave(grace, "sick", "2026-11-25", "2026-11-25");
		await requestLeave(linus, "annual", "2026-11-16", "2026-11-20");
		await requestLeave(mona, "annual", "2026-11-23", "2026-11-23");

		const mine = await pageBody(await open(TIME_OFF, mona));
		expect(mine).toContain('aria-label="Time off pages"');
		expect(textOf(mine)).toContain("Requests (1)");

		const html = await pageBody(await open(`${TIME_OFF}?show=requests`, mona));
		const text = textOf(html);
		expect(text).toMatch(
			/grace@example\.com · Annual leave 16–20 November 2026 · 5 days “Wedding”/,
		);
		expect(text).toMatch(
			/Approved, to come .*grace@example\.com · Sick leave 25 November 2026 · 1 day/,
		);
		expect(text).not.toContain("linus@example.com");
		expect(text).not.toContain("mona@example.com");
		expect(html).toContain('aria-label="Approve grace@example.com&#x27;s annual leave"');
		expect(html).not.toMatch(/aria-label="Cancel /);
		// The Approvals link counts it.
		expect(textOf(await pageBody(await open("/app/acme/projects", mona)))).toMatch(
			/Approvals 1 pending/,
		);
	});

	it("lists for an owner everyone's but their own, and Cancel on leave to come", async () => {
		const { grace, linus } = await seedPeople();
		await requestLeave(grace, "annual", "2026-11-16", "2026-11-20");
		await requestLeave(linus, "sick", "2026-11-25", "2026-11-25");
		await requestLeave(ada, "annual", "2026-11-23", "2026-11-23");

		const html = await pageBody(await open(`${TIME_OFF}?show=requests`, ada));
		const text = textOf(html);
		expect(text).toContain("Requests (1)");
		expect(text).toContain("grace@example.com · Annual leave");
		expect(text).toContain("linus@example.com · Sick leave");
		expect(text).not.toContain("ada@example.com · Annual leave");
		expect(html).toContain('aria-label="Cancel linus@example.com&#x27;s sick leave"');
	});

	it("says when nothing waits", async () => {
		await seedPeople();
		const text = await textAt(`${TIME_OFF}?show=requests`, ada);
		expect(text).toContain("No request is waiting for you.");
		expect(text).toContain("No approved leave is to come.");
	});
});

describe("when nobody else can decide", () => {
	// The sheet's sentence saying so before it is sent is checked in the browser (e2e/leave.spec.ts).
	it("a sole owner's leave that needs approval is approved as it is sent, by themselves", async () => {
		vi.spyOn(Date, "now").mockReturnValue(T0);
		const annual = await requestLeave(ada, "annual", "2026-11-16", "2026-11-17");
		expect(annual.status).toBe(200);
		expect(annual.said).toContain("Approved automatically: nobody else can decide it.");
		expect(
			await row("select status, decided_by, comment from leave_requests where id = ?", annual.id),
		).toEqual({
			status: "approved",
			decided_by: ada.user.id,
			comment: "Approved automatically: nobody else can decide it",
		});
		// Leave that needs nobody's approval is recorded as before, with no comment.
		const sick = await requestLeave(ada, "sick", "2026-11-18", "2026-11-18");
		expect(
			await row("select status, decided_by, comment from leave_requests where id = ?", sick.id),
		).toEqual({ status: "approved", decided_by: null, comment: null });
	});

	it("an owner with an admin waits for the admin", async () => {
		await memberOfAcme("admin", "hedy@example.com");
		vi.spyOn(Date, "now").mockReturnValue(T0);
		const annual = await requestLeave(ada, "annual", "2026-11-16", "2026-11-17");
		expect(annual.said).toContain("Requested. It waits for a manager's approval.");
		expect(await statusOf(annual.id)).toBe("pending");
	});

	it("a member whose team has a manager waits; a member with no team, beside the owner, waits too", async () => {
		const { grace, bob } = await seedPeople();
		expect((await requestLeave(grace, "annual", "2026-11-16", "2026-11-16")).said).toContain(
			"Requested.",
		);
		expect((await requestLeave(bob, "annual", "2026-11-16", "2026-11-16")).said).toContain(
			"Requested.",
		);
	});
});
