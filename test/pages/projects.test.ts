import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { organisationScope } from "~/db";
import { timeScopeOf } from "~/organisations/access";
import { groupedByClient } from "~/projects/projects";
import { activeProjects, projectHours } from "~/projects/projects.server";
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
		// While Clients is on, each list is a client's group: these have none.
		const archivedList =
			main.match(/<ol aria-label="Archived projects: No client"[\s\S]*?<\/ol>/)?.[0] ?? "";
		expect(textOf(archivedList)).toContain("Design");
		expect(main).not.toContain('aria-label="Active projects');
		const active = mainOf(await pageBody(await open(PROJECTS, ada)));
		const activeList =
			active.match(/<ol aria-label="Active projects: No client"[\s\S]*?<\/ol>/)?.[0] ?? "";
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

// TS-057: the list searched by a project's or its client's name, in the
// address; grouped under the clients; each project's hours to date.

/** The headings of the client groups on the page, in its order. */
const groupsIn = (main: string) =>
	[...main.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>\s*<ol aria-label=/g)].map(([, heading]) =>
		textOf(heading ?? ""),
	);

/** One entry of `who` on `projectId`, `minutes` long: ended `endedAgo` minutes ago, or running when null. */
async function track(who: Person, projectId: string, minutes: number, endedAgo: number | null) {
	const end = Date.now() - (endedAgo ?? 0) * 60_000;
	await organisationScope(env.DB, acme.id).timeEntries.insert({
		userId: who.user.id,
		projectId,
		startedAt: new Date(end - minutes * 60_000),
		endedAt: endedAgo === null ? null : new Date(end),
	});
}

/** The text of the page's `<main>` at `path`, as `who` sees it. */
const mainText = async (path: string, who: Person = ada) =>
	textOf(mainOf(await pageBody(await open(path, who))));

describe("search (TS-057)", () => {
	beforeEach(async () => {
		const globex = await insertClient(acme.id, "Globex Corporation");
		const initech = await insertClient(acme.id, "Initech");
		await send({ intent: "create", name: "Website", clientId: globex });
		await send({ intent: "create", name: "Payroll", clientId: initech });
		await send({ intent: "create", name: "Office move" });
		await send({ intent: "create", name: "Old site", clientId: globex });
		await send({ intent: "archive", projectId: await projectId("Old site") });
	});

	const search = (query: string, who: Person = ada) =>
		mainText(`${PROJECTS}?q=${encodeURIComponent(query)}`, who);

	it("finds a project by a part of its name, in any letters, and leaves the others out of the page", async () => {
		const text = await search("SITE");
		expect(text).toContain("Website");
		expect(text).not.toContain("Payroll");
		expect(text).not.toContain("Office move");
		// The archived tab keeps the search.
		const archived = await mainText(`${PROJECTS}?q=SITE&show=archived`);
		expect(archived).toContain("Old site");
		expect(archived).not.toContain("Payroll");
	});

	it("finds every project of a client by a part of the client's name", async () => {
		const text = await search("globex");
		expect(text).toContain("Website");
		expect(text).not.toContain("Payroll");
		expect(text).not.toContain("Office move");
		expect(await mainText(`${PROJECTS}?q=globex&show=archived`)).toContain("Old site");
	});

	it("reads the words searched for from the address, and shows them in the field", async () => {
		const html = await pageBody(await open(`${PROJECTS}?q=pay`, ada));
		expect(html).toMatch(/<form[^>]*role="search"[^>]*aria-label="Search projects"/);
		const field = html.match(/<input[^>]*name="q"[^>]*>/)?.[0] ?? "";
		expect(field).toContain('value="pay"');
		expect(field).toContain('type="search"');
		expect(textOf(mainOf(html))).toContain("Clear search");
	});

	it("takes % and _ as letters, not wildcards", async () => {
		const text = await search("%");
		expect(text).not.toContain("Website");
		expect(text).toContain("No active project has “%” in its name or its client’s.");
		expect(await search("_")).not.toContain("Payroll");
	});

	it("says when nothing matches, and keeps the field and the button to create one", async () => {
		const text = await search("zzz");
		expect(text).toContain("No active project has “zzz” in its name or its client’s.");
		expect(text).not.toContain("No projects yet");
		expect(text).toContain("Create project");
	});

	it("an empty search, or one of spaces, is every project", async () => {
		for (const query of ["", "   "]) {
			const text = await search(query);
			for (const name of ["Website", "Payroll", "Office move"]) expect(text).toContain(name);
			expect(text).not.toContain("Clear search");
		}
	});

	it("a member searches too, by client name as well", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");
		const text = await search("initech", linus);
		expect(text).toContain("Payroll");
		expect(text).not.toContain("Website");
	});

	it("while Clients is off, a client's name finds nothing and the field says project name", async () => {
		await env.DB.prepare("update organisations set clients_enabled = 0 where id = ?")
			.bind(acme.id)
			.run();
		const text = await search("globex");
		expect(text).not.toContain("Website");
		expect(text).toContain("No active project has “globex” in its name.");
		expect(text).toContain("Search by project name");
	});

	it("never finds a project of another organisation", async () => {
		const grace = await person(mailbox, "grace@example.com");
		await createOrganisation(grace.cookie, "Hooli");
		await send({ intent: "create", name: "Secret website" }, grace, "/app/hooli/projects");
		const text = await search("website");
		expect(text).toContain("Website");
		expect(text).not.toContain("Secret website");
	});
});

describe("groups (TS-057)", () => {
	it("puts the projects under their client's name, by name, then No client last", async () => {
		const zeta = await insertClient(acme.id, "Zeta");
		const alpha = await insertClient(acme.id, "alpha");
		await send({ intent: "create", name: "Bravo", clientId: zeta });
		await send({ intent: "create", name: "Able", clientId: zeta });
		await send({ intent: "create", name: "Own" });
		await send({ intent: "create", name: "Charlie", clientId: alpha });

		const main = mainOf(await pageBody(await open(PROJECTS, ada)));
		expect(groupsIn(main)).toEqual(["alpha", "Zeta", "No client"]);
		expect(main).toContain('aria-label="Active projects: Zeta"');
		const text = textOf(main);
		expect(text.indexOf("Able")).toBeLessThan(text.indexOf("Bravo"));
	});

	it("says when a group's client is archived", async () => {
		const globex = await insertClient(acme.id, "Globex");
		await send({ intent: "create", name: "Design", clientId: globex });
		await env.DB.prepare("update clients set archived_at = ? where id = ?")
			.bind(Date.now(), globex)
			.run();
		expect(groupsIn(mainOf(await pageBody(await open(PROJECTS, ada))))).toEqual([
			"Globex (archived client)",
		]);
	});

	it("has no groups while Clients is off", async () => {
		const globex = await insertClient(acme.id, "Globex");
		await send({ intent: "create", name: "Design", clientId: globex });
		await send({ intent: "create", name: "Own" });
		await env.DB.prepare("update organisations set clients_enabled = 0 where id = ?")
			.bind(acme.id)
			.run();
		const main = mainOf(await pageBody(await open(PROJECTS, ada)));
		expect(groupsIn(main)).toEqual([]);
		expect(textOf(main)).not.toContain("No client");
		expect(main).toContain('aria-label="Active projects"');
	});

	it("groupedByClient keeps one group per client, ordered by key, the clientless last", () => {
		const client = (id: string, key: string) => ({ id, name: key, key, archived: false });
		const projects = [
			{ id: "1", client: null },
			{ id: "2", client: client("z", "zeta") },
			{ id: "3", client: client("a", "alpha") },
			{ id: "4", client: client("z", "zeta") },
		];
		expect(
			groupedByClient(projects).map((g) => [g.client?.key ?? null, g.projects.map((p) => p.id)]),
		).toEqual([
			["alpha", ["3"]],
			["zeta", ["2", "4"]],
			[null, ["1"]],
		]);
		expect(groupedByClient([])).toEqual([]);
	});
});

describe("hours to date (TS-057)", () => {
	it("shows each project's finished and running time, and 0:00 for none", async () => {
		const design = await create("Design");
		await create("Idle");
		await track(ada, design, 90, 60 * 24);
		await track(ada, design, 120, null);

		const text = await mainText(PROJECTS);
		expect(text).toMatch(/Design 3:30/);
		expect(text).toMatch(/Idle 0:00/);
	});

	it("an owner or admin sees everyone's hours, a manager their own and their teams', a member their own", async () => {
		const grace = await memberOfAcme("admin", "grace@example.com");
		const hedy = await memberOfAcme("member", "hedy@example.com");
		const linus = await memberOfAcme("member", "linus@example.com");
		const mallory = await memberOfAcme("member", "mallory@example.com");
		await seedTeam(acme.id, "Design team", { members: [linus.user.id], managers: [hedy.user.id] });
		const design = await create("Design");
		await track(ada, design, 60, 10);
		await track(hedy, design, 120, 10);
		await track(linus, design, 240, 10);
		await track(mallory, design, 480, 10);

		const owner = await mainText(PROJECTS, ada);
		expect(owner).toMatch(/Design 15:00/);
		expect(owner).toContain(
			"Each shows the hours tracked on it to date, a running timer included.",
		);
		expect(await mainText(PROJECTS, grace)).toMatch(/Design 15:00/);
		const manager = await mainText(PROJECTS, hedy);
		expect(manager).toMatch(/Design 6:00/);
		expect(manager).toContain(
			"Each shows the hours you and the people in your teams have tracked on it to date",
		);
		const member = await mainText(PROJECTS, mallory);
		expect(member).toMatch(/Design 8:00/);
		expect(member).toContain("Each shows the hours you have tracked on it to date");
		expect(await mainText(PROJECTS, linus)).toMatch(/Design 4:00/);
	});

	it("counts no time of another organisation, on a project of the same name", async () => {
		const design = await create("Design");
		await track(ada, design, 60, 10);
		const grace = await person(mailbox, "grace@example.com");
		const hooli = await createOrganisation(grace.cookie, "Hooli");
		const theirs = organisationScope(env.DB, hooli.id);
		const [their] = await theirs.projects.insert({ name: "Design", nameKey: "design" });
		await theirs.timeEntries.insert({
			userId: grace.user.id,
			projectId: their?.id ?? "",
			startedAt: new Date(Date.now() - 600 * 60_000),
			endedAt: new Date(),
		});
		expect(await mainText(PROJECTS)).toMatch(/Design 1:00/);
	});

	it("reads them in one statement, whatever the number of projects", async () => {
		for (const name of ["A", "B", "C"]) await track(ada, await create(name), 30, 10);
		const prepare = vi.spyOn(env.DB, "prepare");
		const hours = await projectHours(
			organisationScope(env.DB, acme.id),
			{ everyone: true },
			Date.now(),
		);
		expect(hours.size).toBe(3);
		const statements = prepare.mock.calls.map(([text]) => String(text));
		expect(statements).toHaveLength(1);
		expect(statements[0]).toMatch(/sum\(/i);
	});

	/** A small, seeded generator (mulberry32), so a failing case can be run again. */
	function random(seed: number) {
		let state = seed >>> 0;
		return () => {
			state = (state + 0x6d2b79f5) >>> 0;
			let t = state;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
		};
	}

	it("property: a project's hours are the time of the entries the viewer may see, a running one to now", async () => {
		const scope = organisationScope(env.DB, acme.id);
		const people = [ada];
		for (const email of ["p1@example.com", "p2@example.com", "p3@example.com"]) {
			people.push(await memberOfAcme("member", email));
		}
		const projects = await scope.projects.insert(
			["P0", "P1", "P2", "P3"].map((name) => ({ name, nameKey: name.toLowerCase() })),
		);
		const now = Date.UTC(2026, 10, 11, 12);
		for (let seed = 0; seed < 40; seed++) {
			const next = random(seed);
			const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)] as T;
			await env.DB.prepare("delete from time_entries").run();
			const entries: { userId: string; projectId: string; start: number; end: number | null }[] =
				[];
			const running = new Set<string>();
			for (let i = Math.floor(next() * 25); i > 0; i--) {
				const userId = pick(people).user.id;
				const start = now - Math.floor(next() * 90 * 86_400_000);
				// At most one running entry for each person, as the database insists.
				const runs = !running.has(userId) && next() < 0.2;
				if (runs) running.add(userId);
				entries.push({
					userId,
					projectId: pick(projects).id,
					start,
					end: runs ? null : start + Math.floor(next() * 10 * 3_600_000),
				});
			}
			// Ten rows at a time: D1 binds at most 100 values to a statement.
			for (let at = 0; at < entries.length; at += 10) {
				await scope.timeEntries.insert(
					entries.slice(at, at + 10).map((e) => ({
						userId: e.userId,
						projectId: e.projectId,
						startedAt: new Date(e.start),
						endedAt: e.end === null ? null : new Date(e.end),
					})),
				);
			}
			const managed = new Set(people.filter(() => next() < 0.3).map((p) => p.user.id));
			const whose = timeScopeOf({
				userId: pick(people).user.id,
				role: pick(["owner", "admin", "member"] as const),
				managed,
			});
			const seen = entries.filter((e) => whose.everyone || whose.people.includes(e.userId));

			const hours = await projectHours(scope, whose, now);
			for (const project of projects) {
				const mine = seen.filter((e) => e.projectId === project.id);
				const ms = mine.reduce((total, e) => total + ((e.end ?? now) - e.start), 0);
				expect(hours.get(project.id), `seed ${seed}, ${project.name}`).toBe(
					mine.length > 0 ? Math.floor(ms / 1000) : undefined,
				);
			}
		}
	}, 60_000);
});
