import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	row,
	seedInvitation,
	seedMembership,
	value,
} from "../organisations/harness";
import { open, openData, type Person, pageBody, person, submit, textOf } from "../pages/harness";
import { platformOwner } from "./harness";

// Accounts in the platform console (TS-099): the list, one account's page,
// and its tools. Every tool is posted the way its sheet posts it, says what it
// did, and is recorded in the platform log with the reason given.

let mailbox: Mailbox;
let root: Person;
let ada: Person;
let acme: { id: string };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	root = await platformOwner(mailbox);
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	// The first request to the Worker loads the whole application, which takes
	// longer than a hook is given by default.
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

const pageOf = (id: string) => `/platform/accounts/${id}`;

/** A tool posted by script from the account's page, and what it answered. */
async function tool(id: string, fields: Record<string, string>) {
	const response = await submit(pageOf(id), fields, root, { byScript: true });
	return { status: response.status, said: await response.text() };
}

/** The platform log's step about `subjectId`, newest first. */
function eventsAbout(subjectId: string) {
	return row<{ action: string; reason: string | null; actor_id: string | null }>(
		"select action, reason, actor_id from platform_events where subject_id = ? order by created_at desc, id desc limit 1",
		subjectId,
	);
}

const sessionsOf = (userId: string) =>
	value<number>("select count(*) from sessions where user_id = ?", userId);

describe("the list of accounts", () => {
	it("shows every account with its address, and finds one by what was typed", async () => {
		const all = textOf(await pageBody(await open("/platform/accounts", root)));
		expect(all).toContain("ada@example.com");
		expect(all).toContain("root@timesifier.example");

		const found = await pageBody(await open("/platform/accounts?q=ada", root));
		expect(textOf(found)).toContain("ada@example.com");
		expect(textOf(found)).not.toContain("root@timesifier.example");
		expect(found).toContain(`href="/platform/accounts/${ada.user.id}"`);
	});

	it("finds an account by a whole long address, in any letter case", async () => {
		// D1 refuses a LIKE pattern over 50 bytes; a whole address often is.
		const long = "ada-a6da3b29-5040-4e84-ab03-c9d5c9beb1b5@example.com";
		const somebody = await person(mailbox, long);
		const query = encodeURIComponent(long.toUpperCase());
		const response = await open(`/platform/accounts?q=${query}`, root);
		expect(response.status).toBe(200);
		const found = await pageBody(response);
		expect(found).toContain(`href="/platform/accounts/${somebody.user.id}"`);
		expect(textOf(found)).not.toContain("root@timesifier.example");
		expect((await openData(`/platform/accounts?q=${query}`, root)).status).toBe(200);
	});

	it("is the same 404 to anyone who is not a platform owner", async () => {
		expect((await open("/platform/accounts", ada)).status).toBe(404);
		expect((await open(pageOf(ada.user.id), ada)).status).toBe(404);
	});
});

describe("one account", () => {
	it("shows its organisations by name, its sessions and its sign-ins", async () => {
		const html = await pageBody(await open(pageOf(ada.user.id), root));
		const text = textOf(html);

		expect(html).toContain(">ada@example.com</span></h1>");
		expect(text).toContain("No name yet");
		expect(text).toContain("ada@example.com");
		expect(text).toContain("Acme");
		expect(text).toContain("Owner");
		expect(text).toContain("Signed in on 1 browser or device");
		expect(text).toContain("kept for 90 days");
	});

	it("is a 404 for an account that does not exist", async () => {
		expect((await open(pageOf("no-such-account"), root)).status).toBe(404);
	});
});

describe("every tool needs a reason", () => {
	it.each([
		["no reason", {}],
		["a blank reason", { reason: "   " }],
		["a reason too long to be one", { reason: "x".repeat(501) }],
	])("with %s, nothing is done and nothing is recorded", async (_case, fields) => {
		const response = await tool(ada.user.id, { intent: "revoke-sessions", ...fields });

		expect(response.status).toBe(400);
		expect(response.said).toContain("Say why you are doing this.");
		expect(await sessionsOf(ada.user.id)).toBe(1);
		expect(await value("select count(*) from platform_events")).toBe(0);
	});
});

describe("ending sessions", () => {
	it("ends every session, says how many, and records the reason", async () => {
		const response = await tool(ada.user.id, {
			intent: "revoke-sessions",
			reason: "  Lost her laptop ",
		});

		expect(response.status).toBe(200);
		expect(response.said).toContain("Ended 1 session.");
		expect(await sessionsOf(ada.user.id)).toBe(0);
		expect(await eventsAbout(ada.user.id)).toEqual({
			action: "account.sessions_revoked",
			reason: "Lost her laptop",
			actor_id: root.user.id,
		});
	});
});

describe("closing and restoring", () => {
	it("closes the account, then restores it, each recorded with its reason", async () => {
		const closed = await tool(ada.user.id, { intent: "close", reason: "Asked us to" });
		expect(closed.status).toBe(200);
		expect(closed.said).toContain("Closed ada@example.com's account.");
		expect(await value("select closed_at is not null from users where id = ?", ada.user.id)).toBe(
			1,
		);
		expect(await sessionsOf(ada.user.id)).toBe(0);
		expect(await eventsAbout(ada.user.id)).toMatchObject({
			action: "account.closed",
			reason: "Asked us to",
		});
		expect(textOf(await pageBody(await open(pageOf(ada.user.id), root)))).toContain("Closed on");

		const restored = await tool(ada.user.id, { intent: "restore", reason: "Changed her mind" });
		expect(restored.status).toBe(200);
		expect(restored.said).toContain("Restored ada@example.com's account.");
		expect(await value("select closed_at from users where id = ?", ada.user.id)).toBeNull();
		expect(await eventsAbout(ada.user.id)).toMatchObject({
			action: "account.restored",
			reason: "Changed her mind",
		});
	});

	it("does not let a platform owner close or delete their own account", async () => {
		const closing = await tool(root.user.id, { intent: "close", reason: "Testing" });
		expect(closing.status).toBe(403);
		expect(closing.said).toContain("You cannot close your own account");

		const deleting = await tool(root.user.id, {
			intent: "delete",
			confirmation: "root@timesifier.example",
			reason: "Testing",
		});
		expect(deleting.status).toBe(403);
		expect(deleting.said).toContain("You cannot delete your own account");
		expect(await value("select count(*) from platform_events")).toBe(0);
	});

	it("refuses to restore a deleted account", async () => {
		const bob = await person(mailbox, "bob@example.com");
		const deleted = await tool(bob.user.id, {
			intent: "delete",
			confirmation: "bob@example.com",
			reason: "Asked to be forgotten",
		});
		expect(deleted.status).toBe(200);

		const restoring = await tool(bob.user.id, { intent: "restore", reason: "By mistake" });

		expect(restoring.status).toBe(409);
		expect(restoring.said).toContain("A deleted account cannot be restored.");
		expect(await eventsAbout(bob.user.id)).toMatchObject({ action: "account.deleted" });
	});
});

describe("sending an invitation again", () => {
	it("sends the organisation's own invitation to the invitee and records it", async () => {
		const grace = await person(mailbox, "grace@example.com");
		const invitationId = await seedInvitation(acme.id, ada.user.id, "grace@example.com", "admin");
		const before = mailbox.sent().length;

		const response = await tool(grace.user.id, {
			intent: "resend-invitation",
			invitationId,
			reason: "Never got it",
		});

		expect(response.status).toBe(200);
		expect(response.said).toContain("Sent grace@example.com the invitation to Acme again.");
		const sent = mailbox.sent().slice(before);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			to: "grace@example.com",
			subject: "You are invited to join an organisation on Timesifier",
		});
		expect(sent[0]?.text).toContain(`/invitations/${invitationId}`);
		expect(sent[0]?.text).toContain("“Acme”");
		expect(await eventsAbout(grace.user.id)).toMatchObject({
			action: "account.invitation_resent",
			reason: "Never got it",
		});
	});

	it("refuses an invitation that is not to this account", async () => {
		const invitationId = await seedInvitation(acme.id, ada.user.id, "grace@example.com");
		const before = mailbox.sent().length;

		const response = await tool(ada.user.id, {
			intent: "resend-invitation",
			invitationId,
			reason: "Never got it",
		});

		expect(response.status).toBe(409);
		expect(mailbox.sent()).toHaveLength(before);
	});
});

describe("sending the link to their data", () => {
	it("sends one email to their address with the link, and nothing of their data", async () => {
		await env.DB.prepare("update users set name = 'Ada Lovelace' where id = ?")
			.bind(ada.user.id)
			.run();
		const before = mailbox.sent().length;

		const response = await tool(ada.user.id, {
			intent: "send-export-link",
			reason: "Subject access request",
		});

		expect(response.status).toBe(200);
		const sent = mailbox.sent().slice(before);
		expect(sent).toHaveLength(1);
		const [message] = sent;
		expect(message?.to).toBe("ada@example.com");
		expect(message?.subject).toBe("Your Timesifier data");
		expect(message?.text).toContain("https://timesifier.example/app/acme/account");
		expect(message?.text).not.toContain("Acme");
		expect(message?.text).not.toContain("Lovelace");
		expect(await eventsAbout(ada.user.id)).toMatchObject({
			action: "account.export_link_sent",
			reason: "Subject access request",
		});
	});
});

describe("deleting an account", () => {
	it("is refused while they are the only owner of an organisation with others in it", async () => {
		const grace = await person(mailbox, "grace@example.com");
		await seedMembership(acme.id, grace.user.id, "member");

		const response = await tool(ada.user.id, {
			intent: "delete",
			confirmation: "ada@example.com",
			reason: "Asked to be forgotten",
		});

		expect(response.status).toBe(409);
		expect(response.said).toContain("the only owner of Acme");
		expect(response.said).toContain("Someone else must be made an owner first.");
		expect(await value("select email from users where id = ?", ada.user.id)).toBe(
			"ada@example.com",
		);
		expect(await value("select count(*) from platform_events")).toBe(0);
	});

	it("is refused when the address typed is not theirs", async () => {
		const response = await tool(ada.user.id, {
			intent: "delete",
			confirmation: "someone@example.com",
			reason: "Asked to be forgotten",
		});

		expect(response.status).toBe(400);
		expect(response.said).toContain("That is not the account's address.");
		expect(await value("select count(*) from organisations")).toBe(1);
	});

	it("deletes them with the organisation they were alone in, says so, and records it", async () => {
		const response = await tool(ada.user.id, {
			intent: "delete",
			confirmation: " ADA@example.com ",
			reason: "Asked to be forgotten",
		});

		expect(response.status).toBe(200);
		expect(response.said).toContain("Deleted the account. 0 receipts and 1 organisation");
		expect(await value("select count(*) from organisations")).toBe(0);
		expect(await value("select email from users where id = ?", ada.user.id)).not.toBe(
			"ada@example.com",
		);
		expect(await eventsAbout(ada.user.id)).toMatchObject({
			action: "account.deleted",
			reason: "Asked to be forgotten",
		});
	});
});
