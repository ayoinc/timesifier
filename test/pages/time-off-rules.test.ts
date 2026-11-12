import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { addDays, type Day, dayOf, isoWeekday } from "~/time/calendar";
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

// Time off with the timesheet rules of TS-090: notice for leave, requests for
// overtime and weekend work, and the team's leave to come, through the page's
// own actions, for each role. Ada owns Acme, Hedy is an admin, Mona manages
// Design, which holds Grace and Alan, Nils manages Ops, which holds Linus, and
// Bob is in no team. Days are counted from the real today, so nothing here
// depends on the calendar date.

const TIME_OFF = "/app/acme/time-off";
const REQUESTS = `${TIME_OFF}?show=requests`;
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

async function seedPeople() {
	const hedy = await memberOfAcme("admin", "hedy@example.com");
	const mona = await memberOfAcme("member", "mona@example.com");
	const grace = await memberOfAcme("member", "grace@example.com");
	const alan = await memberOfAcme("member", "alan@example.com");
	const nils = await memberOfAcme("member", "nils@example.com");
	const linus = await memberOfAcme("member", "linus@example.com");
	const bob = await memberOfAcme("member", "bob@example.com");
	await seedTeam(acme.id, "Design", {
		members: [grace.user.id, alan.user.id],
		managers: [mona.user.id],
	});
	await seedTeam(acme.id, "Ops", { members: [linus.user.id], managers: [nils.user.id] });
	return { hedy, mona, grace, alan, nils, linus, bob };
}

/** Acme's timesheet rules, as Workspace settings would set them. */
async function setRules(rules: {
	overtime?: "free" | "approval" | "none";
	weekend?: "free" | "approval" | "none";
	shortNotice?: "with-reason" | "refused";
}) {
	await env.DB.prepare(
		"update organisations set overtime_rule = coalesce(?, overtime_rule), weekend_rule = coalesce(?, weekend_rule), short_notice = coalesce(?, short_notice) where id = ?",
	)
		.bind(rules.overtime ?? null, rules.weekend ?? null, rules.shortNotice ?? null, acme.id)
		.run();
}

/** Today in UTC. Acme counts its days in UTC; every day below is far enough from it that a zone would not matter. */
function today(): Day {
	return dayOf(Date.now(), "UTC");
}

/** The first day from `day` on that falls on `weekday`: 1 is Monday, 6 Saturday. */
function onOrAfter(day: Day, weekday: number): Day {
	let found = day;
	while (isoWeekday(found) !== weekday) found = addDays(found, 1);
	return found;
}

/** The first weekday from `day` on. */
function weekdayFrom(day: Day): Day {
	let found = day;
	while (isoWeekday(found) > 5) found = addDays(found, 1);
	return found;
}

/** What the page's action answered a form sent by script. */
async function ask(who: Person, fields: Record<string, string>) {
	const response = await submit(TIME_OFF, fields, who, { byScript: true });
	return { status: response.status, said: await response.text() };
}

async function requestLeave(
	who: Person,
	key: "annual" | "sick",
	startsOn: Day,
	endsOn: Day,
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

async function requestWork(
	who: Person,
	kind: "overtime" | "weekend",
	startsOn: Day,
	endsOn: Day,
	more: Record<string, string> = {},
) {
	const before = await value<number>("select count(*) from work_requests");
	const answer = await ask(who, {
		intent: "request-work",
		kind,
		startsOn,
		endsOn,
		hours: "2",
		...more,
	});
	const made = (await value<number>("select count(*) from work_requests")) !== before;
	const id = made
		? await value<string>(
				"select id from work_requests where user_id = ? order by created_at desc, id desc limit 1",
				who.user.id,
			)
		: null;
	return { ...answer, id };
}

const workStatusOf = (id: string | null) =>
	value<string>("select status from work_requests where id = ?", id);

async function textAt(path: string, who: Person) {
	const response = await open(path, who);
	expect(response.status, path).toBe(200);
	return textOf(await pageBody(response));
}

describe("notice for leave", () => {
	it("a member's annual leave at short notice needs a reason, and keeps it", async () => {
		const { grace } = await seedPeople();
		const soon = weekdayFrom(addDays(today(), 3));
		const bare = await requestLeave(grace, "annual", soon, soon);
		expect(bare.status).toBe(400);
		expect(bare.said).toMatch(/This is short notice \(\d+ days?\): say why in one line\./);
		expect(bare.id).toBeNull();

		const tooLong = await requestLeave(grace, "annual", soon, soon, {
			noticeReason: "x".repeat(201),
		});
		expect(tooLong.status).toBe(400);
		expect(tooLong.id).toBeNull();

		const told = await requestLeave(grace, "annual", soon, soon, {
			noticeReason: "  Family emergency  ",
		});
		expect(told.status).toBe(200);
		expect(told.said).toContain("Requested. It waits for a manager's approval.");
		const stored = await row<{ short_notice: number; notice_reason: string; notice_days: number }>(
			"select short_notice, notice_reason, notice_days from leave_requests where id = ?",
			told.id,
		);
		expect(stored).toMatchObject({ short_notice: 1, notice_reason: "Family emergency" });
		expect(stored?.notice_days).toBeGreaterThanOrEqual(2);
		expect(stored?.notice_days).toBeLessThanOrEqual(6);
	});

	it("leave asked for in good time is not short, and keeps no reason", async () => {
		const { grace } = await seedPeople();
		const later = weekdayFrom(addDays(today(), 30));
		const made = await requestLeave(grace, "annual", later, later, {
			noticeReason: "Not needed",
		});
		expect(made.status).toBe(200);
		expect(
			await row(
				"select short_notice, notice_reason, notice_days >= 29 as enough from leave_requests where id = ?",
				made.id,
			),
		).toEqual({ short_notice: 0, notice_reason: null, enough: 1 });
	});

	it("sick leave is never short notice", async () => {
		const { grace } = await seedPeople();
		const tomorrow = weekdayFrom(addDays(today(), 1));
		const sick = await requestLeave(grace, "sick", tomorrow, tomorrow);
		expect(sick.status).toBe(200);
		expect(sick.said).toContain("Recorded. It needs nobody's approval.");
		expect(
			await row(
				"select status, short_notice, notice_reason from leave_requests where id = ?",
				sick.id,
			),
		).toEqual({ status: "approved", short_notice: 0, notice_reason: null });
	});

	it("is refused where the organisation does not take short notice, reason or not", async () => {
		const { grace } = await seedPeople();
		await setRules({ shortNotice: "refused" });
		const soon = weekdayFrom(addDays(today(), 3));
		const refused = await requestLeave(grace, "annual", soon, soon, {
			noticeReason: "Family emergency",
		});
		expect(refused.status).toBe(400);
		expect(refused.said).toContain(
			"Annual leave needs 14 days' notice here: the earliest first day is",
		);
		expect(refused.id).toBeNull();
		const later = weekdayFrom(addDays(today(), 30));
		expect((await requestLeave(grace, "annual", later, later)).status).toBe(200);
	});

	it("approvers see the notice every request gave, short notice marked with its reason", async () => {
		const { grace, mona, hedy } = await seedPeople();
		const soon = weekdayFrom(addDays(today(), 3));
		const later = weekdayFrom(addDays(today(), 30));
		await requestLeave(grace, "annual", soon, soon, { noticeReason: "Family emergency" });
		await requestLeave(grace, "annual", later, later);
		for (const approver of [mona, hedy]) {
			const text = await textAt(REQUESTS, approver);
			expect(text).toContain("grace@example.com · Annual leave");
			expect(text).toMatch(/Short notice \(\d+ days?\) Why: “Family emergency”/);
			expect(text).toMatch(/\d+ days' notice/);
		}
	});
});

describe("requests for overtime and weekend work", () => {
	it("are refused while the organisation allows the work freely or not at all", async () => {
		const { grace } = await seedPeople();
		const monday = onOrAfter(addDays(today(), 21), 1);
		const saturday = onOrAfter(addDays(today(), 21), 6);
		const free = await requestWork(grace, "overtime", monday, monday);
		expect(free.status).toBe(400);
		expect(free.said).toContain("Overtime needs no approval here.");
		await setRules({ weekend: "none" });
		const none = await requestWork(grace, "weekend", saturday, saturday);
		expect(none.status).toBe(400);
		expect(none.said).toContain("Weekend work is not allowed in this organisation.");
		expect(await value("select count(*) from work_requests")).toBe(0);
		const text = await textAt(TIME_OFF, grace);
		expect(text).not.toContain("Request overtime");
		expect(text).not.toContain("Request weekend work");
	});

	it("with pre-approval, a member's waits for their manager, who approves it; never their own", async () => {
		const { grace, mona } = await seedPeople();
		await setRules({ overtime: "approval", weekend: "approval" });
		let text = await textAt(TIME_OFF, grace);
		expect(text).toContain("Request overtime");
		expect(text).toContain("Request weekend work");

		const monday = onOrAfter(addDays(today(), 21), 1);
		const made = await requestWork(grace, "overtime", monday, addDays(monday, 1), {
			hours: "1:30",
			reason: "Launch week",
		});
		expect(made.status).toBe(200);
		expect(made.said).toContain("Overtime requested. It waits for a manager's approval.");
		expect(
			await row(
				"select kind, status, minutes_per_day, reason, starts_on, ends_on from work_requests where id = ?",
				made.id,
			),
		).toEqual({
			kind: "overtime",
			status: "pending",
			minutes_per_day: 90,
			reason: "Launch week",
			starts_on: monday,
			ends_on: addDays(monday, 1),
		});
		text = await textAt(TIME_OFF, grace);
		expect(text).toContain("Overtime · Waiting for approval");
		expect(text).toContain("1:30 a day");

		const own = await ask(grace, { intent: "approve-work", requestId: made.id ?? "" });
		expect(own.status).toBe(403);
		expect(own.said).toContain(NOT_ALLOWED);
		expect(await workStatusOf(made.id)).toBe("pending");

		text = await textAt(REQUESTS, mona);
		expect(text).toContain("Requests (1)");
		expect(text).toContain("grace@example.com · Overtime");
		expect(text).toContain("“Launch week”");

		const approved = await ask(mona, {
			intent: "approve-work",
			requestId: made.id ?? "",
			comment: "Fine",
		});
		expect(approved.status).toBe(200);
		expect(approved.said).toContain("Overtime approved.");
		expect(
			await row("select status, decided_by, comment from work_requests where id = ?", made.id),
		).toEqual({ status: "approved", decided_by: mona.user.id, comment: "Fine" });
		const again = await ask(mona, { intent: "approve-work", requestId: made.id ?? "" });
		expect(again.status).toBe(409);
		expect(await textAt(TIME_OFF, grace)).toContain("Overtime · Approved");
		expect(await textAt(REQUESTS, mona)).not.toContain("Requests (1)");
	});

	it("weekend work is for days off; a manager of another team may not refuse it, the person's may", async () => {
		const { grace, mona, nils } = await seedPeople();
		await setRules({ weekend: "approval" });
		const monday = onOrAfter(addDays(today(), 21), 1);
		const weekday = await requestWork(grace, "weekend", monday, monday);
		expect(weekday.status).toBe(400);
		expect(weekday.said).toContain("These days hold no day off");

		const saturday = onOrAfter(addDays(today(), 21), 6);
		const made = await requestWork(grace, "weekend", saturday, addDays(saturday, 1), {
			hours: "4",
		});
		expect(made.status).toBe(200);
		expect(made.said).toContain("Weekend work requested. It waits for a manager's approval.");
		expect(await workStatusOf(made.id)).toBe("pending");

		const other = await ask(nils, { intent: "refuse-work", requestId: made.id ?? "" });
		expect(other.status).toBe(403);
		const refused = await ask(mona, { intent: "refuse-work", requestId: made.id ?? "" });
		expect(refused.status).toBe(200);
		expect(refused.said).toContain("Weekend work refused.");
		expect(await workStatusOf(made.id)).toBe("refused");
	});

	it("is withdrawn by its own person while it waits", async () => {
		const { grace, bob } = await seedPeople();
		await setRules({ overtime: "approval" });
		const monday = onOrAfter(addDays(today(), 21), 1);
		const made = await requestWork(grace, "overtime", monday, monday);
		const theirs = await ask(bob, { intent: "withdraw-work", requestId: made.id ?? "" });
		expect(theirs.status).toBe(403);
		const withdrawn = await ask(grace, { intent: "withdraw-work", requestId: made.id ?? "" });
		expect(withdrawn.status).toBe(200);
		expect(withdrawn.said).toContain("Request withdrawn.");
		expect(await workStatusOf(made.id)).toBe("withdrawn");
		expect((await ask(grace, { intent: "withdraw-work", requestId: made.id ?? "" })).status).toBe(
			409,
		);
		expect((await ask(grace, { intent: "withdraw-work", requestId: "nothing" })).status).toBe(404);
	});

	it("approved and not begun, is cancelled by an owner or admin with a reason, not by a manager", async () => {
		const { grace, mona, hedy } = await seedPeople();
		await setRules({ overtime: "approval" });
		const monday = onOrAfter(addDays(today(), 21), 1);
		const made = await requestWork(grace, "overtime", monday, monday);
		await ask(mona, { intent: "approve-work", requestId: made.id ?? "" });
		expect(await workStatusOf(made.id)).toBe("approved");

		let text = await textAt(REQUESTS, hedy);
		// Listed for the admin among the approved work to come.
		expect(text).toContain("Approved, to come");
		expect(text).toContain("grace@example.com · Overtime");
		const manager = await ask(mona, {
			intent: "cancel-work",
			requestId: made.id ?? "",
			comment: "Plans changed",
		});
		expect(manager.status).toBe(403);
		const empty = await ask(hedy, {
			intent: "cancel-work",
			requestId: made.id ?? "",
			comment: " ",
		});
		expect(empty.status).toBe(400);
		expect(empty.said).toContain("Say why, in 1 to 500 characters.");
		const cancelled = await ask(hedy, {
			intent: "cancel-work",
			requestId: made.id ?? "",
			comment: "Plans changed",
		});
		expect(cancelled.status).toBe(200);
		expect(cancelled.said).toContain("Overtime cancelled.");
		expect(
			await row("select status, decided_by, comment from work_requests where id = ?", made.id),
		).toEqual({ status: "cancelled", decided_by: hedy.user.id, comment: "Plans changed" });
		text = await textAt(TIME_OFF, grace);
		expect(text).toContain("Overtime · Cancelled");
	});

	it("a sole owner's is approved as it is sent", async () => {
		await setRules({ overtime: "approval" });
		const monday = onOrAfter(addDays(today(), 21), 1);
		const made = await requestWork(ada, "overtime", monday, monday);
		expect(made.status).toBe(200);
		expect(made.said).toContain("Approved automatically: nobody else can decide it.");
		expect(await row("select status, decided_by from work_requests where id = ?", made.id)).toEqual(
			{ status: "approved", decided_by: ada.user.id },
		);
	});

	it("refuses hours that are not hours, or more than a day takes", async () => {
		const { grace } = await seedPeople();
		await setRules({ overtime: "approval" });
		const monday = onOrAfter(addDays(today(), 21), 1);
		expect((await requestWork(grace, "overtime", monday, monday, { hours: "lots" })).status).toBe(
			400,
		);
		const most = await requestWork(grace, "overtime", monday, monday, { hours: "20" });
		expect(most.status).toBe(400);
		expect(most.said).toContain("at most 16");
		expect(await value("select count(*) from work_requests")).toBe(0);
	});
});

describe("the team's upcoming leave", () => {
	it("names the kind for the person's manager and an admin, and says only 'On leave' to a teammate", async () => {
		const { grace, alan, mona, hedy } = await seedPeople();
		const start = weekdayFrom(addDays(today(), 7));
		await seedLeave(acme.id, grace.user.id, "annual", start, start);

		const peer = await textAt(TIME_OFF, alan);
		expect(peer).toContain("Your team's upcoming leave");
		expect(peer).toContain("grace@example.com · On leave");
		expect(peer).not.toContain("grace@example.com · Annual leave");

		for (const approver of [mona, hedy]) {
			expect(await textAt(TIME_OFF, approver)).toContain("grace@example.com · Annual leave");
		}
		// Nobody is listed among their own colleagues.
		expect(await textAt(TIME_OFF, grace)).not.toContain("grace@example.com ·");
	});
});
