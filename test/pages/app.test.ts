import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DPA_VERSION } from "~/landing/trust";
import { captureEmail, type Mailbox, post } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	ACCEPTED,
	createOrganisation,
	NEW_ORGANISATION,
	row,
	value,
} from "../organisations/harness";
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
	it("names its way back for where it goes: the one organisation, or the list of several (W31)", async () => {
		const ada = await person(mailbox, "ada@example.com");
		await createOrganisation(ada.cookie, "Acme");
		const one = await pageBody(await open("/app/new", ada));
		expect(one).toMatch(/<a[^>]*href="\/app\/acme"[^>]*>Back to Acme<\/a>/);

		await createOrganisation(ada.cookie, "Globex");
		const two = await pageBody(await open("/app/new", ada));
		expect(two).toMatch(/<a[^>]*href="\/app"[^>]*>Back to your organisations<\/a>/);
	});

	it("asks a person with no organisation for its name and how it works, and nothing else: creating it accepts the terms and the agreement", async () => {
		const ada = await person(mailbox, "ada@example.com");

		const response = await open("/app/new", ada);
		expect(response.status).toBe(200);
		const html = await pageBody(response);
		expect(textOf(html)).toContain("Create your organisation");
		expect(html.match(/<input\b(?![^>]*type="hidden")[^>]*>/g)).toHaveLength(4);
		expect(html).toMatch(/<input[^>]*name="name"/);
		// How you work (TS-115a): one choice of three, Client projects chosen to start with.
		const choices = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
		expect(choices.map((input) => input.match(/value="([^"]+)"/)?.[1])).toEqual([
			"client_projects",
			"internal",
			"both",
		]);
		expect(choices.every((input) => input.includes('name="workModel"'))).toBe(true);
		expect(choices[0]).toMatch(/checked/);
		expect(textOf(html)).toContain("How you work");
		// The version the page shows is the one the person accepts (TS-105).
		expect(html).toMatch(
			new RegExp(`<input[^>]*type="hidden"[^>]*name="dpaVersion"[^>]*value="${DPA_VERSION.date}"`),
		);
		expect(textOf(html)).toContain(
			"By creating it you accept the terms and the data processing agreement for it.",
		);
		expect(html).toMatch(/<a[^>]*href="\/terms"[^>]*>terms<\/a>/);
		expect(html).toMatch(/<a[^>]*href="\/dpa"[^>]*>data processing agreement<\/a>/);
		expect(html.match(/<button[^>]*type="submit"/g)).toHaveLength(1);
	});

	it("creates the organisation, makes the person its owner and goes to its Today", async () => {
		const ada = await person(mailbox, "ada@example.com");

		const response = await submit("/app/new", { name: "  Acme Ltd  ", ...NEW_ORGANISATION }, ada);

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

	it.each([
		["client_projects", 1],
		["internal", 0],
		["both", 1],
	] as const)("starts it working by %s, as the person chose", async (workModel, clientsEnabled) => {
		const ada = await person(mailbox, "ada@example.com");
		const response = await submit("/app/new", { name: "Acme", ...ACCEPTED, workModel }, ada);
		expect(response.status).toBe(302);
		// `clients_enabled` is written alongside, unread, until it is dropped (decision 67).
		expect(await row("select work_model, clients_enabled from organisations")).toEqual({
			work_model: workModel,
			clients_enabled: clientsEnabled,
		});
	});

	it.each([
		["no way of working", {}],
		["one it does not know", { workModel: "freelance" }],
	])("refuses %s with 400 and creates nothing", async (_case, extra) => {
		const ada = await person(mailbox, "ada@example.com");
		const response = await submit("/app/new", { name: "Acme", ...ACCEPTED, ...extra }, ada);
		expect(response.status).toBe(400);
		expect(await value("select count(*) from organisations")).toBe(0);
	});

	it("welcomes the person to the first organisation they create, and to no other", async () => {
		const ada = await person(mailbox, "ada@example.com");

		const first = await submit("/app/new", { name: "Acme", ...NEW_ORGANISATION }, ada);
		expect(first.headers.get("Location")).toBe("/app/acme?welcome=1");
		const welcomed = textOf(await pageBody(await open("/app/acme?welcome=1", ada)));
		expect(welcomed).toContain("Acme is ready");
		// The welcome is for the moment of creating: the page without the mark has none.
		expect(textOf(await pageBody(await open("/app/acme", ada)))).not.toContain("is ready");

		const second = await submit("/app/new", { name: "Globex", ...NEW_ORGANISATION }, ada);
		expect(second.headers.get("Location")).toBe("/app/globex");
		expect(textOf(await pageBody(await open("/app/new", ada)))).toContain("Create an organisation");
	});

	it("gives a second organisation of the same name an address of its own", async () => {
		const ada = await person(mailbox, "ada@example.com");
		const grace = await person(mailbox, "grace@example.com");

		await submit("/app/new", { name: "Acme", ...NEW_ORGANISATION }, ada);
		const response = await submit("/app/new", { name: "Acme", ...NEW_ORGANISATION }, grace);

		expect(response.headers.get("Location")).toBe("/app/acme-2?welcome=1");
		expect((await open("/app/acme-2", grace)).status).toBe(200);
		expect((await open("/app/acme", grace)).status).toBe(404);
	});

	it("takes the name alone: a slug or an owner in the form changes nothing", async () => {
		const ada = await person(mailbox, "ada@example.com");

		const response = await submit(
			"/app/new",
			{ name: "Acme", slug: "admin", userId: "someone-else", role: "member", ...NEW_ORGANISATION },
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

		const response = await submit("/app/new", { name, ...NEW_ORGANISATION }, ada);

		expect(response.status).toBe(400);
		expect(await value("select count(*) from organisations")).toBe(0);
	});

	it("refuses a sixth organisation for one owner, and says what the limit is", async () => {
		const ada = await person(mailbox, "ada@example.com");
		for (let n = 1; n <= 5; n++) {
			expect(
				(await post("/organization/create", { name: `Acme ${n}`, ...ACCEPTED }, ada)).status,
			).toBe(200);
		}

		const response = await submit("/app/new", { name: "Acme 6", ...NEW_ORGANISATION }, ada, {
			byScript: true,
		});

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

		const response = await submit("/app/new", { name: "One too many", ...NEW_ORGANISATION }, ada, {
			byScript: true,
		});

		expect(response.status).toBe(429);
		expect(await response.text()).toContain("Too many attempts. Try again in a minute.");
		expect(await value("select count(*) from organisations")).toBe(0);
	});
});
