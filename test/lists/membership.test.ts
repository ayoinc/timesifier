import { beforeEach, describe, expect, it } from "vitest";

import { OFFERED_ENDPOINTS } from "~/auth/endpoints";
import { uuidv7 } from "~/db";
import { captureEmail, get, type Mailbox, post } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { accept, createOrganisation, invite, value } from "../organisations/harness";
import { open, type Person, pageBody, person, textOf } from "../pages/harness";
import { insertAll } from "./crowd";

// More than 100 people in one organisation (TS-112). Better Auth's
// organization plugin holds an organisation to 100 members and 100 pending
// invitations unless told otherwise, and its lists read 100 rows unless told
// otherwise. The seats on the organisation's plan are the only limit now.

let mailbox: Mailbox;
let owner: Person;
let acme: { id: string; slug: string };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	owner = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(owner.cookie, "Acme");
	// The first request of the file loads the whole application.
}, 60_000);

const number = (i: number) => String(i + 1).padStart(3, "0");
const emailOf = (i: number) => `person${number(i)}@example.com`;

/** Fills Acme to `size` members, the owner among them: Person 001 and on. */
async function fillTo(size: number): Promise<void> {
	const ids = Array.from({ length: size - 1 }, () => uuidv7());
	const now = Date.now();
	await insertAll(
		"insert into users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 1, ?, ?)",
		ids.map((id, i) => [id, `Person ${number(i)}`, emailOf(i), now, now]),
	);
	await insertAll(
		"insert into memberships (id, organisation_id, user_id, role, created_at, updated_at) values (?, ?, ?, 'member', ?, ?)",
		ids.map((id) => [uuidv7(), acme.id, id, now, now]),
	);
}

/** A request's cookie and client, as `who` makes it. */
const as = ({ cookie, client }: Person) => ({ cookie, client });

const members = () => value("select count(*) from memberships where organisation_id = ?", acme.id);

/** Invites `email` to Acme, and accepts as that person once they have signed in. */
async function joins(email: string): Promise<Response> {
	const invitation = await invite(owner.cookie, acme.id, email);
	const invited = await person(mailbox, email);
	return accept(invited.cookie, invitation.id);
}

describe("an organisation of more than 100", () => {
	it("takes a 101st member by invitation", async () => {
		await fillTo(100);
		expect(await members()).toBe(100);

		const accepted = await joins("ida@example.com");

		expect(accepted.status).toBe(200);
		expect(await members()).toBe(101);
		expect(
			await value(
				"select count(*) from memberships m join users u on u.id = m.user_id where m.organisation_id = ? and u.email = ?",
				acme.id,
				"ida@example.com",
			),
		).toBe(1);
	});

	it("takes a 150th", async () => {
		await fillTo(149);

		const accepted = await joins("ida@example.com");

		expect(accepted.status).toBe(200);
		expect(await members()).toBe(150);
	});

	it("lists all 150 on the Members page", async () => {
		await fillTo(150);

		const response = await open("/app/acme/team/members", owner);

		expect(response.status).toBe(200);
		const text = textOf(await pageBody(response));
		expect(text).toContain("ada@example.com");
		for (let i = 0; i < 149; i++) expect(text).toContain(emailOf(i));
	});
});

/** What each test below has: Acme of 150, and Ida, invited and signed in. */
type Stage = { ida: Person; invitationId: string; memberId: string };

/**
 * One request to each organisation endpoint offered, as it is meant to be
 * made, so that it should succeed. A new endpoint offered fails the test
 * below until it has a request here.
 */
const REQUESTS: Record<string, (stage: Stage) => Promise<Response>> = {
	"POST /organization/create": () => post("/organization/create", { name: "Globex" }, as(owner)),
	"GET /organization/list": () => get("/organization/list", as(owner)),
	"GET /organization/get-invitation": ({ ida, invitationId }) =>
		get(`/organization/get-invitation?id=${invitationId}`, as(ida)),
	"POST /organization/accept-invitation": ({ ida, invitationId }) =>
		post("/organization/accept-invitation", { invitationId }, as(ida)),
	"POST /organization/reject-invitation": ({ ida, invitationId }) =>
		post("/organization/reject-invitation", { invitationId }, as(ida)),
	"GET /organization/list-invitations": () =>
		get(`/organization/list-invitations?organizationId=${acme.id}`, as(owner)),
	"POST /organization/update": () =>
		post("/organization/update", { organizationId: acme.id, data: { name: "Acme 2" } }, as(owner)),
	"POST /organization/delete": () =>
		post("/organization/delete", { organizationId: acme.id }, as(owner)),
	"POST /organization/invite-member": () =>
		post(
			"/organization/invite-member",
			{ organizationId: acme.id, email: "jo@example.com", role: "member" },
			as(owner),
		),
	"POST /organization/cancel-invitation": ({ invitationId }) =>
		post("/organization/cancel-invitation", { organizationId: acme.id, invitationId }, as(owner)),
	"POST /organization/update-member-role": ({ memberId }) =>
		post(
			"/organization/update-member-role",
			{ organizationId: acme.id, memberId, role: "admin" },
			as(owner),
		),
	"POST /organization/remove-member": ({ memberId }) =>
		post(
			"/organization/remove-member",
			{ organizationId: acme.id, memberIdOrEmail: memberId },
			as(owner),
		),
	"POST /organization/leave": async ({ ida, invitationId }) => {
		expect((await accept(ida.cookie, invitationId)).status).toBe(200);
		return post("/organization/leave", { organizationId: acme.id }, as(ida));
	},
};

describe("every organisation endpoint offered, in an organisation of 150", () => {
	const offered = Object.keys(OFFERED_ENDPOINTS).filter((endpoint) =>
		endpoint.includes(" /organization/"),
	);

	it("has a request below", () => {
		expect(Object.keys(REQUESTS).sort()).toEqual(offered.sort());
	});

	it.each(offered)("%s answers 200", async (endpoint) => {
		await fillTo(150);
		const ida = await person(mailbox, "ida@example.com");
		const { id: invitationId } = await invite(owner.cookie, acme.id, ida.user.email);
		const memberId = await value<string>(
			"select m.id from memberships m join users u on u.id = m.user_id where u.email = ?",
			emailOf(0),
		);
		const request = REQUESTS[endpoint];
		if (!request || !memberId) throw new Error(`No request for ${endpoint}`);

		const response = await request({ ida, invitationId, memberId });

		expect(response.status, await response.clone().text()).toBe(200);
	});
});

describe("an organisation inviting more than 100", () => {
	it("sends 120 invitations that wait together, and lists them all", async () => {
		// Six admins, as one person sends at most 20 invitations a day, and each
		// invitation from a client of its own, as one client sends at most 10 a
		// minute: neither of those is what this is about.
		const admins: Person[] = [];
		for (let a = 0; a < 6; a++) {
			const admin = await person(mailbox, `admin${a}@example.com`);
			const invitation = await invite(owner.cookie, acme.id, admin.user.email, "admin");
			expect((await accept(admin.cookie, invitation.id)).status).toBe(200);
			admins.push(admin);
		}

		for (let i = 0; i < 120; i++) {
			const sent = await post(
				"/organization/invite-member",
				{ organizationId: acme.id, email: emailOf(i), role: "member" },
				{ cookie: admins[Math.floor(i / 20)]?.cookie, client: `192.0.2.${i + 1}` },
			);
			expect(sent.status, `invitation ${i + 1}`).toBe(200);
		}
		expect(
			await value(
				"select count(*) from invitations where organisation_id = ? and status = 'pending'",
				acme.id,
			),
		).toBe(120);

		const page = await open("/app/acme/team/invitations", owner);
		expect(page.status).toBe(200);
		const text = textOf(await pageBody(page));
		for (let i = 0; i < 120; i++) expect(text).toContain(emailOf(i));
	});
});
