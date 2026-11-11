import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEmail, get, type Mailbox, post, signIn } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { answer, createOrganisation, row, value } from "./harness";

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

const organisations = () => value("select count(*) from organisations");

describe("creating an organisation", () => {
	it("makes the signed-in person its only member, with the role owner", async () => {
		const ada = await signIn(mailbox, "ada@example.com");

		const response = await post(
			"/organization/create",
			{ name: "Acme Corp" },
			{ cookie: ada.cookie },
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ name: "Acme Corp", slug: "acme-corp" });
		const organisation = await row("select * from organisations");
		const { results: members } = await env.DB.prepare("select * from memberships").all();
		expect(members).toEqual([
			expect.objectContaining({
				organisation_id: organisation?.id,
				user_id: ada.user.id,
				role: "owner",
			}),
		]);
	});

	it("shows the organisation to its owner and to nobody else", async () => {
		const ada = await signIn(mailbox, "ada@example.com");
		const grace = await signIn(mailbox, "grace@example.com");
		await createOrganisation(ada.cookie, "Acme Corp");

		const adas = await get("/organization/list", { cookie: ada.cookie });
		const graces = await get("/organization/list", { cookie: grace.cookie });

		expect(await adas.json()).toEqual([expect.objectContaining({ slug: "acme-corp" })]);
		expect(await graces.json()).toEqual([]);
	});

	it("is refused without a session, and creates nothing", async () => {
		const response = await post("/organization/create", { name: "Acme Corp" });

		expect(response.status).toBe(401);
		expect(await organisations()).toBe(0);
	});

	it("is refused to a person whose email address is not verified", async () => {
		// No way of signing in leaves an address unverified: the emailed code
		// verifies it, and a passkey belongs to an account that already has. The
		// rule is shown by taking the mark away from a signed-in person.
		const ada = await signIn(mailbox, "ada@example.com");
		await env.DB.prepare("update users set email_verified = 0").run();

		const response = await post(
			"/organization/create",
			{ name: "Acme Corp" },
			{ cookie: ada.cookie },
		);

		expect(response.status).toBe(403);
		expect(await organisations()).toBe(0);
	});

	it.each([
		["no name", {}],
		["an empty name", { name: "" }],
		["a name of spaces", { name: "   " }],
		["a name of 81 characters", { name: "a".repeat(81) }],
		["a name with a line break", { name: "Acme\nBcc: eve@example.com" }],
		["a name that is not text", { name: 7 }],
		["a slug of the caller's choosing", { name: "Acme", slug: "settings" }],
		["another person as the creator", { name: "Acme", userId: "someone-else" }],
		["a logo", { name: "Acme", logo: "https://example.com/logo.png" }],
		["metadata", { name: "Acme", metadata: { plan: "enterprise" } }],
	])("refuses %s with 400, and creates nothing", async (_what, body) => {
		const ada = await signIn(mailbox, "ada@example.com");

		const response = await post("/organization/create", body, { cookie: ada.cookie });

		expect(response.status).toBe(400);
		expect(await organisations()).toBe(0);
	});

	it("keeps the name without the spaces around it", async () => {
		const ada = await signIn(mailbox, "ada@example.com");

		const created = await createOrganisation(ada.cookie, "  Acme Corp  ");

		expect(created.name).toBe("Acme Corp");
	});
});

describe("an organisation's slug", () => {
	it.each([
		["Acme Corp", "acme-corp"],
		["Smith & Sons, Ltd.", "smith-sons-ltd"],
		["Café Zoë", "cafe-zoe"],
		["QA", "qa-org"],
		["日本語", "organisation"],
		[
			"one two three four five six seven eight nine ten eleven",
			"one-two-three-four-five-six-seven-eight",
		],
	])("is derived from the name on the server: %j gets %j", async (name, slug) => {
		const ada = await signIn(mailbox, "ada@example.com");

		const created = await createOrganisation(ada.cookie, name);

		expect(created.slug).toBe(slug);
		expect(await value("select slug from organisations")).toBe(slug);
	});

	it.each([
		["New", "new-2"],
		["Settings", "settings-2"],
		["API", "api-2"],
		["Auth", "auth-2"],
		["App", "app-2"],
		["Admin", "admin-2"],
		["WWW", "www-2"],
		["Invitations", "invitations-2"],
		["Sign in", "sign-in-2"],
		["Sign up", "sign-up-2"],
	])("is never a reserved word: %j gets %j", async (name, slug) => {
		const ada = await signIn(mailbox, "ada@example.com");

		const created = await createOrganisation(ada.cookie, name);

		expect(created.slug).toBe(slug);
	});

	it("gets a number when another organisation has it, whoever owns that one", async () => {
		const ada = await signIn(mailbox, "ada@example.com");
		const grace = await signIn(mailbox, "grace@example.com");

		const slugs = [
			(await createOrganisation(ada.cookie, "Acme")).slug,
			(await createOrganisation(grace.cookie, "Acme")).slug,
			(await createOrganisation(ada.cookie, "ACME!")).slug,
			(await createOrganisation(grace.cookie, "Acme 2")).slug,
		];

		expect(slugs).toEqual(["acme", "acme-2", "acme-3", "acme-2-2"]);
		expect(await organisations()).toBe(4);
	});

	it("does not change when the organisation is renamed", async () => {
		const ada = await signIn(mailbox, "ada@example.com");
		const { id } = await createOrganisation(ada.cookie, "Acme");

		const renamed = await post(
			"/organization/update",
			{ organizationId: id, data: { name: "Globex" } },
			{ cookie: ada.cookie },
		);

		expect(renamed.status).toBe(200);
		expect(await row("select name, slug from organisations")).toEqual({
			name: "Globex",
			slug: "acme",
		});
	});

	it("cannot be set by a request that renames the organisation", async () => {
		const ada = await signIn(mailbox, "ada@example.com");
		const { id } = await createOrganisation(ada.cookie, "Acme");

		const response = await post(
			"/organization/update",
			{ organizationId: id, data: { name: "Globex", slug: "globex" } },
			{ cookie: ada.cookie },
		);

		expect(response.status).toBe(400);
		expect(await row("select name, slug from organisations")).toEqual({
			name: "Acme",
			slug: "acme",
		});
	});
});

describe("the organisation of a request", () => {
	it("is never taken from the session: a request that names none is refused", async () => {
		const ada = await signIn(mailbox, "ada@example.com");
		// Better Auth notes the new organisation on the session as the "active"
		// one, and its endpoints would fall back to it.
		await createOrganisation(ada.cookie, "Acme");

		const invited = await post(
			"/organization/invite-member",
			{ email: "grace@example.com", role: "member" },
			{ cookie: ada.cookie },
		);
		const renamed = await post(
			"/organization/update",
			{ data: { name: "Globex" } },
			{ cookie: ada.cookie },
		);
		const seen = await get("/organization/get-full-organization", { cookie: ada.cookie });

		expect([invited.status, renamed.status, seen.status]).toEqual([400, 400, 400]);
		expect(await value("select count(*) from invitations")).toBe(0);
		expect(await value("select name from organisations")).toBe("Acme");
	});

	it.each([
		["POST", "/organization/set-active", { organizationId: "any" }],
		["POST", "/organization/check-slug", { slug: "acme" }],
		["POST", "/organization/has-permission", { permissions: { organization: ["delete"] } }],
		["GET", "/organization/get-active-member", null],
		["GET", "/organization/get-active-member-role", null],
		["GET", "/organization/get-organization?organizationSlug=acme", null],
	] as const)(
		"answers 404 for an endpoint the application does not use: %s %s",
		async (method, path, body) => {
			const ada = await signIn(mailbox, "ada@example.com");
			await createOrganisation(ada.cookie, "Acme");

			const response =
				method === "GET"
					? await get(path, { cookie: ada.cookie })
					: await post(path, body, { cookie: ada.cookie });

			expect(response.status).toBe(404);
		},
	);

	it("cannot be found by its slug through an endpoint", async () => {
		const ada = await signIn(mailbox, "ada@example.com");
		const grace = await signIn(mailbox, "grace@example.com");
		await createOrganisation(ada.cookie, "Acme");

		const taken = await answer(
			await get("/organization/get-full-organization?organizationSlug=acme", {
				cookie: grace.cookie,
			}),
		);
		const free = await answer(
			await get("/organization/get-full-organization?organizationSlug=nobody", {
				cookie: grace.cookie,
			}),
		);

		expect(taken.status).toBe(400);
		expect(taken).toEqual(free);
	});
});
