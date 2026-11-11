import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEmail, type Mailbox, post } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, row, value } from "../organisations/harness";
import { open, openData, pageBody, person, submit, textOf } from "./harness";

// `/app`, where a signed-in person goes when no organisation is named, and
// `/app/new`, which creates one. Criterion 1 of card TS-009: a signed-in
// person can create an organisation and becomes its owner.

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("/app", () => {
	it("sends a person with no organisation to create one", async () => {
		const ada = await person(mailbox, "ada@example.com");

		const response = await open("/app", ada);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/app/new");
	});

	it("sends a person with one organisation to it", async () => {
		const ada = await person(mailbox, "ada@example.com");
		await createOrganisation(ada.cookie, "Acme");

		const response = await open("/app", ada);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/app/acme");
	});

	it("shows a person with several a link to each, and a way to create another", async () => {
		const ada = await person(mailbox, "ada@example.com");
		await createOrganisation(ada.cookie, "Acme");
		await createOrganisation(ada.cookie, "Globex & Sons");

		const response = await open("/app", ada);
		expect(response.status).toBe(200);
		const html = await pageBody(response);
		expect(textOf(html)).toContain("Your organisations");
		expect(html).toMatch(/<a[^>]*href="\/app\/acme"[^>]*>Acme<\/a>/);
		expect(html).toMatch(/<a[^>]*href="\/app\/globex-sons"[^>]*>Globex &amp; Sons<\/a>/);
		expect(html).toMatch(/<a[^>]*href="\/app\/new"[^>]*>Create an organisation<\/a>/);
	});

	it("lists only the organisations the person belongs to", async () => {
		const ada = await person(mailbox, "ada@example.com");
		await createOrganisation(ada.cookie, "Acme");
		await createOrganisation(ada.cookie, "Globex");
		const grace = await person(mailbox, "grace@example.com");
		await createOrganisation(grace.cookie, "Initech");

		const text = textOf(await pageBody(await open("/app", ada)));
		expect(text).toContain("Acme");
		expect(text).toContain("Globex");
		expect(text).not.toContain("Initech");
	});

	it("decides the same way for the data request a move between pages makes", async () => {
		const ada = await person(mailbox, "ada@example.com");

		const response = await openData("/app", ada);
		expect(response.status).toBe(202);
		expect(await response.text()).toContain('"/app/new"');
	});
});

describe("/app/new", () => {
	it("asks a person with no organisation for its name, and nothing else", async () => {
		const ada = await person(mailbox, "ada@example.com");

		const response = await open("/app/new", ada);
		expect(response.status).toBe(200);
		const html = await pageBody(response);
		expect(textOf(html)).toContain("Create your organisation");
		expect(html.match(/<input\b[^>]*>/g)).toHaveLength(1);
		expect(html).toMatch(/<input[^>]*name="name"/);
		expect(html.match(/<button[^>]*type="submit"/g)).toHaveLength(1);
	});

	it("creates the organisation, makes the person its owner and goes to its Today", async () => {
		const ada = await person(mailbox, "ada@example.com");

		const response = await submit("/app/new", { name: "  Acme Ltd  " }, ada);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/app/acme-ltd?welcome=1");
		expect(await row("select name, slug from organisations")).toEqual({
			name: "Acme Ltd",
			slug: "acme-ltd",
		});
		expect(
			await row(
				"select user_id, role from memberships where organisation_id = (select id from organisations)",
			),
		).toEqual({ user_id: ada.user.id, role: "owner" });
		expect((await open("/app/acme-ltd", ada)).status).toBe(200);
	});

	it("welcomes the person to the first organisation they create, and to no other", async () => {
		const ada = await person(mailbox, "ada@example.com");

		const first = await submit("/app/new", { name: "Acme" }, ada);
		expect(first.headers.get("Location")).toBe("/app/acme?welcome=1");
		const welcomed = textOf(await pageBody(await open("/app/acme?welcome=1", ada)));
		expect(welcomed).toContain("Acme is ready");
		// The welcome is for the moment of creating: the page without the mark has none.
		expect(textOf(await pageBody(await open("/app/acme", ada)))).not.toContain("is ready");

		const second = await submit("/app/new", { name: "Globex" }, ada);
		expect(second.headers.get("Location")).toBe("/app/globex");
		expect(textOf(await pageBody(await open("/app/new", ada)))).toContain("Create an organisation");
	});

	it("gives a second organisation of the same name an address of its own", async () => {
		const ada = await person(mailbox, "ada@example.com");
		const grace = await person(mailbox, "grace@example.com");

		await submit("/app/new", { name: "Acme" }, ada);
		const response = await submit("/app/new", { name: "Acme" }, grace);

		expect(response.headers.get("Location")).toBe("/app/acme-2?welcome=1");
		expect((await open("/app/acme-2", grace)).status).toBe(200);
		expect((await open("/app/acme", grace)).status).toBe(404);
	});

	it("takes the name alone: a slug or an owner in the form changes nothing", async () => {
		const ada = await person(mailbox, "ada@example.com");

		const response = await submit(
			"/app/new",
			{ name: "Acme", slug: "admin", userId: "someone-else", role: "member" },
			ada,
		);

		expect(response.headers.get("Location")).toBe("/app/acme?welcome=1");
		expect(await value("select role from memberships where user_id = ?", ada.user.id)).toBe(
			"owner",
		);
	});

	it.each([
		["nothing", ""],
		["spaces alone", "   "],
		["81 characters", "a".repeat(81)],
		["a line break", "Acme\nLtd"],
		["a character that reverses the text", "Acme \u202E dtL"],
	])("refuses a name that is %s with 400 and creates nothing", async (_case, name) => {
		const ada = await person(mailbox, "ada@example.com");

		const response = await submit("/app/new", { name }, ada);

		expect(response.status).toBe(400);
		expect(await value("select count(*) from organisations")).toBe(0);
	});

	it("refuses a sixth organisation for one owner, and says what the limit is", async () => {
		const ada = await person(mailbox, "ada@example.com");
		for (let n = 1; n <= 5; n++) {
			expect((await post("/organization/create", { name: `Acme ${n}` }, ada)).status).toBe(200);
		}

		const response = await submit("/app/new", { name: "Acme 6" }, ada, { byScript: true });

		expect(response.status).toBe(403);
		expect(await response.text()).toContain("You have reached the limit of 5 organisations.");
		expect(await value("select count(*) from organisations")).toBe(5);
	});

	it("says so in a sentence when the server answers too many attempts", async () => {
		const ada = await person(mailbox, "ada@example.com");
		// The limit on creating is ten requests a minute for one client, whatever
		// their answer. These ten are refused for their input and create nothing.
		for (let n = 1; n <= 10; n++) {
			expect((await post("/organization/create", {}, ada)).status).toBe(400);
		}

		const response = await submit("/app/new", { name: "One too many" }, ada, { byScript: true });

		expect(response.status).toBe(429);
		expect(await response.text()).toContain("Too many attempts. Try again in a minute.");
		expect(await value("select count(*) from organisations")).toBe(0);
	});
});
