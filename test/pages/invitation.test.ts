import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signInPath } from "~/routes/auth/paths";
import { captureEmail, type Mailbox, post } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	invite,
	SEVEN_DAYS,
	seedInvitation,
	seedMembership,
	value,
} from "../organisations/harness";
import { open, openData, type Person, pageBody, person, submit, textOf } from "./harness";

// The page an invitation's link opens, /invitations/<id>. Criterion 2 of card
// TS-009: the link works once and expires after 7 days, and a used or expired
// link is rejected. Every invitation that cannot be accepted by the person
// asking gets one page with status 410, the same whatever the reason.

const GONE = "This invitation is no longer valid";

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string; slug: string };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/** Ada owns Acme and has invited bob@example.com. Returns the address of the invitation's page. */
async function invited(role: "admin" | "member" = "member") {
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	const { id } = await invite(ada.cookie, acme.id, "bob@example.com", role);
	return { id, page: `/invitations/${id}` };
}

/**
 * What a response says, apart from what the person asking already has and a
 * page may repeat: the address it was asked for and, under "Signed in as",
 * their own email address. Two invitations can then be compared.
 */
async function said(response: Response, id: string, who: Person): Promise<string> {
	return (await pageBody(response))
		.replaceAll(`/invitations/${id}`, "/invitations/~")
		.replaceAll(encodeURIComponent(`/invitations/${id}`), "/invitations/~")
		.replaceAll(who.user.email, "~");
}

describe("the link in the email", () => {
	it("is the address of the invitation's page", async () => {
		const { page } = await invited();

		const message = mailbox.sent().find(({ to }) => to === "bob@example.com");
		expect(message?.text).toContain(`https://timesifier.example${page}`);
	});
});

describe("opened without a session", () => {
	it("sends the person to sign in, and back to the invitation afterwards", async () => {
		const { page } = await invited();

		const response = await open(page);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(signInPath(page));
		expect(response.headers.get("Location")).toBe(`/sign-in?next=${encodeURIComponent(page)}`);
	});

	it("asks for a whole page load when script asks for its data", async () => {
		const { page } = await invited();

		const response = await openData(page);

		expect(response.status).toBe(202);
		expect(response.headers.get("X-Remix-Reload-Document")).toBe("true");
		expect(await response.text()).toContain(JSON.stringify(signInPath(page)));
	});

	it("says the same for an invitation that does not exist", async () => {
		await invited();
		const unknown = "/invitations/01a1c948-14f6-7039-803e-d4cceb52f23a";

		const response = await open(unknown);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(signInPath(unknown));
	});

	it("does not answer a form: joining needs a session", async () => {
		const { id, page } = await invited();

		const response = await submit(page, { intent: "join" });

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(signInPath(page));
		expect(await value("select status from invitations where id = ?", id)).toBe("pending");
	});

	it("brings the person back from the sign-in page once they have a session", async () => {
		const { page } = await invited();
		const bob = await person(mailbox, "bob@example.com");

		const response = await open(signInPath(page), bob);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(page);
	});
});

describe("opened by the person it was sent to", () => {
	it("names the organisation, who invited them and the role, with Join and Decline", async () => {
		const { page } = await invited("admin");
		const bob = await person(mailbox, "bob@example.com");

		const response = await open(page, bob);

		expect(response.status).toBe(200);
		const html = await pageBody(response);
		const text = textOf(html);
		expect(text).toContain("Join Acme?");
		// Ada has not given a name, so she is shown by her address.
		expect(text).toContain("ada@example.com invited you to join Acme as an admin.");
		// Buttons that can wait (docs/design-system.md, "While the page waits") hold their words in a span.
		expect(html).toMatch(/<button[^>]*value="join"[^>]*>(?:<span[^>]*>){2}Join<\/span>/);
		expect(html).toMatch(/<button[^>]*value="decline"[^>]*>(?:<span[^>]*>){2}Decline<\/span>/);
		expect(text).not.toContain(GONE);
	});

	it("shows the name of the person who invited them when they have one", async () => {
		const { page } = await invited();
		await env.DB.prepare("update users set name = 'Ada Lovelace' where id = ?")
			.bind(ada.user.id)
			.run();
		const bob = await person(mailbox, "bob@example.com");

		const text = textOf(await pageBody(await open(page, bob)));

		expect(text).toContain("Ada Lovelace (ada@example.com) invited you to join Acme as a member.");
	});

	it("Join makes them a member with the invited role and goes to the organisation", async () => {
		const { id, page } = await invited("admin");
		const bob = await person(mailbox, "bob@example.com");

		const response = await submit(page, { intent: "join" }, bob);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/app/acme");
		expect(await value("select role from memberships where user_id = ?", bob.user.id)).toBe(
			"admin",
		);
		expect(await value("select status from invitations where id = ?", id)).toBe("accepted");
		expect((await open("/app/acme", bob)).status).toBe(200);
	});

	it("works once: the same link afterwards is no longer valid, and joins nobody twice", async () => {
		const { page } = await invited();
		const bob = await person(mailbox, "bob@example.com");
		expect((await submit(page, { intent: "join" }, bob)).status).toBe(302);

		const again = await open(page, bob);
		expect(again.status).toBe(410);
		expect(textOf(await pageBody(again))).toContain(GONE);

		const joinAgain = await submit(page, { intent: "join" }, bob, { byScript: true });
		expect(joinAgain.status).toBe(410);
		expect(await value("select count(*) from memberships where user_id = ?", bob.user.id)).toBe(1);
	});

	it("Decline leaves them out and goes to /app", async () => {
		const { id, page } = await invited();
		const bob = await person(mailbox, "bob@example.com");

		const response = await submit(page, { intent: "decline" }, bob);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/app");
		expect(await value("select status from invitations where id = ?", id)).toBe("rejected");
		expect(await value("select count(*) from memberships where user_id = ?", bob.user.id)).toBe(0);
		expect((await open(page, bob)).status).toBe(410);
	});

	it("is still theirs one minute before seven days have passed, and not one minute after", async () => {
		const { id, page } = await invited();
		const bob = await person(mailbox, "bob@example.com");
		const sent = Date.now();
		// The expiry the server stored is seven days after the invitation was sent.
		const expiresAt = await value<number>("select expires_at from invitations where id = ?", id);
		expect(expiresAt).toBeGreaterThan(sent + SEVEN_DAYS - 60_000);
		expect(expiresAt).toBeLessThanOrEqual(Date.now() + SEVEN_DAYS);

		// Moving the expiry is moving the clock, without the session expiring as well.
		const setExpiry = (at: number) =>
			env.DB.prepare("update invitations set expires_at = ? where id = ?").bind(at, id).run();

		await setExpiry(Date.now() + 60_000);
		expect((await open(page, bob)).status).toBe(200);

		await setExpiry(Date.now() - 60_000);
		const expired = await open(page, bob);
		expect(expired.status).toBe(410);
		expect(textOf(await pageBody(expired))).toContain(GONE);
		expect((await submit(page, { intent: "join" }, bob, { byScript: true })).status).toBe(410);
		expect(await value("select count(*) from memberships where user_id = ?", bob.user.id)).toBe(0);
	});
});

describe("an invitation that cannot be accepted", () => {
	type Case = {
		name: string;
		/** Makes the invitation invalid, and returns who opens it and its id. */
		arrange(): Promise<{ who: Person; id: string }>;
	};

	const cases: Case[] = [
		{
			name: "used",
			async arrange() {
				const { id, page } = await invited();
				const bob = await person(mailbox, "bob@example.com");
				expect((await submit(page, { intent: "join" }, bob)).status).toBe(302);
				return { who: bob, id };
			},
		},
		{
			name: "declined",
			async arrange() {
				const { id, page } = await invited();
				const bob = await person(mailbox, "bob@example.com");
				expect((await submit(page, { intent: "decline" }, bob)).status).toBe(302);
				return { who: bob, id };
			},
		},
		{
			name: "cancelled by the organisation",
			async arrange() {
				const { id } = await invited();
				const cancelled = await post(
					"/organization/cancel-invitation",
					{ organizationId: acme.id, invitationId: id },
					ada,
				);
				expect(cancelled.status).toBe(200);
				return { who: await person(mailbox, "bob@example.com"), id };
			},
		},
		{
			name: "expired",
			async arrange() {
				const { id } = await invited();
				await env.DB.prepare("update invitations set expires_at = ? where id = ?")
					.bind(Date.now() - 1000, id)
					.run();
				return { who: await person(mailbox, "bob@example.com"), id };
			},
		},
		{
			name: "unknown",
			async arrange() {
				await invited();
				return {
					who: await person(mailbox, "bob@example.com"),
					id: "01a1c948-14f6-7039-803e-d4cceb52f23a",
				};
			},
		},
		{
			name: "opened by a person with another address",
			async arrange() {
				const { id } = await invited();
				return { who: await person(mailbox, "mallory@example.com"), id };
			},
		},
		{
			name: "opened by the person who sent it",
			async arrange() {
				const { id } = await invited();
				return { who: ada, id };
			},
		},
		{
			name: "from a sender who has left the organisation",
			async arrange() {
				const { id } = await invited();
				// Grace takes over as owner, and Ada, who sent the invitation, goes.
				const grace = await person(mailbox, "grace@example.com");
				await seedMembership(acme.id, grace.user.id, "owner");
				await env.DB.prepare("delete from memberships where user_id = ?").bind(ada.user.id).run();
				return { who: await person(mailbox, "bob@example.com"), id };
			},
		},
		{
			// An invitation dies with its sender's role (card TS-027).
			name: "from a sender who is no longer an owner or admin",
			async arrange() {
				const { id } = await invited();
				const grace = await person(mailbox, "grace@example.com");
				await seedMembership(acme.id, grace.user.id, "owner");
				await env.DB.prepare("update memberships set role = 'member' where user_id = ?")
					.bind(ada.user.id)
					.run();
				return { who: await person(mailbox, "bob@example.com"), id };
			},
		},
		{
			name: "of an organisation that has been deleted",
			async arrange() {
				const { id } = await invited();
				const deleted = await post("/organization/delete", { organizationId: acme.id }, ada);
				expect(deleted.status).toBe(200);
				return { who: await person(mailbox, "bob@example.com"), id };
			},
		},
	];

	/** The page for an invitation that never existed, opened by a person nobody invited. */
	async function reference(): Promise<string> {
		const stranger = await person(mailbox, "stranger@example.com");
		const id = "00000000-0000-7000-8000-000000000000";
		const response = await open(`/invitations/${id}`, stranger);
		expect(response.status).toBe(410);
		return said(response, id, stranger);
	}

	it.each(cases)("$name: status 410 and the one page", async ({ arrange }) => {
		const { who, id } = await arrange();

		const response = await open(`/invitations/${id}`, who);

		expect(response.status).toBe(410);
		const whole = await pageBody(response.clone());
		const body = await said(response, id, who);
		expect(body).toBe(await reference());
		const text = textOf(whole);
		expect(text).toContain(GONE);
		// Nothing of the invitation: not the organisation, not who sent it, not the
		// role, not who it was for. The one address on the page is the reader's own.
		expect(body).not.toContain("Acme");
		expect(body).not.toContain("ada@example.com");
		expect(body).not.toContain("bob@example.com");
		// Whose session this is, and the way back for a person who meant another address.
		expect(text).toContain(`Signed in as ${who.user.email}`);
		expect(text).toContain("Use a different email");
		// A way on.
		expect(body).toMatch(/<a[^>]*href="\/app"[^>]*>Go to Timesifier<\/a>/);
	});

	it.each(cases)(
		"$name: the data of the page says the same, with status 410",
		async ({ arrange }) => {
			const { who, id } = await arrange();

			const response = await openData(`/invitations/${id}`, who);

			expect(response.status).toBe(410);
			const body = (await response.text()).replaceAll(who.user.email, "~");
			expect(body).not.toContain("Acme");
			expect(body).not.toContain("ada@example.com");
			expect(body).not.toContain("bob@example.com");
		},
	);

	it.each(cases)("$name: Join is refused with 410 and joins nobody", async ({ arrange }) => {
		const { who, id } = await arrange();
		const before = await value("select count(*) from memberships");

		for (const byScript of [false, true]) {
			const response = await submit(`/invitations/${id}`, { intent: "join" }, who, { byScript });
			expect(response.status).toBe(410);
			expect(await response.text()).not.toContain("Acme");
		}

		expect(await value("select count(*) from memberships")).toBe(before);
	});

	it("an id that is not one is the same page, and never reaches the database as a query", async () => {
		const stranger = await person(mailbox, "stranger@example.com");
		const expected = await reference();

		for (const id of ["x", "1%27%20or%201=1", "a".repeat(200)]) {
			const response = await open(`/invitations/${id}`, stranger);
			expect(response.status, id).toBe(410);
			expect(await said(response, id, stranger), id).toBe(expected);
		}
	});
});

describe("an invitation seeded for an address that then signs up", () => {
	it("is theirs once they have proved the address by signing in", async () => {
		ada = await person(mailbox, "ada@example.com");
		acme = await createOrganisation(ada.cookie, "Acme");
		const id = await seedInvitation(acme.id, ada.user.id, "Bob@Example.com");

		// The address is compared without regard to case.
		const bob = await person(mailbox, "bob@example.com");

		expect((await open(`/invitations/${id}`, bob)).status).toBe(200);
	});
});
