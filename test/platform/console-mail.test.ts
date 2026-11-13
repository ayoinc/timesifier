import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { row, value } from "../organisations/harness";
import { open, type Person, pageBody, person, submit, textOf } from "../pages/harness";
import { platformOwner } from "./harness";

// Mail in the platform console (TS-099): a preview that sends and queues
// nothing, and a mailing queued to the people who have that kind of mail on
// and whose accounts are open, recorded in the platform log.

const MAIL = "/platform/mail";

let mailbox: Mailbox;
let root: Person;
let ada: Person;
let bob: Person;
let cleo: Person;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	root = await platformOwner(mailbox);
	ada = await person(mailbox, "ada@example.com");
	bob = await person(mailbox, "bob@example.com");
	cleo = await person(mailbox, "cleo@example.com");
	// Ada has both kinds on; Bob's account is closed; Cleo turned announcements
	// off. The platform owner has announcements on, as every account starts.
	await env.DB.batch([
		env.DB.prepare("update users set newsletter = 1 where id = ?").bind(ada.user.id),
		env.DB.prepare("update users set newsletter = 1, closed_at = ? where id = ?").bind(
			Date.now(),
			bob.user.id,
		),
		env.DB.prepare("update users set announcements = 0 where id = ?").bind(cleo.user.id),
	]);
	// The first request to the Worker loads the whole application, which takes
	// longer than a hook is given by default.
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

const MAILING = {
	kind: "announcement",
	subject: "Timesheets now lock on Fridays",
	body: "From next week, a week locks on Friday evening.\n\nAsk your owner to change it.",
};

async function post(fields: Record<string, string>) {
	const response = await submit(MAIL, fields, root, { byScript: true });
	return { status: response.status, said: await response.text() };
}

describe("the page", () => {
	it("says how many each kind reaches and the caps", async () => {
		const text = textOf(await pageBody(await open(MAIL, root)));

		expect(text).toContain("Product announcement, to 2 people");
		expect(text).toContain("Newsletter, to 1 person");
		expect(text).toContain("40 a minute and 1,000 a day at most");
		expect(text).toContain("Nothing has been sent yet.");
	});

	it("is the same 404 to anyone who is not a platform owner", async () => {
		expect((await open(MAIL, ada)).status).toBe(404);
	});
});

describe("a preview", () => {
	it("answers the message as it reads and sends and queues nothing", async () => {
		const before = mailbox.sent().length;

		const response = await post({ intent: "preview", ...MAILING });

		expect(response.status).toBe(200);
		expect(response.said).toContain("Timesheets now lock on Fridays");
		expect(response.said).toContain("From next week, a week locks on Friday evening.");
		expect(response.said).toContain("Ask your owner to change it.");
		expect(response.said).toContain("/unsubscribe/");
		expect(mailbox.sent()).toHaveLength(before);
		expect(await value("select count(*) from mailings")).toBe(0);
		expect(await value("select count(*) from mailing_deliveries")).toBe(0);
		expect(await value("select count(*) from platform_events")).toBe(0);
	});

	it("refuses a subject that is too long", async () => {
		const response = await post({ intent: "preview", ...MAILING, subject: "x".repeat(151) });

		expect(response.status).toBe(400);
	});
});

describe("queueing", () => {
	it("makes a delivery for each open account with the kind on, and records it", async () => {
		const response = await post({ intent: "queue", ...MAILING });

		expect(response.status).toBe(200);
		expect(response.said).toContain("Queued “Timesheets now lock on Fridays” to 2 people.");
		const deliveries = await env.DB.prepare(
			"select user_id from mailing_deliveries order by user_id",
		).all<{ user_id: string }>();
		expect(deliveries.results.map((delivery) => delivery.user_id).sort()).toEqual(
			[root.user.id, ada.user.id].sort(),
		);
		const mailing = await row<{ id: string; recipients: number; sent_by: string }>(
			"select id, recipients, sent_by from mailings",
		);
		expect(mailing).toMatchObject({ recipients: 2, sent_by: root.user.id });
		expect(
			await row("select action, subject_type, subject_id, actor_id from platform_events"),
		).toEqual({
			action: "mailing.queued",
			subject_type: "mailing",
			subject_id: mailing?.id,
			actor_id: root.user.id,
		});

		const text = textOf(await pageBody(await open(MAIL, root)));
		expect(text).toContain("Timesheets now lock on Fridays");
		expect(text).toContain("0 of 2 people sent, 2 waiting.");
	});

	it("sends a newsletter only to those who asked for it", async () => {
		const response = await post({ intent: "queue", ...MAILING, kind: "newsletter" });

		expect(response.status).toBe(200);
		expect(
			await env.DB.prepare("select user_id from mailing_deliveries").all<{ user_id: string }>(),
		).toMatchObject({ results: [{ user_id: ada.user.id }] });
	});

	it("queues nothing when nobody has that kind on", async () => {
		await env.DB.prepare("update users set newsletter = 0").run();

		const response = await post({ intent: "queue", ...MAILING, kind: "newsletter" });

		expect(response.status).toBe(409);
		expect(await value("select count(*) from mailings")).toBe(0);
	});
});
