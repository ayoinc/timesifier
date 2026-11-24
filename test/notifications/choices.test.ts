import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { KIND_WORDS, NOTIFICATION_KINDS } from "~/notifications/kinds";

import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, seedMembership, seedTeam, value } from "../organisations/harness";
import { open, type Person, pageBody, person, submit, textOf } from "../pages/harness";

// My account › Notifications (TS-049, decision 69): one email switch for each
// kind that can reach the person, saved for the signed-in person alone, the
// same in every organisation; the bell has every notification whatever is chosen.

const ACCOUNT = "/app/acme/account";

let mailbox: Mailbox;
let ada: Person;
let linus: Person;
let acme: { id: string };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	linus = await person(mailbox, "linus@example.com");
	await seedMembership(acme.id, linus.user.id, "member");
}, 30_000);

const choices = async () =>
	(
		await env.DB.prepare(
			"select u.email as email, c.kind as kind, c.email as on_ from notification_choices c join users u on u.id = c.user_id order by u.email, c.kind",
		).all<{ email: string; kind: string; on_: number }>()
	).results.map(({ email, kind, on_ }) => [email, kind, on_ === 1]);

describe("My account › Notifications", () => {
	it("shows an owner a switch for every kind, all on until turned off", async () => {
		const html = await pageBody(await open(ACCOUNT, ada));
		expect(html).toContain('id="notifications"');
		const text = textOf(html);
		for (const kind of NOTIFICATION_KINDS) expect(text).toContain(KIND_WORDS[kind].label);
		expect(await choices()).toEqual([]);
	});

	it("shows a member the kinds about their own work, and none for deciders or budgets until they manage a team", async () => {
		const own = NOTIFICATION_KINDS.filter((kind) => KIND_WORDS[kind].audience === "everyone");
		const others = NOTIFICATION_KINDS.filter((kind) => KIND_WORDS[kind].audience !== "everyone");
		const text = textOf(await pageBody(await open(ACCOUNT, linus)));
		for (const kind of own) expect(text).toContain(KIND_WORDS[kind].label);
		for (const kind of others) expect(text).not.toContain(KIND_WORDS[kind].label);

		await seedTeam(acme.id, "Design", { managers: [linus.user.id] });
		const managing = textOf(await pageBody(await open(ACCOUNT, linus)));
		for (const kind of NOTIFICATION_KINDS) expect(managing).toContain(KIND_WORDS[kind].label);
	});

	it("turns one kind's email off and on for the signed-in person alone", async () => {
		const off = await submit(
			ACCOUNT,
			{ intent: "notification", kind: "week-decided", on: "off" },
			linus,
			{
				byScript: true,
			},
		);
		expect(off.status).toBe(200);
		expect(await off.text()).toContain(
			"You will no longer get an email for “Your timesheets approved or returned”. It still shows in the bell.",
		);
		expect(await choices()).toEqual([["linus@example.com", "week-decided", false]]);

		await submit(ACCOUNT, { intent: "notification", kind: "week-decided", on: "on" }, linus, {
			byScript: true,
		});
		expect(await choices()).toEqual([["linus@example.com", "week-decided", true]]);
		// Nothing of anybody else's changed, and nothing goes to the organisation's activity log: it is the person's account.
		expect(
			await value("select count(*) from activity_records where action like 'notification%'"),
		).toBe(0);
	});

	it("refuses a kind it does not know, and a stranger reaches nobody's", async () => {
		const unknown = await submit(
			ACCOUNT,
			{ intent: "notification", kind: "offers", on: "off" },
			linus,
		);
		expect(unknown.status).toBe(400);
		const sam = await person(mailbox, "sam@example.com");
		await createOrganisation(sam.cookie, "Globex");
		const theirs = await submit(
			ACCOUNT,
			{ intent: "notification", kind: "budget", on: "off" },
			sam,
		);
		expect(theirs.status).toBe(404);
		expect(await choices()).toEqual([]);
	});
});
