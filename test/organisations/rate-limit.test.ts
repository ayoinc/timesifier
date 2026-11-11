import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEmail, type Mailbox, post, signIn } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, value } from "./harness";

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function statusesOf(count: number, attempt: (n: number) => Promise<Response>) {
	const statuses: number[] = [];
	// One after another, as a person or a script retrying would send them.
	for (let n = 0; n < count; n++) statuses.push((await attempt(n)).status);
	return statuses;
}

describe("the rate limit on organisations", () => {
	it("answers the 11th organisation a client creates in a minute with 429, and creates ten", async () => {
		// Two people at one address, because one person may own five.
		const ada = await signIn(mailbox, "ada@example.com");
		const grace = await signIn(mailbox, "grace@example.com");

		const statuses = await statusesOf(11, (n) =>
			post(
				"/organization/create",
				{ name: `Acme ${n}` },
				{ cookie: n % 2 ? grace.cookie : ada.cookie },
			),
		);

		expect(statuses).toEqual([...Array(10).fill(200), 429]);
		expect(await value("select count(*) from organisations")).toBe(10);
	});

	it("answers the 11th invitation a client sends in a minute with 429, and sends ten", async () => {
		const ada = await signIn(mailbox, "ada@example.com");
		const { id: organizationId } = await createOrganisation(ada.cookie, "Acme");

		const statuses = await statusesOf(11, (n) =>
			post(
				"/organization/invite-member",
				{ organizationId, email: `person${n}@example.com`, role: "member" },
				{ cookie: ada.cookie },
			),
		);

		expect(statuses).toEqual([...Array(10).fill(200), 429]);
		expect(await value("select count(*) from invitations")).toBe(10);
		await vi.waitFor(() =>
			expect(mailbox.sent().filter(({ text }) => text.includes("/invitations/"))).toHaveLength(10),
		);
	});

	it("counts each client on its own, and counts refused requests too", async () => {
		const ada = await signIn(mailbox, "ada@example.com");
		// Nothing here is a valid request: the limit is on asking, not on succeeding.
		const attempt = (client: string) =>
			post("/organization/create", { name: "" }, { cookie: ada.cookie, client });

		const statuses = await statusesOf(11, () => attempt("203.0.113.7"));

		expect(statuses).toEqual([...Array(10).fill(400), 429]);
		expect((await attempt("203.0.113.8")).status).toBe(400);
	});
});
