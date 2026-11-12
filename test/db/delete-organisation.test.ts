import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { receiptKey, receiptPrefix } from "~/expenses/receipts.server";
import { captureEmail, type Mailbox, post, setBinding, signIn } from "../auth/harness";
import { createOrganisation, seedMember, value } from "../organisations/harness";
import { freshDatabase } from "./database";

// Deleting an organisation deletes its row, and its memberships, invitations
// and every other table of it go with it through their foreign keys
// (app/auth/organisations.server.ts, `beforeDeleteOrganization`). The order
// matters: the database refuses to take the last owner from an organisation
// that is still there (./last-owner.test.ts). Its receipts in R2, which no
// foreign key reaches, are deleted first, and a failure there keeps it whole.

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

	it("its receipts in R2 go with it, and another organisation's stay", async () => {
		const ada = await signIn(mailbox, "ada@example.com");
		const acme = await createOrganisation(ada.cookie, "Acme");
		const other = await createOrganisation(ada.cookie, "Other");
		const ours = [receiptKey(acme.id, "expense-1"), receiptKey(acme.id, "expense-2")];
		const theirs = receiptKey(other.id, "expense-3");
		for (const key of [...ours, theirs]) await env.RECEIPTS.put(key, new Uint8Array([1, 2, 3]));

		// One key a page, so that the deletion follows R2's cursor from page to page.
		const bucket = env.RECEIPTS;
		setBinding("RECEIPTS", {
			list: (options: R2ListOptions) => bucket.list({ ...options, limit: 1 }),
			delete: (keys: string | string[]) => bucket.delete(keys),
		});
		const response = await post(
			"/organization/delete",
			{ organizationId: acme.id },
			{ cookie: ada.cookie },
		);

		expect(response.status).toBe(200);
		expect((await bucket.list({ prefix: receiptPrefix(acme.id) })).objects).toEqual([]);
		expect(await bucket.head(theirs)).not.toBeNull();
		expect(await value("select count(*) from organisations")).toBe(1);
	});

	it("is refused, and leaves the organisation in place, when a receipt cannot be deleted; asking again finishes it", async () => {
		const ada = await signIn(mailbox, "ada@example.com");
		const acme = await createOrganisation(ada.cookie, "Acme");
		await env.RECEIPTS.put(receiptKey(acme.id, "expense-1"), new Uint8Array([1]));
		const bucket = env.RECEIPTS;
		setBinding("RECEIPTS", {
			list: (options: R2ListOptions) => bucket.list(options),
			delete: () => Promise.reject(new Error("R2 is unavailable")),
		});
		vi.spyOn(console, "error").mockImplementation(() => {});

		const refused = await post(
			"/organization/delete",
			{ organizationId: acme.id },
			{ cookie: ada.cookie },
		);
		expect(refused.status).toBe(503);
		expect(await refused.json()).toMatchObject({ code: "RECEIPTS_NOT_DELETED" });
		expect(await value("select count(*) from organisations")).toBe(1);
		expect(await value("select count(*) from memberships")).toBe(1);

		setBinding("RECEIPTS", bucket);
		const retried = await post(
			"/organization/delete",
			{ organizationId: acme.id },
			{ cookie: ada.cookie },
		);
		expect(retried.status).toBe(200);
		expect((await bucket.list({ prefix: receiptPrefix(acme.id) })).objects).toEqual([]);
		expect(await value("select count(*) from organisations")).toBe(0);
	});
});
