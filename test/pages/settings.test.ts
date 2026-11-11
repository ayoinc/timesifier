import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEmail, type Mailbox, post } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	type Role,
	row,
	seedMembership,
	value,
} from "../organisations/harness";
import { open, type Person, pageBody, person, submit, textOf } from "./harness";

// Settings of an organisation, /app/<slug>/settings: the organisation's name
// and its deletion, which the server allows by role, and the person's own
// name. Every form is posted the way the page posts it.

const SETTINGS = "/app/acme/settings";

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

/** A person who signs in and holds `role` in Acme. */
async function memberOfAcme(role: Role, email: string): Promise<Person> {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, role);
	return who;
}

/** What an action answered a form sent by script: its status and what it said. */
async function outcome(response: Response) {
	return { status: response.status, said: await response.text() };
}

const organisationName = () =>
	value<string>("select name from organisations where id = ?", acme.id);

describe("what the page shows", () => {
	it("to an owner: the name, Rename, the members, and Delete organisation", async () => {
		const html = await pageBody(await open(SETTINGS, ada));
		const text = textOf(html);

		expect(text).toContain("Shared by everyone in Acme. You are an owner.");
		expect(html).toMatch(/<button[^>]*>Rename<\/button>/);
		expect(html).toMatch(
			/<a[^>]*href="\/app\/acme\/settings\/members"[^>]*>Members and invitations<\/a>/,
		);
		expect(html).toMatch(/<button[^>]*>Delete organisation<\/button>/);
	});

	it("to an admin: Rename, and no way to delete", async () => {
		const html = await pageBody(
			await open(SETTINGS, await memberOfAcme("admin", "grace@example.com")),
		);

		expect(textOf(html)).toContain("You are an admin.");
		expect(html).toMatch(/<button[^>]*>Rename<\/button>/);
		expect(textOf(html)).not.toContain("Delete organisation");
	});

	it("to a member: the name, and neither control", async () => {
		const html = await pageBody(
			await open(SETTINGS, await memberOfAcme("member", "linus@example.com")),
		);
		const text = textOf(html);

		expect(text).toContain("Shared by everyone in Acme. You are a member.");
		expect(html).not.toMatch(/<button[^>]*>Rename<\/button>/);
		expect(text).not.toContain("Delete organisation");
		expect(text).toContain("Members and invitations");
	});

	it("says which settings are the organisation's and which are the person's own", async () => {
		const html = await pageBody(await open(SETTINGS, ada));

		const organisation = html.indexOf(">Organisation</h2>");
		const account = html.indexOf(">Your account</h2>");
		expect(organisation).toBeGreaterThan(-1);
		expect(account).toBeGreaterThan(organisation);
		// The colour scheme and both ways out are under the person's heading.
		for (const heading of ["Appearance", "Sign out", "Sign out everywhere"]) {
			expect(html.indexOf(`>${heading}</h3>`), heading).toBeGreaterThan(account);
		}
		expect(html.indexOf(">Delete organisation</h3>")).toBeLessThan(account);
	});

	it("shows the person by their address until they have given a name", async () => {
		expect(textOf(await pageBody(await open(SETTINGS, ada)))).toContain(
			"Not set. People see your address, ada@example.com.",
		);
	});
});

describe("renaming the organisation", () => {
	it.each(["owner", "admin"] as const)("an %s renames it, and its address stays", async (role) => {
		const who = role === "owner" ? ada : await memberOfAcme(role, "grace@example.com");

		const response = await outcome(
			await submit(SETTINGS, { intent: "rename", name: "  Acme Ltd " }, who, { byScript: true }),
		);

		expect(response.status).toBe(200);
		expect(response.said).toContain("The organisation is now called Acme Ltd.");
		expect(await row("select name, slug from organisations")).toEqual({
			name: "Acme Ltd",
			slug: "acme",
		});
		expect(textOf(await pageBody(await open(SETTINGS, who)))).toContain(
			"Shared by everyone in Acme Ltd.",
		);
	});

	it("a member who posts the form the page does not show them is refused by the server", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");

		const response = await outcome(
			await submit(SETTINGS, { intent: "rename", name: "Linus Ltd" }, linus, { byScript: true }),
		);

		expect(response.status).toBe(403);
		expect(response.said).toContain("Your role in this organisation does not allow that.");
		expect(await organisationName()).toBe("Acme");
	});

	it("renames the organisation in the address, whatever the form names", async () => {
		const grace = await person(mailbox, "grace@example.com");
		const initech = await createOrganisation(grace.cookie, "Initech");

		const response = await submit(
			SETTINGS,
			{ intent: "rename", name: "Mine now", organizationId: initech.id, slug: "initech" },
			ada,
			{ byScript: true },
		);

		expect(response.status).toBe(200);
		expect(await organisationName()).toBe("Mine now");
		expect(await value("select name from organisations where id = ?", initech.id)).toBe("Initech");
	});
});

describe("deleting the organisation", () => {
	it("an owner who types its name deletes it, and is sent to /app", async () => {
		const response = await submit(SETTINGS, { intent: "delete", confirmation: "Acme" }, ada);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/app");
		expect(await value("select count(*) from organisations")).toBe(0);
		expect(await value("select count(*) from memberships")).toBe(0);
		expect((await open(SETTINGS, ada)).status).toBe(404);
		// With no organisation left, /app sends them to create one.
		expect((await open("/app", ada)).headers.get("Location")).toBe("/app/new");
	});

	it.each([
		["nothing", ""],
		["another name", "Globex"],
		["the name in other letters", "acme"],
		["part of the name", "Acm"],
	])("typing %s deletes nothing and says why", async (_case, confirmation) => {
		const response = await outcome(
			await submit(SETTINGS, { intent: "delete", confirmation }, ada, { byScript: true }),
		);

		expect(response.status).toBe(400);
		expect(response.said).toContain("That is not the organisation's name.");
		expect(await value("select count(*) from organisations")).toBe(1);
	});

	it.each(["admin", "member"] as const)(
		"an %s who types its name is refused by the server",
		async (role) => {
			const who = await memberOfAcme(role, "grace@example.com");

			const response = await outcome(
				await submit(SETTINGS, { intent: "delete", confirmation: "Acme" }, who, { byScript: true }),
			);

			expect(response.status).toBe(403);
			expect(response.said).toContain("Your role in this organisation does not allow that.");
			expect(await value("select count(*) from organisations")).toBe(1);
			expect(await value("select count(*) from memberships")).toBe(2);
		},
	);
});

describe("a person's name", () => {
	/** Everything the database holds about Ada. */
	const stored = () => row("select * from users where id = ?", ada.user.id);

	it("is changed by the action, trimmed, and shown in Settings", async () => {
		const response = await outcome(
			await submit(SETTINGS, { intent: "name", name: "  Ada Lovelace " }, ada, { byScript: true }),
		);

		expect(response.status).toBe(200);
		expect(response.said).toContain("Your name is now Ada Lovelace.");
		expect((await stored())?.name).toBe("Ada Lovelace");
		const text = textOf(await pageBody(await open(SETTINGS, ada)));
		expect(text).toContain("Ada Lovelace");
		expect(text).not.toContain("Not set.");
	});

	it("changes the name and nothing else, whatever the form holds", async () => {
		const before = await stored();
		const sessions = await value("select count(*) from sessions where user_id = ?", ada.user.id);

		const response = await submit(
			SETTINGS,
			{
				intent: "name",
				name: "Ada",
				email: "mallory@example.com",
				emailVerified: "false",
				email_verified: "0",
				image: "https://attacker.example/a.png",
				id: "someone-else",
				role: "owner",
				createdAt: "0",
			},
			ada,
			{ byScript: true },
		);

		expect(response.status).toBe(200);
		const { updated_at: _then, ...unchanged } = before ?? {};
		const { updated_at: _now, ...after } = (await stored()) ?? {};
		expect(after).toEqual({ ...unchanged, name: "Ada" });
		expect(await value("select id from users where email = ?", "ada@example.com")).toBe(
			ada.user.id,
		);
		expect(await value("select count(*) from users")).toBe(1);
		expect(await value("select count(*) from sessions where user_id = ?", ada.user.id)).toBe(
			sessions,
		);
	});

	it("is the only way to change it: the mount does not offer the endpoint that changes a person", async () => {
		const response = await post("/update-user", { name: "Mallory", image: "x" }, ada);

		expect(response.status).toBe(404);
		expect((await stored())?.name).toBe("");
	});

	it("changes the name of the person signed in, and of nobody else", async () => {
		const grace = await memberOfAcme("admin", "grace@example.com");

		await submit(SETTINGS, { intent: "name", name: "Grace Hopper" }, grace, { byScript: true });

		expect(await value("select name from users where id = ?", grace.user.id)).toBe("Grace Hopper");
		expect((await stored())?.name).toBe("");
	});

	it.each([
		["nothing", ""],
		["spaces alone", "   "],
		["101 characters", "a".repeat(101)],
		["a line break", "Ada\nLovelace"],
		["a character that reverses the text", "Ada \u202E ecalevoL"],
	])("refuses a name that is %s with 400 and changes nothing", async (_case, name) => {
		const response = await submit(SETTINGS, { intent: "name", name }, ada, { byScript: true });

		expect(response.status).toBe(400);
		expect((await stored())?.name).toBe("");
	});

	it("takes a name of exactly 100 characters", async () => {
		const name = "a".repeat(100);

		const response = await submit(SETTINGS, { intent: "name", name }, ada, { byScript: true });

		expect(response.status).toBe(200);
		expect((await stored())?.name).toBe(name);
	});

	it("keeps the session working after the change", async () => {
		await submit(SETTINGS, { intent: "name", name: "Ada" }, ada, { byScript: true });

		const page = await open(SETTINGS, ada);
		expect(page.status).toBe(200);
		expect(textOf(await pageBody(page))).toContain("You are signed in as ada@example.com");
	});
});

describe("the colour scheme, which Settings had before it had an organisation", () => {
	it("is still stored by the form the page posts", async () => {
		const response = await submit(SETTINGS, { scheme: "dark" }, ada);

		expect(response.status).toBe(303);
		expect(response.headers.get("Location")).toBe(SETTINGS);
		expect(response.headers.getSetCookie()).toEqual([
			"__Host-color-scheme=dark; Max-Age=31536000; Path=/; Secure; SameSite=Lax",
		]);
	});
});
