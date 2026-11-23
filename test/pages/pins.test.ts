import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { type OrganisationScope, organisationScope, users } from "~/db";
import { destinationPath } from "~/shell/destinations";
import { trackChoices } from "~/tasks/track.server";
import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, membershipIn, seedMembership, value } from "../organisations/harness";
import { open, type Person, pageBody, person, submit } from "./harness";
import { type Kind, seedRoles } from "./roles-seed";

// Pins (TS-122, S2-09; decision 65): a person pins projects to the top of
// Projects and of Track time's picker, and the people they see on Team to the
// top of This week. A pin is theirs alone; it goes when they leave, and when
// the person pinned leaves.

const ACME = "acme";
const PROJECTS = destinationPath(ACME, "projects");
const TEAM = destinationPath(ACME, "team");
const PINNED_LIST = 'aria-label="Active projects: Pinned"';

type Everyone = Kind | "contractor" | "stranger";
let acme: { id: string };
let scope: OrganisationScope;
let people: Record<Everyone, Person>;
let site: string;
let atlas: string;

beforeEach(async () => {
	await freshDatabase();
	const mailbox = captureEmail();
	const seeded = await seedRoles(mailbox);
	acme = seeded.acme;
	scope = organisationScope(env.DB, acme.id);
	const contractor = await person(mailbox, "ida@example.com");
	await seedMembership(acme.id, contractor.user.id, "member");
	await env.DB.prepare("update memberships set is_contractor = 1 where user_id = ?")
		.bind(contractor.user.id)
		.run();
	const stranger = await person(mailbox, "mallory@example.com");
	await createOrganisation(stranger.cookie, "Globex");
	people = { ...seeded.people, contractor, stranger };
	const [first, second] = await scope.projects.insert([
		{ name: "Site", nameKey: "site" },
		{ name: "Atlas", nameKey: "atlas" },
	]);
	if (!first || !second) throw new Error("seed failed");
	site = first.id;
	atlas = second.id;
}, 60_000);

async function pinProject(who: Person, projectId: string, pinned = true) {
	const response = await submit(
		PROJECTS,
		{ intent: "pin", projectId, pinned: String(pinned) },
		who,
		{ byScript: true },
	);
	return { status: response.status, said: await response.text() };
}

async function pinPerson(who: Person, userId: string, pinned = true) {
	const response = await submit(TEAM, { intent: "pin", userId, pinned: String(pinned) }, who, {
		byScript: true,
	});
	return { status: response.status, said: await response.text() };
}

const projectsPage = async (who: Person) => pageBody(await open(PROJECTS, who));
const pinsOf = (who: Person) =>
	value<number>("select count(*) from pins where user_id = ?", who.user.id);

describe.each(["owner", "admin", "finance", "manager", "member", "contractor"] as const)(
	"to the %s, a project",
	(kind) => {
		it("is pinned to the top of their own Projects, and unpinned again", async () => {
			const who = people[kind];
			const before = await projectsPage(who);
			expect(before).not.toContain(PINNED_LIST);
			expect(before.indexOf(">Atlas<")).toBeLessThan(before.indexOf(">Site<"));

			const pinned = await pinProject(who, site);
			expect(pinned.status).toBe(200);
			expect(pinned.said).toContain("Project pinned to the top.");
			const after = await projectsPage(who);
			expect(after).toContain(PINNED_LIST);
			expect(after.indexOf(">Site<")).toBeLessThan(after.indexOf(">Atlas<"));
			// Pinning it again changes nothing.
			expect((await pinProject(who, site)).status).toBe(200);
			expect(await pinsOf(who)).toBe(1);

			// Nobody else's list moves.
			const other = kind === "owner" ? people.admin : people.owner;
			expect(await projectsPage(other)).not.toContain(PINNED_LIST);

			const unpinned = await pinProject(who, site, false);
			expect(unpinned.said).toContain("Project unpinned.");
			expect(await projectsPage(who)).not.toContain(PINNED_LIST);
			expect(await pinsOf(who)).toBe(0);
		});

		it("comes first in Track time's picker", async () => {
			await pinProject(people[kind], atlas);
			const [user] = await drizzle(env.DB)
				.select()
				.from(users)
				.where(eq(users.id, people[kind].user.id));
			if (!user) throw new Error("No user.");
			const membership = await membershipIn(user, ACME);
			const choices = await trackChoices(scope, membership, [], Date.now());
			expect(choices.pinned).toEqual([atlas]);
		});
	},
);

describe("a project's pin", () => {
	it("is refused for another organisation's project: 404, and nothing is written", async () => {
		const globex = await value<string>("select id from organisations where slug <> ?", ACME);
		const [theirs] = await organisationScope(env.DB, globex as string).projects.insert({
			name: "Secret",
			nameKey: "secret",
		});
		expect((await pinProject(people.owner, theirs?.id ?? "")).status).toBe(404);
		expect(await pinsOf(people.owner)).toBe(0);
	});

	it("is not there for a stranger: 404, and nothing is written", async () => {
		expect((await pinProject(people.stranger, site)).status).toBe(404);
		expect(await value("select count(*) from pins")).toBe(0);
	});
});

describe.each(["owner", "admin"] as const)("to the %s, a person", (kind) => {
	it("is pinned to the top of their own This week, and unpinned again", async () => {
		const who = people[kind];
		const linus = people.member.user.id;
		const grace = people.admin.user.id;
		const before = await pageBody(await open(TEAM, who));
		expect(before.indexOf(`person=${grace}`)).toBeLessThan(before.indexOf(`person=${linus}`));

		const pinned = await pinPerson(who, linus);
		expect(pinned.status).toBe(200);
		expect(pinned.said).toContain("Pinned to the top of This week.");
		const after = await pageBody(await open(TEAM, who));
		expect(after.indexOf(`person=${linus}`)).toBeLessThan(after.indexOf(`person=${grace}`));
		expect(after).toContain("Pinned");

		// Nobody else's This week moves.
		const other = kind === "owner" ? people.admin : people.owner;
		const theirs = await pageBody(await open(TEAM, other));
		expect(theirs.indexOf(`person=${grace}`)).toBeLessThan(theirs.indexOf(`person=${linus}`));

		expect((await pinPerson(who, linus, false)).said).toContain("Unpinned.");
		expect(await pinsOf(who)).toBe(0);
	});
});

describe("to a manager, a person", () => {
	it("of their team is pinned; anyone else is as absent as nobody: 404", async () => {
		const { manager, member, finance } = people;
		expect((await pinPerson(manager, member.user.id)).status).toBe(200);
		expect(await pinsOf(manager)).toBe(1);
		expect((await pinPerson(manager, finance.user.id)).status).toBe(404);
		expect(await pinsOf(manager)).toBe(1);
	});
});

describe.each(["finance", "member", "contractor", "stranger"] as const)(
	"to the %s, Team",
	(kind) => {
		it("is not there, and pinning a person writes nothing", async () => {
			expect((await open(TEAM, people[kind])).status).toBe(404);
			expect((await pinPerson(people[kind], people.member.user.id)).status).toBe(404);
			expect(await value("select count(*) from pins")).toBe(0);
		});
	},
);

describe("when a person leaves", () => {
	it("their own pins go, and every pin of them", async () => {
		const { owner, member } = people;
		await pinProject(member, site);
		await pinPerson(owner, member.user.id);
		await pinProject(owner, atlas);
		expect(await value("select count(*) from pins")).toBe(3);

		await env.DB.prepare("delete from memberships where user_id = ?").bind(member.user.id).run();
		expect(
			await value(
				"select count(*) from pins where user_id = ? or person_id = ?",
				member.user.id,
				member.user.id,
			),
		).toBe(0);
		// The owner's pin of a project stays.
		expect(await pinsOf(owner)).toBe(1);
	});

	it("a pin is a project or a person, never both nor neither", async () => {
		const both = env.DB.prepare(
			"insert into pins (id, organisation_id, user_id, project_id, person_id, created_at) values ('x', ?, ?, ?, ?, 0)",
		)
			.bind(acme.id, people.owner.user.id, site, people.member.user.id)
			.run();
		await expect(both).rejects.toThrow(/CHECK/);
		const neither = env.DB.prepare(
			"insert into pins (id, organisation_id, user_id, created_at) values ('y', ?, ?, 0)",
		)
			.bind(acme.id, people.owner.user.id)
			.run();
		await expect(neither).rejects.toThrow(/CHECK/);
	});
});
