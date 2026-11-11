import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEmail, type Mailbox, post } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	invite,
	type Role,
	roleOf,
	seedMembership,
	seedTeam,
	value,
} from "../organisations/harness";
import { open, type Person, pageBody, person, submit, textOf } from "./harness";

// The members and invitations of an organisation, pages of Team at
// /app/<slug>/team/members and /app/<slug>/team/invitations, and leaving it,
// on My account at /app/<slug>/account: who is in the organisation, the
// invitations that are waiting, and the actions a role allows. Team is shown to
// owners, admins and managers; a member is not shown it and gets 404 there
// (test/pages/destinations.test.ts). The pages leave out what a role may not
// do; the server refuses it all the same, and each refusal here is made by
// posting the very form the page would post, by a manager who holds the role
// of a member.

const MEMBERS = "/app/acme/team/members";
const INVITATIONS = "/app/acme/team/invitations";
const ACCOUNT = "/app/acme/account";
const NOT_ALLOWED = "Your role in this organisation does not allow that.";
const NEEDS_AN_OWNER =
	"An organisation needs at least one owner. Make another member an owner first.";

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

type MemberOfAcme = Person & { memberId: string };

/** A person who signs in and holds `role` in Acme. */
async function memberOfAcme(role: Role, email: string): Promise<MemberOfAcme> {
	const who = await person(mailbox, email);
	return { ...who, memberId: await seedMembership(acme.id, who.user.id, role) };
}

/** A person who holds the role of a member in Acme and manages a team of it, so is shown Team. */
async function managerOfAcme(email: string): Promise<MemberOfAcme> {
	const who = await memberOfAcme("member", email);
	await seedTeam(acme.id, `Team of ${email}`, { managers: [who.user.id] });
	return who;
}

const memberIdOf = (who: Person) =>
	value<string>("select id from memberships where user_id = ?", who.user.id).then(String);

/** The page whose form takes each intent. */
const PAGE_FOR: Record<string, string> = {
	invite: INVITATIONS,
	cancel: INVITATIONS,
	leave: ACCOUNT,
};

/** A form sent by script, as the page's sheets send theirs, to the page that takes it: the status and what the action said. */
async function ask(who: Person, fields: Record<string, string>) {
	const page = (fields.intent && PAGE_FOR[fields.intent]) ?? MEMBERS;
	const response = await submit(page, fields, who, { byScript: true });
	return { status: response.status, said: await response.text() };
}

const membersOfAcme = () =>
	value("select count(*) from memberships where organisation_id = ?", acme.id);
const pendingInvitations = () => value("select count(*) from invitations where status = 'pending'");

describe("what the page shows", () => {
	it("to the owner of a new organisation: themselves, and what inviting does", async () => {
		const html = await pageBody(await open(MEMBERS, ada));
		const text = textOf(html);

		expect(text).toContain("ada@example.com (you)");
		expect(text).toContain("Owner");
		expect(text).toContain(
			"You are the only one here. People join by invitation, from Invitations",
		);
		expect(html).toMatch(/<a[^>]*href="\/app\/acme\/team\/invitations"[^>]*>Invitations<\/a>/);

		const invitations = await pageBody(await open(INVITATIONS, ada));
		expect(textOf(invitations)).toContain(
			"A person joins Acme by an invitation sent to their email address. Its link works once and expires after 7 days.",
		);
		expect(invitations).toMatch(/<button[^>]*>Invite a person<\/button>/);
		// Nothing is waiting, so the list says so.
		expect(textOf(invitations)).toContain("No invitation is waiting.");
	});

	it("each member by name, or by address when they have given none: never an empty place", async () => {
		const grace = await memberOfAcme("admin", "grace@example.com");
		await memberOfAcme("member", "linus@example.com");
		await env.DB.prepare("update users set name = 'Grace Hopper' where id = ?")
			.bind(grace.user.id)
			.run();
		// A name of spaces alone is no name.
		await env.DB.prepare("update users set name = '  ' where id = ?").bind(ada.user.id).run();

		const html = await pageBody(await open(MEMBERS, ada));
		const text = textOf(html);

		expect(text).toContain("Grace Hopper grace@example.com Admin");
		expect(text).toContain("ada@example.com (you) Owner");
		expect(text).toContain("linus@example.com Member");
		expect(text).not.toContain("undefined");
		expect(text).not.toContain("null");
		expect(html).toContain('aria-label="Actions for Grace Hopper"');
		expect(html).toContain('aria-label="Actions for linus@example.com"');
	});

	it("to an owner: actions for every other member, the invitations, and Invite", async () => {
		await memberOfAcme("owner", "grace@example.com");
		await memberOfAcme("member", "linus@example.com");
		await invite(ada.cookie, acme.id, "hedy@example.com", "admin");

		const html = await pageBody(await open(MEMBERS, ada));

		expect(html).toContain('aria-label="Actions for grace@example.com"');
		expect(html).toContain('aria-label="Actions for linus@example.com"');
		expect(html).not.toContain('aria-label="Actions for ada@example.com"');

		const invitations = await pageBody(await open(INVITATIONS, ada));
		expect(textOf(invitations)).toContain("hedy@example.com Invited as an admin. Expires");
		expect(invitations).toContain('aria-label="Cancel the invitation to hedy@example.com"');
	});

	it("to an admin: actions for members and admins, and none for an owner", async () => {
		const grace = await memberOfAcme("admin", "grace@example.com");
		await memberOfAcme("member", "linus@example.com");

		const html = await pageBody(await open(MEMBERS, grace));

		expect(html).toContain('aria-label="Actions for linus@example.com"');
		expect(html).not.toContain('aria-label="Actions for ada@example.com"');
		expect(await pageBody(await open(INVITATIONS, grace))).toMatch(
			/<button[^>]*>Invite a person<\/button>/,
		);
	});

	it("to a manager who is a member: everyone and their roles, and no control", async () => {
		await memberOfAcme("admin", "grace@example.com");
		const linus = await managerOfAcme("linus@example.com");
		await invite(ada.cookie, acme.id, "hedy@example.com");

		const html = await pageBody(await open(MEMBERS, linus));
		const text = textOf(html);

		expect(text).toContain("ada@example.com Owner");
		expect(text).toContain("grace@example.com Admin");
		expect(text).toContain("linus@example.com (you) Member");
		expect(html).not.toContain("Actions for");
		expect(text).not.toContain("People join by invitation");
		expect(html.match(/<main[\s\S]*<\/main>/)?.[0]).not.toMatch(/<button\b/);

		// The invitations are the owners' and admins' to see.
		const invitations = textOf(await pageBody(await open(INVITATIONS, linus)));
		expect(invitations).toContain("Owners and admins invite people to Acme.");
		expect(invitations).not.toContain("Invite a person");
		expect(invitations).not.toContain("hedy@example.com");
	});

	it("leaving is on My account, for every role", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");

		for (const who of [ada, linus]) {
			expect(await pageBody(await open(ACCOUNT, who))).toMatch(
				/<button[^>]*>Leave organisation<\/button>/,
			);
		}
	});

	it("only the invitations that can still be accepted", async () => {
		const used = await invite(ada.cookie, acme.id, "used@example.com");
		const expired = await invite(ada.cookie, acme.id, "expired@example.com");
		const cancelled = await invite(ada.cookie, acme.id, "cancelled@example.com");
		await invite(ada.cookie, acme.id, "waiting@example.com");
		await env.DB.batch([
			env.DB.prepare("update invitations set status = 'accepted' where id = ?").bind(used.id),
			env.DB.prepare("update invitations set expires_at = ? where id = ?").bind(
				Date.now() - 1000,
				expired.id,
			),
			env.DB.prepare("update invitations set status = 'canceled' where id = ?").bind(cancelled.id),
		]);

		const text = textOf(await pageBody(await open(INVITATIONS, ada)));

		expect(text).toContain("waiting@example.com");
		for (const gone of ["used", "expired", "cancelled"]) {
			expect(text).not.toContain(`${gone}@example.com`);
		}
	});
});

describe("inviting", () => {
	it.each(["owner", "admin"] as const)(
		"an %s invites an address, and the email goes out",
		async (role) => {
			const who = role === "owner" ? ada : await memberOfAcme(role, "grace@example.com");

			const response = await ask(who, {
				intent: "invite",
				email: " bob@example.com ",
				role: "member",
			});

			expect(response.status).toBe(200);
			expect(response.said).toContain("An invitation is on its way to bob@example.com.");
			expect(await pendingInvitations()).toBe(1);
			await vi.waitFor(() =>
				expect(mailbox.sent().some(({ to }) => to === "bob@example.com")).toBe(true),
			);
			expect(textOf(await pageBody(await open(INVITATIONS, who)))).toContain(
				"bob@example.com Invited as a member.",
			);
		},
	);

	it("a manager who is a member and posts the form the page does not show them is refused by the server", async () => {
		const linus = await managerOfAcme("linus@example.com");

		const response = await ask(linus, {
			intent: "invite",
			email: "bob@example.com",
			role: "member",
		});

		expect(response.status).toBe(403);
		expect(response.said).toContain(NOT_ALLOWED);
		expect(await pendingInvitations()).toBe(0);
		expect(mailbox.sent().some(({ to }) => to === "bob@example.com")).toBe(false);
	});

	it("nobody is invited to be an owner", async () => {
		const response = await ask(ada, { intent: "invite", email: "bob@example.com", role: "owner" });

		expect(response.status).toBe(400);
		expect(await pendingInvitations()).toBe(0);
	});

	it.each([
		["a word", "bob"],
		["an address without a domain", "bob@"],
		["two addresses", "bob@example.com, eve@example.com"],
	])("says so in a sentence when the address is %s", async (_case, email) => {
		const response = await ask(ada, { intent: "invite", email, role: "member" });

		expect(response.status).toBe(400);
		expect(response.said).toContain("That email address is not valid. Check it and try again.");
		expect(await pendingInvitations()).toBe(0);
	});

	it("says so when the person is already a member", async () => {
		await memberOfAcme("member", "linus@example.com");

		const response = await ask(ada, {
			intent: "invite",
			email: "linus@example.com",
			role: "member",
		});

		expect(response.status).toBe(400);
		expect(response.said).toContain("That person is already a member of this organisation.");
	});

	it("says so when the address already has an invitation waiting", async () => {
		await invite(ada.cookie, acme.id, "bob@example.com");

		const response = await ask(ada, { intent: "invite", email: "bob@example.com", role: "admin" });

		expect(response.status).toBe(400);
		expect(response.said).toContain("That address already has an invitation that is waiting.");
		expect(await pendingInvitations()).toBe(1);
	});

	it("refuses the twenty-first invitation one person sends in a day, and says when to try again", async () => {
		// Twenty invitations, each from a client address of its own: the limit on
		// one client is not what this test is about.
		for (let n = 1; n <= 20; n++) {
			const sent = await post(
				"/organization/invite-member",
				{ organizationId: acme.id, email: `guest-${n}@example.com`, role: "member" },
				{ cookie: ada.cookie, client: `192.0.2.${n}` },
			);
			expect(sent.status, `invitation ${n}`).toBe(200);
		}

		const response = await ask(ada, { intent: "invite", email: "bob@example.com", role: "member" });

		// The same status as the limiter's, and a sentence of its own.
		expect(response.status).toBe(429);
		expect(response.said).toContain(
			"You have sent the most invitations allowed in one day. Try again tomorrow.",
		);
		expect(response.said).not.toContain("Try again in a minute.");
		expect(await pendingInvitations()).toBe(20);
	});

	it("says too many attempts when the server's limit is reached", async () => {
		// Ten requests a minute for one client, whatever their answer.
		for (let n = 1; n <= 10; n++) {
			expect((await post("/organization/invite-member", {}, ada)).status).toBe(400);
		}

		const response = await ask(ada, { intent: "invite", email: "bob@example.com", role: "member" });

		expect(response.status).toBe(429);
		expect(response.said).toContain("Too many attempts. Try again in a minute.");
		expect(await pendingInvitations()).toBe(0);
	});
});

describe("cancelling an invitation", () => {
	it("an admin cancels it, and its link stops working", async () => {
		const grace = await memberOfAcme("admin", "grace@example.com");
		const { id } = await invite(ada.cookie, acme.id, "bob@example.com");

		const response = await ask(grace, { intent: "cancel", invitationId: id });

		expect(response.status).toBe(200);
		expect(response.said).toContain("Invitation cancelled.");
		expect(await pendingInvitations()).toBe(0);
		const bob = await person(mailbox, "bob@example.com");
		expect((await open(`/invitations/${id}`, bob)).status).toBe(410);
	});

	it("a manager who is a member is refused by the server", async () => {
		const linus = await managerOfAcme("linus@example.com");
		const { id } = await invite(ada.cookie, acme.id, "bob@example.com");

		const response = await ask(linus, { intent: "cancel", invitationId: id });

		expect(response.status).toBe(403);
		expect(response.said).toContain(NOT_ALLOWED);
		expect(await pendingInvitations()).toBe(1);
	});

	it("an invitation of another organisation is not there to cancel", async () => {
		const grace = await person(mailbox, "grace@example.com");
		const initech = await createOrganisation(grace.cookie, "Initech");
		const { id } = await invite(grace.cookie, initech.id, "bob@example.com");

		const response = await ask(ada, { intent: "cancel", invitationId: id });

		expect(response.status).toBe(404);
		expect(response.said).toContain("That invitation is no longer waiting.");
		expect(await pendingInvitations()).toBe(1);
	});
});

describe("changing a role", () => {
	it("an owner makes a member an admin, and another member an owner", async () => {
		const grace = await memberOfAcme("member", "grace@example.com");
		const linus = await memberOfAcme("member", "linus@example.com");

		const first = await ask(ada, { intent: "role", memberId: grace.memberId, role: "admin" });
		const second = await ask(ada, { intent: "role", memberId: linus.memberId, role: "owner" });

		expect(first.status).toBe(200);
		expect(first.said).toContain("Role changed. They are now an admin.");
		expect(second.status).toBe(200);
		expect(await roleOf(grace.memberId)).toBe("admin");
		expect(await roleOf(linus.memberId)).toBe("owner");
	});

	it("an admin changes a member, and is refused an owner's role in either direction", async () => {
		const grace = await memberOfAcme("admin", "grace@example.com");
		const linus = await memberOfAcme("member", "linus@example.com");

		expect(
			(await ask(grace, { intent: "role", memberId: linus.memberId, role: "admin" })).status,
		).toBe(200);

		const promote = await ask(grace, { intent: "role", memberId: linus.memberId, role: "owner" });
		const demote = await ask(grace, {
			intent: "role",
			memberId: await memberIdOf(ada),
			role: "member",
		});

		expect(promote.status).toBe(403);
		expect(promote.said).toContain(NOT_ALLOWED);
		expect(demote.status).toBe(403);
		expect(await roleOf(linus.memberId)).toBe("admin");
		expect(await roleOf(await memberIdOf(ada))).toBe("owner");
	});

	it("a manager who is a member and posts the form the page does not show them is refused by the server", async () => {
		const grace = await memberOfAcme("member", "grace@example.com");
		const linus = await managerOfAcme("linus@example.com");

		const response = await ask(linus, { intent: "role", memberId: grace.memberId, role: "admin" });
		const own = await ask(linus, { intent: "role", memberId: linus.memberId, role: "owner" });

		expect(response.status).toBe(403);
		expect(response.said).toContain(NOT_ALLOWED);
		expect(own.status).toBe(403);
		expect(await roleOf(grace.memberId)).toBe("member");
		expect(await roleOf(linus.memberId)).toBe("member");
	});

	it("the last owner cannot be made anything less, and is told why", async () => {
		const response = await ask(ada, {
			intent: "role",
			memberId: await memberIdOf(ada),
			role: "member",
		});

		expect(response.status).toBe(400);
		expect(response.said).toContain(NEEDS_AN_OWNER);
		expect(await roleOf(await memberIdOf(ada))).toBe("owner");
	});

	it("a member of another organisation is not there to change", async () => {
		const grace = await person(mailbox, "grace@example.com");
		await createOrganisation(grace.cookie, "Initech");
		const theirs = await memberIdOf(grace);

		const response = await ask(ada, { intent: "role", memberId: theirs, role: "member" });

		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(await roleOf(theirs)).toBe("owner");
	});
});

describe("removing a member", () => {
	it("an admin removes a member, who then gets 404 for the organisation", async () => {
		const grace = await memberOfAcme("admin", "grace@example.com");
		const linus = await memberOfAcme("member", "linus@example.com");
		expect((await open(ACCOUNT, linus)).status).toBe(200);

		const response = await ask(grace, { intent: "remove", memberId: linus.memberId });

		expect(response.status).toBe(200);
		expect(response.said).toContain("Member removed.");
		expect(await membersOfAcme()).toBe(2);
		expect((await open(ACCOUNT, linus)).status).toBe(404);
	});

	it("a manager who is a member and posts the form the page does not show them is refused by the server", async () => {
		const grace = await memberOfAcme("member", "grace@example.com");
		const linus = await managerOfAcme("linus@example.com");

		const response = await ask(linus, { intent: "remove", memberId: grace.memberId });

		// The server answers this one 401; to the person it is the same refusal.
		expect(response.status).toBe(403);
		expect(response.said).toContain(NOT_ALLOWED);
		expect(await membersOfAcme()).toBe(3);
	});

	it("an admin is refused the removal of an owner, though another owner would remain", async () => {
		const grace = await memberOfAcme("admin", "grace@example.com");
		await memberOfAcme("owner", "hedy@example.com");

		const response = await ask(grace, { intent: "remove", memberId: await memberIdOf(ada) });

		expect(response.status).toBe(400);
		expect(response.said).toContain(NOT_ALLOWED);
		expect(await membersOfAcme()).toBe(3);
	});

	it("the last owner cannot be removed, and the person is told why", async () => {
		const response = await ask(ada, { intent: "remove", memberId: await memberIdOf(ada) });

		expect(response.status).toBe(400);
		expect(response.said).toContain(NEEDS_AN_OWNER);
		expect(await membersOfAcme()).toBe(1);
	});
});

describe("leaving", () => {
	it("a member leaves, is sent to /app, and the organisation is 404 to them", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");

		const response = await submit(ACCOUNT, { intent: "leave" }, linus);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/app");
		expect(await membersOfAcme()).toBe(1);
		expect((await open(ACCOUNT, linus)).status).toBe(404);
	});

	it("the last owner cannot leave, and is told why", async () => {
		await memberOfAcme("admin", "grace@example.com");

		const response = await ask(ada, { intent: "leave" });

		expect(response.status).toBe(400);
		expect(response.said).toContain(
			"You are the only owner of this organisation. Make another member an owner before you leave.",
		);
		expect(await membersOfAcme()).toBe(2);
		expect((await open(MEMBERS, ada)).status).toBe(200);
	});

	it("an owner leaves once another member is an owner", async () => {
		await memberOfAcme("owner", "grace@example.com");

		const response = await submit(ACCOUNT, { intent: "leave" }, ada);

		expect(response.status).toBe(302);
		expect(await value("select count(*) from memberships where user_id = ?", ada.user.id)).toBe(0);
	});

	it("leaves the organisation in the address, whatever the form names", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");
		const initech = await createOrganisation(linus.cookie, "Initech");

		await submit(ACCOUNT, { intent: "leave", organizationId: initech.id }, linus);

		expect(await value("select count(*) from memberships where user_id = ?", linus.user.id)).toBe(
			1,
		);
		expect(
			await value("select organisation_id from memberships where user_id = ?", linus.user.id),
		).toBe(initech.id);
	});
});

describe("the same action asked of the server directly", () => {
	// The page's action is one caller of these endpoints; a browser is another.
	// What a member is refused through the page, they are refused here too.
	it("is refused to a member, endpoint by endpoint", async () => {
		const grace = await memberOfAcme("member", "grace@example.com");
		const linus = await memberOfAcme("member", "linus@example.com");
		const { id: invitationId } = await invite(ada.cookie, acme.id, "bob@example.com");
		const organizationId = acme.id;

		const refusals = {
			"invite-member": { organizationId, email: "eve@example.com", role: "member" },
			"cancel-invitation": { organizationId, invitationId },
			"update-member-role": { organizationId, memberId: grace.memberId, role: "admin" },
			"remove-member": { organizationId, memberIdOrEmail: grace.memberId },
			update: { organizationId, data: { name: "Linus Ltd" } },
			delete: { organizationId },
		};
		for (const [endpoint, body] of Object.entries(refusals)) {
			const response = await post(`/organization/${endpoint}`, body, linus);
			expect([401, 403], endpoint).toContain(response.status);
		}

		expect(await membersOfAcme()).toBe(3);
		expect(await pendingInvitations()).toBe(1);
		expect(await roleOf(grace.memberId)).toBe("member");
		expect(await value("select name from organisations where id = ?", acme.id)).toBe("Acme");
	});
});
