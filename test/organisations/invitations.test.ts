import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEmail, get, type Mailbox, post, setBinding, signIn } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	accept,
	answer,
	createOrganisation,
	INVITATION_NOT_FOUND,
	invite,
	ORGANISATION_NOT_FOUND,
	row,
	SEVEN_DAYS,
	value,
} from "./harness";

const SENDER = { name: "Timesifier", email: "no-reply@mail.timesifier.com" };

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** Ada owns Acme; Grace and Eve have accounts and belong to nothing. */
async function acme() {
	const ada = await signIn(mailbox, "ada@example.com");
	const grace = await signIn(mailbox, "grace@example.com");
	const eve = await signIn(mailbox, "eve@example.com");
	const organisation = await createOrganisation(ada.cookie, "Acme");
	return { ada, grace, eve, organisation };
}

const membershipOf = (userId: string) =>
	row<{ role: string; organisation_id: string }>(
		"select role, organisation_id from memberships where user_id = ?",
		userId,
	);
const statusOf = (invitationId: string) =>
	value<string>("select status from invitations where id = ?", invitationId);

/** The message that carries an invitation to `email`, once the Worker has handed it over. */
function invitationTo(email: string) {
	return vi.waitFor(() => {
		const message = mailbox
			.sent()
			.find(({ to, text }) => to === email && text.includes("/invitations/"));
		if (!message) throw new Error("no invitation has been sent to that address");
		return message;
	});
}

describe("an invitation", () => {
	it.each(["member", "admin"] as const)(
		"is accepted once, and makes its recipient a %s as it said",
		async (role) => {
			const { ada, grace, organisation } = await acme();
			const invitation = await invite(ada.cookie, organisation.id, "grace@example.com", role);

			const first = await accept(grace.cookie, invitation.id);
			const second = await accept(grace.cookie, invitation.id);

			expect(first.status).toBe(200);
			expect(await membershipOf(grace.user.id)).toEqual({ role, organisation_id: organisation.id });
			expect(await answer(second)).toEqual(INVITATION_NOT_FOUND);
			expect(await value("select count(*) from memberships")).toBe(2);
		},
	);

	it("works for exactly seven days", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const { ada, organisation } = await acme();
		const sentAt = Date.now();
		const early = await invite(ada.cookie, organisation.id, "grace@example.com");
		const late = await invite(ada.cookie, organisation.id, "eve@example.com");

		// Each signs in again at the time they answer: a session lasts seven days too.
		vi.setSystemTime(sentAt + SEVEN_DAYS - 1000);
		const grace = await signIn(mailbox, "grace@example.com");
		const aSecondBefore = await accept(grace.cookie, early.id);
		vi.setSystemTime(sentAt + SEVEN_DAYS + 1000);
		const eve = await signIn(mailbox, "eve@example.com");
		const aSecondAfter = await accept(eve.cookie, late.id);

		expect(await value("select expires_at from invitations where id = ?", early.id)).toBe(
			sentAt + SEVEN_DAYS,
		);
		expect(aSecondBefore.status).toBe(200);
		expect(await answer(aSecondAfter)).toEqual(INVITATION_NOT_FOUND);
		expect(await membershipOf(eve.user.id)).toBeNull();
	});

	it("is refused when its expiry has passed, and accepted with a minute left", async () => {
		const { ada, grace, eve, organisation } = await acme();
		const expired = await invite(ada.cookie, organisation.id, "grace@example.com");
		const lastMinute = await invite(ada.cookie, organisation.id, "eve@example.com");
		const setExpiry = "update invitations set expires_at = ? where id = ?";
		await env.DB.prepare(setExpiry)
			.bind(Date.now() - 1000, expired.id)
			.run();
		await env.DB.prepare(setExpiry)
			.bind(Date.now() + 60_000, lastMinute.id)
			.run();

		const tooLate = await accept(grace.cookie, expired.id);
		const inTime = await accept(eve.cookie, lastMinute.id);

		expect(await answer(tooLate)).toEqual(INVITATION_NOT_FOUND);
		expect(await membershipOf(grace.user.id)).toBeNull();
		expect(inTime.status).toBe(200);
		expect(await membershipOf(eve.user.id)).toMatchObject({ role: "member" });
	});

	it("is refused once it has been cancelled", async () => {
		const { ada, grace, organisation } = await acme();
		const invitation = await invite(ada.cookie, organisation.id, "grace@example.com");
		const cancelled = await post(
			"/organization/cancel-invitation",
			{ organizationId: organisation.id, invitationId: invitation.id },
			{ cookie: ada.cookie },
		);

		const response = await accept(grace.cookie, invitation.id);

		expect(cancelled.status).toBe(200);
		expect(await answer(response)).toEqual(INVITATION_NOT_FOUND);
		expect(await membershipOf(grace.user.id)).toBeNull();
	});

	it("is refused once its recipient has declined it", async () => {
		const { ada, grace, organisation } = await acme();
		const invitation = await invite(ada.cookie, organisation.id, "grace@example.com");
		const declined = await post(
			"/organization/reject-invitation",
			{ invitationId: invitation.id },
			{ cookie: grace.cookie },
		);

		const response = await accept(grace.cookie, invitation.id);

		expect(declined.status).toBe(200);
		expect(await answer(response)).toEqual(INVITATION_NOT_FOUND);
		expect(await membershipOf(grace.user.id)).toBeNull();
	});

	it("is refused to a person signed in with another address, and still works for its recipient", async () => {
		const { ada, grace, eve, organisation } = await acme();
		const invitation = await invite(ada.cookie, organisation.id, "grace@example.com");

		const byEve = await accept(eve.cookie, invitation.id);
		const byItsSender = await accept(ada.cookie, invitation.id);

		expect(await answer(byEve)).toEqual(INVITATION_NOT_FOUND);
		expect(await answer(byItsSender)).toEqual(INVITATION_NOT_FOUND);
		expect(await membershipOf(eve.user.id)).toBeNull();
		expect(await statusOf(invitation.id)).toBe("pending");
		expect((await accept(grace.cookie, invitation.id)).status).toBe(200);
	});

	it("is refused to a recipient whose address is no longer marked verified", async () => {
		const { ada, grace, organisation } = await acme();
		const invitation = await invite(ada.cookie, organisation.id, "grace@example.com");
		await env.DB.prepare("update users set email_verified = 0 where id = ?")
			.bind(grace.user.id)
			.run();

		const response = await accept(grace.cookie, invitation.id);

		expect(await answer(response)).toEqual(INVITATION_NOT_FOUND);
		expect(await membershipOf(grace.user.id)).toBeNull();
	});

	it("matches its recipient's address whatever the capitals", async () => {
		const { ada, grace, organisation } = await acme();
		const invitation = await invite(ada.cookie, organisation.id, "Grace@Example.COM");

		const response = await accept(grace.cookie, invitation.id);

		expect(response.status).toBe(200);
		expect(await membershipOf(grace.user.id)).toMatchObject({ role: "member" });
	});

	it("is refused without a session", async () => {
		const { ada, organisation } = await acme();
		const invitation = await invite(ada.cookie, organisation.id, "grace@example.com");

		const response = await post("/organization/accept-invitation", { invitationId: invitation.id });

		expect(response.status).toBe(401);
		expect(await statusOf(invitation.id)).toBe("pending");
	});

	describe.each([
		["accepting it", (cookie: string, id: string) => accept(cookie, id)],
		[
			"declining it",
			(cookie: string, id: string) =>
				post("/organization/reject-invitation", { invitationId: id }, { cookie }),
		],
		[
			"reading it",
			(cookie: string, id: string) => get(`/organization/get-invitation?id=${id}`, { cookie }),
		],
	])("refused when %s", (_what, attempt) => {
		it("answers the same whether it is unknown, used, cancelled, expired or somebody else's", async () => {
			const { ada, grace, eve, organisation } = await acme();
			const mallory = await signIn(mailbox, "mallory@example.com");
			const heidi = await signIn(mailbox, "heidi@example.com");
			const invitedAs = async (email: string) =>
				(await invite(ada.cookie, organisation.id, email)).id;
			const used = await invitedAs("grace@example.com");
			const cancelled = await invitedAs("eve@example.com");
			const expired = await invitedAs("mallory@example.com");
			const somebodyElses = await invitedAs("ivan@example.com");
			expect((await accept(grace.cookie, used)).status).toBe(200);
			await post(
				"/organization/cancel-invitation",
				{ organizationId: organisation.id, invitationId: cancelled },
				{ cookie: ada.cookie },
			);
			await env.DB.prepare("update invitations set expires_at = ? where id = ?")
				.bind(Date.now() - 1000, expired)
				.run();

			const answers = [
				await answer(await attempt(heidi.cookie, "01a1c8d1-e1d2-764e-873b-702e723663fe")),
				await answer(await attempt(grace.cookie, used)),
				await answer(await attempt(eve.cookie, cancelled)),
				await answer(await attempt(mallory.cookie, expired)),
				await answer(await attempt(heidi.cookie, somebodyElses)),
			];

			for (const each of answers) expect(each).toEqual(INVITATION_NOT_FOUND);
		});
	});

	it("can be read by its recipient before they decide", async () => {
		const { ada, grace, organisation } = await acme();
		const invitation = await invite(ada.cookie, organisation.id, "grace@example.com", "admin");

		const response = await get(`/organization/get-invitation?id=${invitation.id}`, {
			cookie: grace.cookie,
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			organizationName: "Acme",
			organizationSlug: "acme",
			inviterEmail: "ada@example.com",
			role: "admin",
			status: "pending",
		});
	});

	it("goes with its organisation when the organisation is deleted", async () => {
		const { ada, grace, organisation } = await acme();
		const invitation = await invite(ada.cookie, organisation.id, "grace@example.com");

		const deleted = await post(
			"/organization/delete",
			{ organizationId: organisation.id },
			{ cookie: ada.cookie },
		);

		expect(deleted.status).toBe(200);
		expect(await value("select count(*) from invitations")).toBe(0);
		expect(await value("select count(*) from memberships")).toBe(0);
		expect(await answer(await accept(grace.cookie, invitation.id))).toEqual(INVITATION_NOT_FOUND);
	});
});

describe("inviting a person", () => {
	it.each([
		["an address that is already a member", { email: "ada@example.com", role: "member" }],
		["the role owner", { email: "grace@example.com", role: "owner" }],
		["a list of roles", { email: "grace@example.com", role: ["member", "owner"] }],
		["two roles in one", { email: "grace@example.com", role: "member,owner" }],
		["a role nobody defined", { email: "grace@example.com", role: "billing" }],
		["no role", { email: "grace@example.com" }],
		["something that is not an address", { email: "grace", role: "member" }],
		["a team", { email: "grace@example.com", role: "member", teamId: "any" }],
	])("is refused for %s", async (_what, body) => {
		const { ada, organisation } = await acme();

		const response = await post(
			"/organization/invite-member",
			{ organizationId: organisation.id, ...body },
			{ cookie: ada.cookie },
		);

		expect(response.status).toBe(400);
		expect(await value("select count(*) from invitations")).toBe(0);
		expect(mailbox.sent().filter(({ text }) => text.includes("/invitations/"))).toEqual([]);
	});

	it("is refused for an address that already has a pending invitation, even as a resend", async () => {
		const { ada, organisation } = await acme();
		const first = await invite(ada.cookie, organisation.id, "grace@example.com");
		const expiry = await value("select expires_at from invitations");
		const again = { organizationId: organisation.id, email: "GRACE@example.com", role: "admin" };

		const second = await post("/organization/invite-member", again, { cookie: ada.cookie });
		const resent = await post(
			"/organization/invite-member",
			{ ...again, resend: true },
			{ cookie: ada.cookie },
		);

		expect([second.status, resent.status]).toEqual([400, 400]);
		expect(await row("select id, role, expires_at from invitations")).toEqual({
			id: first.id,
			role: "member",
			expires_at: expiry,
		});
	});

	it("is possible again once the earlier invitation has expired or been cancelled", async () => {
		const { ada, organisation } = await acme();
		const first = await invite(ada.cookie, organisation.id, "grace@example.com");
		await env.DB.prepare("update invitations set expires_at = ?")
			.bind(Date.now() - 1000)
			.run();

		const second = await invite(ada.cookie, organisation.id, "grace@example.com");

		expect(second.id).not.toBe(first.id);
	});

	it("sends one plain message from the application's address to the invited address, with the link once", async () => {
		const { ada, organisation } = await acme();

		const invitation = await invite(ada.cookie, organisation.id, "Grace@Example.com", "admin");

		const message = await invitationTo("grace@example.com");
		const link = `https://timesifier.com/invitations/${invitation.id}`;
		expect(message.from).toEqual(SENDER);
		expect(message.subject).toBe("You are invited to join Acme on Timesifier");
		expect(message.text.split(link)).toHaveLength(2);
		expect(message.html.split(link)).toHaveLength(2);
		// Nothing a mail program would fetch, and no address but ours.
		expect(message.text.match(/https?:/g)).toHaveLength(1);
		expect(message.html.match(/https?:/g)).toHaveLength(1);
		expect(message.html).not.toMatch(/<img|<link|<script|<style|src=|url\(/i);
		expect(message.text).toContain(
			"ada@example.com has invited you to join “Acme” on Timesifier as an admin.",
		);
		expect(mailbox.sent().filter(({ text }) => text.includes("/invitations/"))).toHaveLength(1);
	});

	// `ENVIRONMENT` is what tells the Worker it is a preview (workers/canonical-host.ts).
	it.each([
		["a pull request's preview", "preview", "https://pr-12-timesifier.ayoinc.workers.dev"],
		["a developer's machine", "production", "http://localhost:5173"],
	])(
		"puts the link on the host the invitation was made on: %s",
		async (_name, environment, origin) => {
			setBinding("ENVIRONMENT", environment);
			const ada = await signIn(mailbox, "ada@example.com", { origin });
			const created = await post(
				"/organization/create",
				{ name: "Acme" },
				{ origin, cookie: ada.cookie },
			);
			const { id: organizationId } = (await created.json()) as { id: string };

			const invited = await post(
				"/organization/invite-member",
				{ organizationId, email: "grace@example.com", role: "member" },
				{ origin, cookie: ada.cookie },
			);

			const { id } = (await invited.json()) as { id: string };
			const message = await invitationTo("grace@example.com");
			expect(message.text).toContain(`${origin}/invitations/${id}\n`);
		},
	);

	it("cannot put markup into the message through the organisation's name", async () => {
		const ada = await signIn(mailbox, "ada@example.com");
		const organisation = await createOrganisation(ada.cookie, `<img src="//evil.example/x"> & Co`);

		await invite(ada.cookie, organisation.id, "grace@example.com");

		const message = await invitationTo("grace@example.com");
		expect(message.html).toContain("&lt;img src=&quot;//evil.example/x&quot;&gt; &amp; Co");
		expect(message.html).not.toContain("<img");
	});

	it("is made even when its message cannot be sent, and the failure is logged without the address", async () => {
		const { ada, organisation } = await acme();
		mailbox.send.mockRejectedValue(Object.assign(new Error("boom"), { code: "E_INTERNAL" }));
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});

		const invitation = await invite(ada.cookie, organisation.id, "grace@example.com");

		expect(await statusOf(invitation.id)).toBe("pending");
		await vi.waitFor(() => expect(logged).toHaveBeenCalled());
		expect(logged.mock.calls.join("\n")).not.toContain("grace@example.com");
	});

	it("writes no address, invitation id or session token to the log", async () => {
		const { ada, grace, organisation } = await acme();
		// Without the binding, as on a preview, the mail module logs that it sent nothing.
		setBinding("EMAIL", undefined);
		const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
			vi.spyOn(console, level).mockImplementation(() => {}),
		);

		const invitation = await invite(ada.cookie, organisation.id, "grace@example.com");
		await accept(grace.cookie, invitation.id);
		await accept(grace.cookie, invitation.id);
		await vi.waitFor(() =>
			expect(logs.flatMap((log) => log.mock.calls).join("\n")).toContain(
				"recipient at example.com",
			),
		);

		const written = logs.flatMap((log) => log.mock.calls).join("\n");
		for (const secret of ["grace@example.com", "ada@example.com", invitation.id]) {
			expect(written).not.toContain(secret);
		}
		for (const { cookie } of [ada, grace]) {
			const token = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)).split(".")[0];
			expect(written).not.toContain(token);
		}
	});
});

describe("an invitation and the organisations around it", () => {
	it("cannot be cancelled by a member of another organisation", async () => {
		const { ada, eve, organisation } = await acme();
		const globex = await createOrganisation(eve.cookie, "Globex");
		const invitation = await invite(ada.cookie, organisation.id, "grace@example.com");

		const namingHerOwn = await post(
			"/organization/cancel-invitation",
			{ organizationId: globex.id, invitationId: invitation.id },
			{ cookie: eve.cookie },
		);
		const namingTheirs = await post(
			"/organization/cancel-invitation",
			{ organizationId: organisation.id, invitationId: invitation.id },
			{ cookie: eve.cookie },
		);
		const namingNone = await post(
			"/organization/cancel-invitation",
			{ invitationId: invitation.id },
			{ cookie: eve.cookie },
		);

		expect(await answer(namingHerOwn)).toEqual(INVITATION_NOT_FOUND);
		expect(await answer(namingTheirs)).toEqual(ORGANISATION_NOT_FOUND);
		expect(namingNone.status).toBe(400);
		expect(await statusOf(invitation.id)).toBe("pending");
	});

	it("is listed for its recipient, and for nobody else", async () => {
		const { ada, grace, eve, organisation } = await acme();
		const invitation = await invite(ada.cookie, organisation.id, "grace@example.com");

		const graces = await get("/organization/list-user-invitations", { cookie: grace.cookie });
		const eves = await get("/organization/list-user-invitations", { cookie: eve.cookie });

		expect(await graces.json()).toEqual([expect.objectContaining({ id: invitation.id })]);
		expect(await eves.json()).toEqual([]);
	});
});
