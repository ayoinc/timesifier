import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSession } from "~/auth/auth.server";
import { type Membership, requireMembershipOf } from "~/organisations/membership.server";
import { captureEmail, type Mailbox, ORIGIN, post, signIn } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	type Role,
	seedMembership,
	seedOrganisation,
	signInAs,
} from "./harness";

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** The request a page under `/app/<slug>/` would hand to the membership function. */
function pageRequest(slug: string, cookie?: string, origin = ORIGIN): Request {
	return new Request(`${origin}/app/${slug}/projects`, {
		headers: cookie ? { Cookie: cookie } : {},
	});
}

/**
 * What the organisation layout reaches for a request: the session guard reads
 * the person, then `requireMembershipOf` returns their membership or throws.
 * `"signed out"` where the guard finds nobody, so no membership is looked up.
 */
async function outcome(request: Request, slug: string): Promise<Membership | unknown> {
	const signedIn = await getSession(request);
	if (!signedIn) return "signed out";
	try {
		return await requireMembershipOf(signedIn, slug);
	} catch (thrown) {
		return thrown;
	}
}

/** React Router answers a thrown `data(…, { status: 404 })` with its 404. */
const NOT_FOUND = { data: "Not Found", init: { status: 404 } };

/** Ada owns Acme and Grace owns Globex; neither belongs to the other's. */
async function twoOrganisations() {
	const ada = await signIn(mailbox, "ada@example.com");
	const grace = await signIn(mailbox, "grace@example.com");
	const acme = await createOrganisation(ada.cookie, "Acme");
	const globex = await createOrganisation(grace.cookie, "Globex");
	return { ada, grace, acme, globex };
}

describe("the membership function", () => {
	it.each(["owner", "admin", "member"] as const)(
		"returns the organisation and the role for its %s",
		async (role: Role) => {
			const organisation = await seedOrganisation("Acme", "acme");
			const person = await signInAs(mailbox, organisation.id, role, "ada@example.com");

			const membership = await outcome(pageRequest("acme", person.cookie), "acme");

			expect(membership).toMatchObject({
				organisation: { id: organisation.id, name: "Acme", slug: "acme" },
				role,
				user: { id: person.userId, email: "ada@example.com" },
			});
		},
	);

	it("returns the owner of an organisation made through the Worker", async () => {
		const { ada, acme } = await twoOrganisations();

		const membership = await outcome(pageRequest("acme", ada.cookie), "acme");

		expect(membership).toMatchObject({
			organisation: { id: acme.id, slug: "acme" },
			role: "owner",
		});
	});

	it("says the same 'not found' for somebody else's organisation as for one that does not exist", async () => {
		const { ada } = await twoOrganisations();

		const someoneElses = await outcome(pageRequest("globex", ada.cookie), "globex");
		const nobodys = await outcome(pageRequest("initech", ada.cookie), "initech");

		expect(someoneElses).toMatchObject(NOT_FOUND);
		expect(someoneElses).toEqual(nobodys);
	});

	it("looks nothing up for a request without a session, whether or not the organisation exists", async () => {
		await twoOrganisations();

		expect(await outcome(pageRequest("acme"), "acme")).toBe("signed out");
		expect(await outcome(pageRequest("initech"), "initech")).toBe("signed out");
	});

	it("matches the slug exactly", async () => {
		const { ada } = await twoOrganisations();

		for (const slug of ["ACME", "acme ", "acm", "a_me", "acm%", "%", ""]) {
			expect(await outcome(pageRequest("acme", ada.cookie), slug), slug).toMatchObject(NOT_FOUND);
		}
	});

	it("stops answering on the next request after the person leaves or is removed", async () => {
		const { ada, acme } = await twoOrganisations();
		const grace = await signInAs(mailbox, acme.id, "admin", "heidi@example.com");
		const request = () => pageRequest("acme", grace.cookie);
		const before = await outcome(request(), "acme");

		const removed = await post(
			"/organization/remove-member",
			{ organizationId: acme.id, memberIdOrEmail: grace.memberId },
			{ cookie: ada.cookie },
		);

		expect(before).toMatchObject({ role: "admin" });
		expect(removed.status).toBe(200);
		expect(await outcome(request(), "acme")).toMatchObject(NOT_FOUND);
	});

	it("reads the role from the database on every request", async () => {
		const { ada, acme } = await twoOrganisations();
		const heidi = await signInAs(mailbox, acme.id, "member", "heidi@example.com");

		const promoted = await post(
			"/organization/update-member-role",
			{ organizationId: acme.id, memberId: heidi.memberId, role: "admin" },
			{ cookie: ada.cookie },
		);

		expect(promoted.status).toBe(200);
		expect(await outcome(pageRequest("acme", heidi.cookie), "acme")).toMatchObject({
			role: "admin",
		});
	});

	it("grants nothing for a stored role the application does not know", async () => {
		const { ada, grace, acme } = await twoOrganisations();
		// The database keeps an organisation's last owner (migrations/0004), so
		// Acme gets another before Ada's role is overwritten.
		await seedMembership(acme.id, grace.user.id, "owner");
		await env.DB.prepare("update memberships set role = 'superuser' where user_id = ?")
			.bind(ada.user.id)
			.run();

		expect(await outcome(pageRequest("acme", ada.cookie), "acme")).toMatchObject(NOT_FOUND);
	});

	it("does not answer for a host that is not ours", async () => {
		const { ada } = await twoOrganisations();

		const elsewhere = pageRequest("acme", ada.cookie, "https://timesifier.example.evil.example");

		expect(await outcome(elsewhere, "acme")).toBe("signed out");
	});
});
