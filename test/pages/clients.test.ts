import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	type Role,
	row,
	seedMembership,
	seedTeam,
	value,
} from "../organisations/harness";
import { open, type Person, pageBody, person, submit, textOf } from "./harness";

// Clients, /app/<slug>/clients (TS-011b): owners and admins see and manage the
// organisation's clients while it has Clients turned on (docs/navigation.md
// wins over the card's first text); everybody else, and everybody while it is
// off, gets the same 404 as an organisation that is not theirs, for the page
// and for every form. A client is never deleted.

const CLIENTS = "/app/acme/clients";
const PROJECTS = "/app/acme/projects";
const NAME_PROBLEM = "Enter a name of up to 120 characters.";
const TAKEN = "A client with this name already exists.";

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

async function memberOfAcme(role: Role, email: string): Promise<Person> {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, role);
	return who;
}

async function send(fields: Record<string, string>, who: Person = ada, path = CLIENTS) {
	const response = await submit(path, fields, who, { byScript: true });
	return { status: response.status, said: await response.text() };
}

const clientId = (name: string) =>
	value<string>("select id from clients where name = ?", name) as Promise<string>;
const clientCount = () => value("select count(*) from clients");
const mainOf = (html: string) => html.match(/<main[\s\S]*<\/main>/)?.[0] ?? "";

async function create(name: string, who: Person = ada) {
	const answer = await send({ intent: "create", name }, who);
	expect(answer.status, answer.said).toBe(200);
	return clientId(name.trim());
}

describe("who may", () => {
	it.each(["owner", "admin"] as const)(
		"a %s sees the clients and creates, renames, archives and restores one",
		async (role) => {
			const who = role === "owner" ? ada : await memberOfAcme(role, `${role}@example.com`);
			expect((await open(CLIENTS, who)).status).toBe(200);

			const id = await create("Globex", who);
			expect((await send({ intent: "rename", clientId: id, name: "Globex Ltd" }, who)).status).toBe(
				200,
			);
			expect(await value("select name from clients where id = ?", id)).toBe("Globex Ltd");
			expect((await send({ intent: "archive", clientId: id }, who)).status).toBe(200);
			expect(await value("select archived_at from clients where id = ?", id)).not.toBeNull();
			expect((await send({ intent: "restore", clientId: id }, who)).status).toBe(200);
			expect(await value("select archived_at from clients where id = ?", id)).toBeNull();
		},
	);

	it("a member and a manager get 404 for the page and every form, and nothing changes", async () => {
		const id = await create("Globex");
		const linus = await memberOfAcme("member", "linus@example.com");
		const mary = await memberOfAcme("member", "mary@example.com");
		await seedTeam(acme.id, "Design", { members: [linus.user.id], managers: [mary.user.id] });

		for (const who of [linus, mary]) {
			expect((await open(CLIENTS, who)).status).toBe(404);
			for (const fields of [
				{ intent: "create", name: "Initech" },
				{ intent: "rename", clientId: id, name: "Mine" },
				{ intent: "archive", clientId: id },
			] as Record<string, string>[]) {
				expect((await send(fields, who)).status).toBe(404);
			}
		}
		expect(await row("select name, archived_at from clients")).toEqual({
			name: "Globex",
			archived_at: null,
		});
	});

	it("nobody deletes a client: any other intent is 400", async () => {
		const id = await create("Globex");
		expect((await send({ intent: "delete", clientId: id })).status).toBe(400);
		expect(await clientCount()).toBe(1);
	});

	it("while Clients is off, the page and its forms are 404 for an owner too", async () => {
		await create("Globex");
		await env.DB.prepare("update organisations set clients_enabled = 0 where id = ?")
			.bind(acme.id)
			.run();

		expect((await open(CLIENTS, ada)).status).toBe(404);
		expect((await send({ intent: "create", name: "Initech" })).status).toBe(404);
		expect(await clientCount()).toBe(1);
	});
});

describe("names", () => {
	it.each([
		["an empty name", ""],
		["a name of spaces", "  "],
		["a name of 121 characters", "c".repeat(121)],
	])("refuses %s with 400 and stores nothing", async (_, name) => {
		const answer = await send({ intent: "create", name });
		expect(answer.status).toBe(400);
		expect(answer.said).toContain(NAME_PROBLEM);
		expect(await clientCount()).toBe(0);
	});

	it("are unique in the organisation ignoring case, archived clients included", async () => {
		const globex = await create("Globex");
		await create("Initech");
		await send({ intent: "archive", clientId: globex });

		for (const fields of [
			{ intent: "create", name: "GLOBEX" },
			{ intent: "rename", clientId: await clientId("Initech"), name: "globex" },
		] as Record<string, string>[]) {
			const answer = await send(fields);
			expect(answer.status).toBe(400);
			expect(answer.said).toContain(TAKEN);
		}
		expect((await send({ intent: "rename", clientId: globex, name: "GLOBEX" })).status).toBe(200);
		expect(await create("Hooli")).toEqual(expect.any(String));
		expect(
			(await send({ intent: "rename", clientId: globex, name: "x".repeat(121) })).said,
		).toContain(NAME_PROBLEM);
	});

	it("a client of another organisation is 404, and is not touched", async () => {
		const grace = await person(mailbox, "grace@example.com");
		await createOrganisation(grace.cookie, "Initech");
		await send({ intent: "create", name: "Theirs" }, grace, "/app/initech/clients");
		const theirs = await clientId("Theirs");

		expect((await send({ intent: "rename", clientId: theirs, name: "Mine" })).status).toBe(404);
		expect((await send({ intent: "archive", clientId: theirs })).status).toBe(404);
		expect(await value("select name from clients where id = ?", theirs)).toBe("Theirs");
		// The same name is accepted here.
		await create("Theirs");
	});
});

describe("the page", () => {
	it("with no clients says so, with one button", async () => {
		const main = mainOf(await pageBody(await open(CLIENTS, ada)));
		expect(main).toContain(">No clients yet</h2>");
		const buttons = [...main.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)];
		expect(buttons.map(([, label]) => textOf(label ?? ""))).toEqual(["Create client"]);
	});

	it("shows each client with its projects, and an archived client under Archived", async () => {
		const globex = await create("Globex");
		await send({ intent: "create", name: "Design", clientId: globex }, ada, PROJECTS);
		await send({ intent: "create", name: "Build", clientId: globex }, ada, PROJECTS);

		let text = textOf(mainOf(await pageBody(await open(CLIENTS, ada))));
		expect(text).toContain("Globex");
		expect(text).toContain("Build, Design");

		await send({ intent: "archive", clientId: globex });
		text = textOf(mainOf(await pageBody(await open(CLIENTS, ada))));
		expect(text).not.toContain("Globex");
		text = textOf(mainOf(await pageBody(await open(`${CLIENTS}?show=archived`, ada))));
		expect(text).toContain("Globex");
		expect(text).toContain("Build, Design");
	});

	it("archiving a client keeps it on its projects, which still show it", async () => {
		const globex = await create("Globex");
		await send({ intent: "create", name: "Design", clientId: globex }, ada, PROJECTS);
		await send({ intent: "archive", clientId: globex });

		expect(await value("select client_id from projects where name = 'Design'")).toBe(globex);
		const projects = textOf(mainOf(await pageBody(await open(PROJECTS, ada))));
		expect(projects).toContain("Globex (archived client)");
	});
});
