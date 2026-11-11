import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { organisationScope } from "~/db";
import { activeProjects } from "~/projects/projects.server";
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

// Projects, /app/<slug>/projects (TS-011a, and a project's client, TS-011b):
// every role sees, creates, renames, archives and restores the organisation's
// projects, and nobody deletes one. Every form is posted the way the page
// posts it, by script to the page's data address.

const PROJECTS = "/app/acme/projects";
const NAME_PROBLEM = "Enter a name of up to 120 characters.";
const TAKEN = "A project with this name already exists.";

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

/** The answer to a form the page posts: its status and what it said. */
async function send(fields: Record<string, string>, who: Person = ada, path = PROJECTS) {
	const response = await submit(path, fields, who, { byScript: true });
	return { status: response.status, said: await response.text() };
}

const projectId = (name: string) =>
	value<string>("select id from projects where name = ?", name) as Promise<string>;
const projectCount = () => value("select count(*) from projects");

async function create(name: string, who: Person = ada) {
	const answer = await send({ intent: "create", name }, who);
	expect(answer.status, answer.said).toBe(200);
	return projectId(name.trim());
}

async function insertClient(organisationId: string, name: string, archived = false) {
	const [client] = await organisationScope(env.DB, organisationId).clients.insert({
		name,
		nameKey: name.toLowerCase(),
		archivedAt: archived ? new Date() : null,
	});
	if (!client) throw new Error("No client was stored.");
	return client.id;
}

/** The text inside the page's `<main>`. */
const mainOf = (html: string) => html.match(/<main[\s\S]*<\/main>/)?.[0] ?? "";

describe("a new organisation", () => {
	it("has no projects, and the page says so with one button", async () => {
		expect(await projectCount()).toBe(0);
		const html = await pageBody(await open(PROJECTS, ada));
		const main = mainOf(html);

		expect(main).toContain(">No projects yet</h2>");
		expect(textOf(main)).toContain(
			"A project is what you track time against, such as a client job or a piece of your own work.",
		);
		const buttons = [...main.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)];
		expect(buttons.map(([, label]) => textOf(label ?? ""))).toEqual(["Create project"]);
	});
});

describe("create", () => {
	it("stores a name of 1 to 120 characters, trimmed, and the list shows it", async () => {
		await create("  Design  ");
		await create("x");
		await create("y".repeat(120));

		expect(
			await row("select name, name_key, archived_at from projects where name = 'Design'"),
		).toEqual({ name: "Design", name_key: "design", archived_at: null });
		const text = textOf(await pageBody(await open(PROJECTS, ada)));
		expect(text).toContain("Design");
		expect(text).toContain("y".repeat(120));
		expect(text).not.toContain("No projects yet");
	});

	it.each([
		["an empty name", ""],
		["a name of spaces", "   "],
		["a name of 121 characters", "z".repeat(121)],
	])("refuses %s with 400 and stores nothing", async (_, name) => {
		const answer = await send({ intent: "create", name });

		expect(answer.status).toBe(400);
		expect(answer.said).toContain(NAME_PROBLEM);
		expect(await projectCount()).toBe(0);
	});

	it("refuses a name the organisation has in other letters, archived projects included", async () => {
		await create("Design");
		let answer = await send({ intent: "create", name: "design" });
		expect(answer.status).toBe(400);
		expect(answer.said).toContain(TAKEN);

		await send({ intent: "archive", projectId: await projectId("Design") });
		answer = await send({ intent: "create", name: "DESIGN" });
		expect(answer.status).toBe(400);
		expect(answer.said).toContain(TAKEN);
		expect(await projectCount()).toBe(1);
	});

	it("accepts a name another organisation has", async () => {
		const grace = await person(mailbox, "grace@example.com");
		await createOrganisation(grace.cookie, "Initech");
		await send({ intent: "create", name: "Design" }, grace, "/app/initech/projects");

		await create("Design");
		expect(await projectCount()).toBe(2);
	});
});

describe("rename", () => {
	it("keeps both rules, and accepts the project's own name in other letters", async () => {
		const design = await create("Design");
		await create("Research");

		expect(await send({ intent: "rename", projectId: design, name: " " })).toEqual({
			status: 400,
			said: expect.stringContaining(NAME_PROBLEM),
		});
		expect(await send({ intent: "rename", projectId: design, name: "w".repeat(121) })).toEqual({
			status: 400,
			said: expect.stringContaining(NAME_PROBLEM),
		});
		expect(await send({ intent: "rename", projectId: design, name: "research" })).toEqual({
			status: 400,
			said: expect.stringContaining(TAKEN),
		});
		expect(await value("select name from projects where id = ?", design)).toBe("Design");

		const answer = await send({ intent: "rename", projectId: design, name: "DESIGN" });
		expect(answer.status).toBe(200);
		expect(await row("select name, name_key from projects where id = ?", design)).toEqual({
			name: "DESIGN",
			name_key: "design",
		});
	});
});

describe("archive and restore", () => {
	it("archive moves a project to Archived and out of what the timer offers; restore brings it back", async () => {
		const design = await create("Design");
		await create("Research");
		const offered = async () =>
			(await activeProjects(organisationScope(env.DB, acme.id))).map(({ name }) => name);

		expect((await send({ intent: "archive", projectId: design })).status).toBe(200);
		expect(await value("select archived_at from projects where id = ?", design)).toEqual(
			expect.any(Number),
		);
		expect(await offered()).toEqual(["Research"]);

		const main = mainOf(await pageBody(await open(`${PROJECTS}?show=archived`, ada)));
		// The address picks the tab, and only the chosen tab's list is on the page.
		expect(main).toMatch(/aria-selected="true"[^>]*><span[^>]*>Archived</);
		const archivedList = main.match(/<ol aria-label="Archived projects"[\s\S]*?<\/ol>/)?.[0] ?? "";
		expect(textOf(archivedList)).toContain("Design");
		expect(main).not.toContain('aria-label="Active projects"');
		const active = mainOf(await pageBody(await open(PROJECTS, ada)));
		const activeList = active.match(/<ol aria-label="Active projects"[\s\S]*?<\/ol>/)?.[0] ?? "";
		expect(textOf(activeList)).toContain("Research");
		expect(textOf(activeList)).not.toContain("Design");

		expect((await send({ intent: "restore", projectId: design })).status).toBe(200);
		expect(await value("select archived_at from projects where id = ?", design)).toBeNull();
		expect(await offered()).toEqual(["Design", "Research"]);
	});
});

describe("what the action takes", () => {
	it.each(["delete", "remove", "", "purge"])(
		"answers 400 to the intent %j and removes no project",
		async (intent) => {
			const design = await create("Design");
			const answer = await send({ intent, projectId: design });

			expect(answer.status).toBe(400);
			expect(await projectCount()).toBe(1);
		},
	);

	it("answers 404 to a project of another organisation, and changes nothing", async () => {
		const grace = await person(mailbox, "grace@example.com");
		await createOrganisation(grace.cookie, "Initech");
		await send({ intent: "create", name: "Secret" }, grace, "/app/initech/projects");
		const secret = await projectId("Secret");

		for (const fields of [
			{ intent: "rename", projectId: secret, name: "Mine now" },
			{ intent: "archive", projectId: secret },
			{ intent: "restore", projectId: secret },
		] as Record<string, string>[]) {
			expect((await send(fields)).status).toBe(404);
		}
		expect(await row("select name, archived_at from projects")).toEqual({
			name: "Secret",
			archived_at: null,
		});
	});
});

describe("who may (every role manages projects)", () => {
	const roles: Role[] = ["owner", "admin", "member"];

	it.each(roles)("a %s sees the projects, active and archived", async (role) => {
		const who = role === "owner" ? ada : await memberOfAcme(role, `${role}@example.com`);
		const design = await create("Design");
		await create("Research");
		await send({ intent: "archive", projectId: design });

		const response = await open(PROJECTS, who);
		expect(response.status).toBe(200);
		expect(textOf(mainOf(await pageBody(response)))).toContain("Research");
		const archived = await open(`${PROJECTS}?show=archived`, who);
		expect(textOf(mainOf(await pageBody(archived)))).toContain("Design");
	});

	it.each(roles)("a %s creates, renames, archives and restores a project", async (role) => {
		const who = role === "owner" ? ada : await memberOfAcme(role, `${role}@example.com`);
		const id = await create("Design", who);

		expect((await send({ intent: "rename", projectId: id, name: "Build" }, who)).status).toBe(200);
		expect(await value("select name from projects where id = ?", id)).toBe("Build");
		expect((await send({ intent: "archive", projectId: id }, who)).status).toBe(200);
		expect(await value("select archived_at from projects where id = ?", id)).not.toBeNull();
		expect((await send({ intent: "restore", projectId: id }, who)).status).toBe(200);
		expect(await value("select archived_at from projects where id = ?", id)).toBeNull();
	});

	it.each(roles)("a %s deletes no project", async (role) => {
		const who = role === "owner" ? ada : await memberOfAcme(role, `${role}@example.com`);
		const id = await create("Design");

		expect((await send({ intent: "delete", projectId: id }, who)).status).toBe(400);
		expect(await projectCount()).toBe(1);
	});

	it("a manager of a team manages projects too", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");
		await seedTeam(acme.id, "Design team", { managers: [linus.user.id] });
		const id = await create("Design", linus);
		expect((await send({ intent: "archive", projectId: id }, linus)).status).toBe(200);
	});
});

describe("a project's client", () => {
	it("an owner or admin gives a project an active client, or none", async () => {
		const globex = await insertClient(acme.id, "Globex");
		const admin = await memberOfAcme("admin", "grace@example.com");

		expect((await send({ intent: "create", name: "Design", clientId: globex }, admin)).status).toBe(
			200,
		);
		const design = await projectId("Design");
		expect(await value("select client_id from projects where id = ?", design)).toBe(globex);
		expect(textOf(mainOf(await pageBody(await open(PROJECTS, admin))))).toContain("Globex");

		await send({ intent: "rename", projectId: design, name: "Design", clientId: "none" });
		expect(await value("select client_id from projects where id = ?", design)).toBeNull();
	});

	it("a member reads a project's client and cannot give one", async () => {
		const globex = await insertClient(acme.id, "Globex");
		const linus = await memberOfAcme("member", "linus@example.com");
		await send({ intent: "create", name: "Design", clientId: globex });

		const html = mainOf(await pageBody(await open(PROJECTS, linus)));
		expect(textOf(html)).toContain("Globex");

		const answer = await send({ intent: "create", name: "Build", clientId: globex }, linus);
		expect(answer.status).toBe(403);
		const design = await projectId("Design");
		expect(
			(await send({ intent: "rename", projectId: design, name: "Design", clientId: "none" }, linus))
				.status,
		).toBe(403);
		expect(await value("select client_id from projects where id = ?", design)).toBe(globex);
		// Renaming without the field keeps the client.
		await send({ intent: "rename", projectId: design, name: "Designs" }, linus);
		expect(await value("select client_id from projects where id = ?", design)).toBe(globex);
	});

	it("an archived client is not offered, and the projects that have it keep it", async () => {
		const globex = await insertClient(acme.id, "Globex");
		await send({ intent: "create", name: "Design", clientId: globex });
		const design = await projectId("Design");
		await env.DB.prepare("update clients set archived_at = ? where id = ?")
			.bind(Date.now(), globex)
			.run();

		const answer = await send({ intent: "create", name: "Build", clientId: globex });
		expect(answer.status).toBe(400);
		expect(answer.said).toContain("Choose an active client, or none.");

		// Saving the project with its own client keeps it.
		expect(
			(await send({ intent: "rename", projectId: design, name: "Design 2", clientId: globex }))
				.status,
		).toBe(200);
		expect(await value("select client_id from projects where id = ?", design)).toBe(globex);
		const other = await create("Other");
		expect(
			(await send({ intent: "rename", projectId: other, name: "Other", clientId: globex })).status,
		).toBe(400);
	});

	it("a client of another organisation is no client here", async () => {
		const grace = await person(mailbox, "grace@example.com");
		const initech = await createOrganisation(grace.cookie, "Initech");
		const theirs = await insertClient(initech.id, "Theirs");

		const answer = await send({ intent: "create", name: "Design", clientId: theirs });
		expect(answer.status).toBe(400);
		expect(await projectCount()).toBe(0);
	});

	it("while Clients is off, nobody is shown a project's client or may give one, and nothing is deleted", async () => {
		const globex = await insertClient(acme.id, "Globex");
		await send({ intent: "create", name: "Design", clientId: globex });
		await env.DB.prepare("update organisations set clients_enabled = 0 where id = ?")
			.bind(acme.id)
			.run();

		const main = mainOf(await pageBody(await open(PROJECTS, ada)));
		expect(textOf(main)).not.toContain("Globex");
		expect(main).not.toContain(">Client<");
		expect((await send({ intent: "create", name: "Build", clientId: globex })).status).toBe(403);
		expect(await value("select client_id from projects where name = 'Design'")).toBe(globex);
		expect(await value("select count(*) from clients")).toBe(1);
	});
});
