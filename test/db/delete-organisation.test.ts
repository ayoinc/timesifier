import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEmail, type Mailbox, post, signIn } from "../auth/harness";
import { createOrganisation, seedMember, value } from "../organisations/harness";
import { freshDatabase } from "./database";

// Deleting an organisation deletes its row, and its memberships and
// invitations go with it through their foreign keys
// (app/auth/organisations.server.ts, `beforeDeleteOrganization`). The order
// matters: the database refuses to take the last owner from an organisation
// that is still there (./last-owner.test.ts).

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("deleting an organisation through the server", () => {
	it("an owner deletes their organisation: it goes with its memberships and invitations", async () => {
		const ada = await signIn(mailbox, "ada@example.com");
		const organisation = await createOrganisation(ada.cookie, "Acme");
		await seedMember(organisation.id, "owner", "grace@example.com");
		await seedMember(organisation.id, "member", "linus@example.com");
		const invited = await post(
			"/organization/invite-member",
			{ organizationId: organisation.id, email: "hedy@example.com", role: "member" },
			{ cookie: ada.cookie },
		);
		expect(invited.status).toBe(200);

		const response = await post(
			"/organization/delete",
			{ organizationId: organisation.id },
			{ cookie: ada.cookie },
		);

		expect(response.status).toBe(200);
		expect(await value("select count(*) from organisations")).toBe(0);
		expect(await value("select count(*) from memberships")).toBe(0);
		expect(await value("select count(*) from invitations")).toBe(0);
		// The people are not the organisation's to delete.
		expect(await value("select count(*) from users")).toBe(3);
	});

	it("a member who may not delete it leaves it whole", async () => {
		const ada = await signIn(mailbox, "ada@example.com");
		const organisation = await createOrganisation(ada.cookie, "Acme");
		const linus = await signIn(mailbox, "linus@example.com");
		await env.DB.prepare(
			"insert into memberships (id, organisation_id, user_id, role, created_at, updated_at) values ('m-linus', ?, ?, 'admin', 0, 0)",
		)
			.bind(organisation.id, linus.user.id)
			.run();

		const response = await post(
			"/organization/delete",
			{ organizationId: organisation.id },
			{ cookie: linus.cookie },
		);

		expect(response.status).toBe(403);
		expect(await value("select count(*) from organisations")).toBe(1);
		expect(await value("select count(*) from memberships")).toBe(2);
	});
});
