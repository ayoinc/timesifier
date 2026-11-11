import { asc, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { organisationScope, uuidv7 } from "~/db";
import {
	clients,
	memberships,
	organisations,
	periodEvents,
	periods,
	projects,
	teamMembers,
	teams,
	timeEntries,
	users,
} from "~/db/schema";
import { freshDatabase } from "./database";

// The tables of the features under the navigation's headings (TS-053): each
// row belongs to one organisation, a reference from one row to another stays
// inside that organisation, and the rules the database holds by itself hold.

let database: D1Database;

beforeEach(async () => {
	database = await freshDatabase();
});

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-11T09:00:00Z");

/**
 * Two organisations, Acme and Globex. Ada and Dana are members of Acme and
 * Bola of Globex; Dana belongs to both. Each organisation has a client, a
 * project of that client, a team and a submitted period.
 */
async function seed() {
	const db = drizzle(database);
	const [acme, globex] = await db
		.insert(organisations)
		.values([
			{ name: "Acme", slug: "acme" },
			{ name: "Globex", slug: "globex" },
		])
		.returning();
	const [ada, bola, dana] = await db
		.insert(users)
		.values([
			{ name: "Ada", email: "ada@example.com" },
			{ name: "Bola", email: "bola@example.com" },
			{ name: "Dana", email: "dana@example.com" },
		])
		.returning();
	if (!acme || !globex || !ada || !bola || !dana) throw new Error("seed failed");
	await db.insert(memberships).values([
		{ organisationId: acme.id, userId: ada.id, role: "member" },
		{ organisationId: acme.id, userId: dana.id, role: "member" },
		{ organisationId: globex.id, userId: bola.id, role: "member" },
		{ organisationId: globex.id, userId: dana.id, role: "member" },
	]);

	async function contents(organisationId: string, person: string, name: string) {
		const scope = organisationScope(database, organisationId);
		const [client] = await scope.clients.insert({ name, nameKey: name.toLowerCase() });
		const [project] = await scope.projects.insert({
			name: `${name} site`,
			nameKey: `${name.toLowerCase()} site`,
			clientId: client?.id ?? null,
		});
		const [team] = await scope.teams.insert({
			name: `${name} team`,
			nameKey: `${name.toLowerCase()} team`,
		});
		const [period] = await scope.periods.insert({
			userId: person,
			startsOn: "2026-11-09",
			endsOn: "2026-11-15",
			status: "submitted",
			submittedAt: new Date(T0),
		});
		if (!client || !project || !team || !period) throw new Error("seed failed");
		await scope.teamMembers.insert({ teamId: team.id, userId: person, isManager: true });
		await scope.periodEvents.insert({ periodId: period.id, action: "submitted", actorId: person });
		await scope.timeEntries.insert({
			userId: person,
			projectId: project.id,
			description: null,
			startedAt: new Date(T0),
			endedAt: new Date(T0 + HOUR),
		});
		return { client, project, team, period };
	}

	return {
		acme: { ...acme, ...(await contents(acme.id, ada.id, "Apex")) },
		globex: { ...globex, ...(await contents(globex.id, bola.id, "Gamma")) },
		ada,
		bola,
		dana,
	};
}

/** The message of the error a promise rejects with, or null when it resolves. */
async function refusal(promise: Promise<unknown>): Promise<string | null> {
	try {
		await promise;
		return null;
	} catch (error) {
		// Drizzle wraps D1's error, which names the constraint, as its cause.
		if (error instanceof Error && error.cause instanceof Error) return error.cause.message;
		return String(error);
	}
}

describe("each table of the heading features", () => {
	it.each([
		"clients",
		"projects",
		"timeEntries",
		"periods",
		"periodEvents",
		"teams",
		"teamMembers",
	] as const)("%s: the scope of one organisation holds none of another's rows", async (name) => {
		const { acme, globex } = await seed();

		const ofAcme = await organisationScope(database, acme.id)[name].select();
		const ofGlobex = await organisationScope(database, globex.id)[name].select();

		expect(ofAcme.length).toBeGreaterThan(0);
		expect(ofAcme.every((row) => row.organisationId === acme.id)).toBe(true);
		expect(ofGlobex.every((row) => row.organisationId === globex.id)).toBe(true);
		const ids = new Set(ofAcme.map((row) => row.id));
		expect(ofGlobex.some((row) => ids.has(row.id))).toBe(false);
	});
});

describe("a reference from one row to another", () => {
	it("cannot give a project a client of another organisation", async () => {
		const { acme, globex } = await seed();
		const scope = organisationScope(database, acme.id);

		expect(
			await refusal(
				scope.projects.insert({ name: "Stolen", nameKey: "stolen", clientId: globex.client.id }),
			),
		).toContain("FOREIGN KEY");
		expect(
			await refusal(
				scope.projects.update({ clientId: globex.client.id }, (p) => eq(p.id, acme.project.id)),
			),
		).toContain("FOREIGN KEY");
	});

	it("cannot track time against a project of another organisation", async () => {
		const { acme, globex, ada } = await seed();

		expect(
			await refusal(
				organisationScope(database, acme.id).timeEntries.insert({
					userId: ada.id,
					projectId: globex.project.id,
					description: null,
					startedAt: new Date(T0 + 2 * HOUR),
					endedAt: null,
				}),
			),
		).toContain("FOREIGN KEY");
	});

	it("cannot put a person in a team of an organisation they are not a member of", async () => {
		const { acme, globex, ada, bola } = await seed();

		// Bola is a member of Globex, not of Acme.
		expect(
			await refusal(
				organisationScope(database, acme.id).teamMembers.insert({
					teamId: acme.team.id,
					userId: bola.id,
				}),
			),
		).toContain("FOREIGN KEY");
		// Nor in another organisation's team through this one.
		expect(
			await refusal(
				organisationScope(database, acme.id).teamMembers.insert({
					teamId: globex.team.id,
					userId: ada.id,
				}),
			),
		).toContain("FOREIGN KEY");
	});

	it("cannot record a step of another organisation's period", async () => {
		const { acme, globex, ada } = await seed();

		expect(
			await refusal(
				organisationScope(database, acme.id).periodEvents.insert({
					periodId: globex.period.id,
					action: "approved",
					actorId: ada.id,
				}),
			),
		).toContain("FOREIGN KEY");
	});
});

describe("the rules the database holds", () => {
	it("one running entry for a person in an organisation, and one in each of two organisations", async () => {
		const { acme, globex, dana } = await seed();
		const running = (organisationId: string, projectId: string) =>
			organisationScope(database, organisationId).timeEntries.insert({
				userId: dana.id,
				projectId,
				description: null,
				startedAt: new Date(T0),
				endedAt: null,
			});

		await running(acme.id, acme.project.id);
		expect(await refusal(running(acme.id, acme.project.id))).toContain("UNIQUE");
		// Dana is a member of Globex too, and can run a timer there at the same time.
		expect(await refusal(running(globex.id, globex.project.id))).toBeNull();
	});

	it("an entry ends at or after its start", async () => {
		const { acme, ada } = await seed();

		expect(
			await refusal(
				organisationScope(database, acme.id).timeEntries.insert({
					userId: ada.id,
					projectId: acme.project.id,
					description: null,
					startedAt: new Date(T0),
					endedAt: new Date(T0 - 1),
				}),
			),
		).toContain("CHECK");
	});

	it("a name is unique in its organisation by its key, archived rows included", async () => {
		const { acme, globex } = await seed();
		await organisationScope(database, acme.id).projects.update({ archivedAt: new Date(T0) }, (p) =>
			eq(p.id, acme.project.id),
		);

		for (const name of ["clients", "projects", "teams"] as const) {
			const [existing] = await organisationScope(database, acme.id)[name].select();
			if (!existing) throw new Error(`no ${name}`);
			expect(
				await refusal(
					organisationScope(database, acme.id)[name].insert({
						name: existing.name.toUpperCase(),
						nameKey: existing.nameKey,
					}),
				),
				name,
			).toContain("UNIQUE");
			// The same name in another organisation is its own.
			expect(
				await refusal(
					organisationScope(database, globex.id)[name].insert({
						name: existing.name,
						nameKey: existing.nameKey,
					}),
				),
				name,
			).toBeNull();
		}
	});

	it("one period for a person from a given day, with a known status and its days in order", async () => {
		const { acme, ada } = await seed();
		const scope = organisationScope(database, acme.id);
		const period = (startsOn: string, endsOn: string, status: string) =>
			scope.periods.insert({ userId: ada.id, startsOn, endsOn, status, submittedAt: new Date(T0) });

		expect(await refusal(period("2026-11-09", "2026-11-15", "submitted"))).toContain("UNIQUE");
		expect(await refusal(period("2026-11-16", "2026-11-22", "lost"))).toContain("CHECK");
		expect(await refusal(period("2026-11-23", "2026-11-22", "submitted"))).toContain("CHECK");
		expect(await refusal(period("2026-11-16", "2026-11-22", "approved"))).toBeNull();
		expect(
			await refusal(
				scope.periodEvents.insert({
					periodId: (await scope.periods.select())[0]?.id ?? "",
					action: "deleted",
					actorId: ada.id,
				}),
			),
		).toContain("CHECK");
	});

	it("a person leaves an organisation's teams when they leave the organisation", async () => {
		const { acme, ada } = await seed();

		await drizzle(database).delete(memberships).where(eq(memberships.userId, ada.id));

		expect(await organisationScope(database, acme.id).teamMembers.select()).toEqual([]);
		// Their entries and periods stay, so the organisation's totals still add up.
		expect(await organisationScope(database, acme.id).timeEntries.select()).toHaveLength(1);
		expect(await organisationScope(database, acme.id).periods.select()).toHaveLength(1);
	});

	it("deleting an organisation deletes every row of it, and nothing of another's", async () => {
		const { acme, globex } = await seed();

		await drizzle(database).delete(organisations).where(eq(organisations.id, acme.id));

		const db = drizzle(database);
		for (const table of [
			clients,
			projects,
			timeEntries,
			periods,
			periodEvents,
			teams,
			teamMembers,
		]) {
			const rows = await db.select().from(table);
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.every((row) => row.organisationId === globex.id)).toBe(true);
		}
	});
});

describe("the scope's batch", () => {
	it("applies every statement or none", async () => {
		const { acme } = await seed();
		const scope = organisationScope(database, acme.id);

		const failed = await refusal(
			scope.batch([
				scope.clients.statements.update({ name: "Renamed" }, (c) => eq(c.id, acme.client.id)),
				// The same key as the client above: refused, and the rename with it.
				scope.clients.statements.insert({ name: "Apex", nameKey: "apex" }),
			]),
		);

		expect(failed).not.toBeNull();
		expect((await scope.clients.select())[0]?.name).toBe("Apex");

		const [renamed, inserted] = await scope.batch([
			scope.clients.statements.update({ name: "Renamed" }, (c) => eq(c.id, acme.client.id)),
			scope.clients.statements.insert({ name: "Other", nameKey: "other" }),
		]);
		expect(renamed.map((row) => row.name)).toEqual(["Renamed"]);
		expect(inserted.map((row) => row.organisationId)).toEqual([acme.id]);
	});

	it("builds its statements inside the organisation, whatever the values name", async () => {
		const { acme, globex } = await seed();
		const scope = organisationScope(database, acme.id);
		const smuggled = JSON.parse(
			JSON.stringify({ name: "Smuggled", nameKey: "smuggled", organisationId: globex.id }),
		);

		const [[inserted], moved] = await scope.batch([
			scope.clients.statements.insert(smuggled),
			scope.clients.statements.update(
				JSON.parse(JSON.stringify({ name: "Moved", organisationId: globex.id })),
				(c) => eq(c.id, acme.client.id),
			),
		]);

		expect(inserted?.organisationId).toBe(acme.id);
		expect(moved.every((row) => row.organisationId === acme.id)).toBe(true);
		expect(await organisationScope(database, globex.id).clients.select()).toHaveLength(1);
	});
});

describe("the scope's select", () => {
	it("orders and limits the rows of its organisation", async () => {
		const { acme } = await seed();
		const scope = organisationScope(database, acme.id);
		await scope.clients.insert([
			{ id: uuidv7(), name: "Beta", nameKey: "beta" },
			{ id: uuidv7(), name: "Zed", nameKey: "zed" },
		]);

		const byName = await scope.clients.select(undefined, { orderBy: (c) => [asc(c.nameKey)] });
		expect(byName.map((c) => c.name)).toEqual(["Apex", "Beta", "Zed"]);
		const last = await scope.clients.select(undefined, {
			orderBy: (c) => [desc(c.nameKey)],
			limit: 1,
		});
		expect(last.map((c) => c.name)).toEqual(["Zed"]);
	});
});
