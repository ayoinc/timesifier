import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { organisationScope } from "~/db";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, seedMembership, seedTeam, value } from "../organisations/harness";
import { open, openData, type Person, pageBody, person, submit, textOf } from "./harness";

// Who creates projects (decision 42, TS-115a, amending decision 25): owners and
// admins, for any client or none, and a client's account managers, for that
// client alone. Each role is offered Create on Projects only where the server
// takes it, and the server refuses everyone else, storing nothing.

const PROJECTS = "/app/acme/projects";

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };
let globex: string;
let initech: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	const scope = organisationScope(env.DB, acme.id);
	const [g, i] = await scope.clients.insert([
		{ name: "Globex", nameKey: "globex" },
		{ name: "Initech", nameKey: "initech" },
	]);
	if (!g || !i) throw new Error("No client was stored.");
	globex = g.id;
	initech = i.id;
	// A project, so the page shows its list and not the empty state.
	await scope.projects.insert({ name: "Existing", nameKey: "existing" });
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

type Who =
	| "owner"
	| "admin"
	| "finance"
	| "account manager"
	| "manager"
	| "member"
	| "contractor"
	| "stranger";

/** A person who holds `who` in Acme; an account manager manages Globex alone. */
async function as(who: Who): Promise<Person> {
	if (who === "owner") return ada;
	const email = `${who.replace(" ", "-")}@example.com`;
	const someone = await person(mailbox, email);
	if (who === "stranger") return someone;
	const role = who === "admin" || who === "finance" ? who : "member";
	await seedMembership(acme.id, someone.user.id, role);
	if (who === "account manager") {
		await organisationScope(env.DB, acme.id).clientManagers.insert({
			clientId: globex,
			userId: someone.user.id,
		});
	}
	if (who === "manager") await seedTeam(acme.id, "Design", { managers: [someone.user.id] });
	if (who === "contractor") {
		await env.DB.prepare(
			"update memberships set is_contractor = 1 where organisation_id = ? and user_id = ?",
		)
			.bind(acme.id, someone.user.id)
			.run();
	}
	return someone;
}

/** The labels of the buttons in the page's `<main>`, as `who` sees it. */
async function buttonsOf(who: Person) {
	const response = await open(PROJECTS, who);
	if (response.status !== 200) return null;
	const main = (await pageBody(response)).match(/<main[\s\S]*<\/main>/)?.[0] ?? "";
	return [...main.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(([, label]) =>
		textOf(label ?? ""),
	);
}

/** What the server answers `who` creating a project named `name` for `clientId`, or with none. */
async function create(who: Person, name: string, clientId?: string) {
	const response = await submit(
		PROJECTS,
		{ intent: "create", name, ...(clientId ? { clientId } : {}) },
		who,
		{ byScript: true },
	);
	const stored = await value("select count(*) from projects where name = ?", name);
	return { status: response.status, stored };
}

/** Each role, whether Create is offered, and the status of a creation for Globex, Initech and no client. */
const TABLE: [Who, boolean, number, number, number][] = [
	["owner", true, 200, 200, 200],
	["admin", true, 200, 200, 200],
	["finance", false, 403, 403, 403],
	["account manager", true, 200, 403, 403],
	["manager", false, 403, 403, 403],
	["member", false, 403, 403, 403],
	["contractor", false, 403, 403, 403],
	["stranger", false, 404, 404, 404],
];

describe("who creates projects (decision 42)", () => {
	it.each(TABLE)(
		"a %s: Create offered %s; for their client %i, another client %i, no client %i",
		async (role, offered, forGlobex, forInitech, forNone) => {
			const who = await as(role);
			const buttons = await buttonsOf(who);
			if (role === "stranger") expect(buttons).toBeNull();
			else expect(buttons?.includes("Create project"), String(buttons)).toBe(offered);

			const answers = [
				await create(who, "For Globex", globex),
				await create(who, "For Initech", initech),
				await create(who, "For nobody"),
			];
			expect(answers.map((a) => a.status)).toEqual([forGlobex, forInitech, forNone]);
			// Nothing is stored where the server refuses.
			expect(answers.map((a) => a.stored)).toEqual(
				[forGlobex, forInitech, forNone].map((status) => (status === 200 ? 1 : 0)),
			);
		},
	);

	it("an account manager is offered only their own client in Create, and no project without one", async () => {
		const max = await as("account manager");
		const response = await openData(PROJECTS, max);
		const data = await response.text();
		expect(data).toContain("Globex");
		expect(data).not.toContain("Initech");
	});

	it("an account manager of an archived client creates none for it", async () => {
		const max = await as("account manager");
		await env.DB.prepare("update clients set archived_at = 1 where id = ?").bind(globex).run();
		expect((await create(max, "Late", globex)).stored).toBe(0);
	});

	it("an account manager creates none under Internal work, where nobody gives a client", async () => {
		const max = await as("account manager");
		await env.DB.prepare("update organisations set work_model = 'internal' where id = ?")
			.bind(acme.id)
			.run();
		expect(await buttonsOf(max)).not.toContain("Create project");
		expect(await create(max, "Inside", globex)).toEqual({ status: 403, stored: 0 });
	});

	it("an account manager who is no longer one creates none", async () => {
		const max = await as("account manager");
		await env.DB.prepare("delete from client_managers where user_id = ?").bind(max.user.id).run();
		expect(await buttonsOf(max)).not.toContain("Create project");
		expect(await create(max, "Gone", globex)).toEqual({ status: 403, stored: 0 });
	});
});
