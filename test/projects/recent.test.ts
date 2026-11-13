import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { type OrganisationScope, organisationScope, organisations, users } from "~/db";
import { membershipOf } from "~/organisations/membership.server";
import { recentProjectIds } from "~/projects/recent.server";
import { trackChoices } from "~/tasks/track.server";
import { dayOf } from "~/time/calendar";
import { freshDatabase } from "../db/database";
import { seedMembership } from "../organisations/harness";

// What the project picker is given beside the projects: the person's recent
// projects, from their own latest time entries, most recent first, distinct,
// archived ones left out; and each active project's client.

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-11T09:00:00Z");

let database: D1Database;
let scope: OrganisationScope;
let ada: typeof users.$inferSelect;
let bola: typeof users.$inferSelect;

beforeEach(async () => {
	database = await freshDatabase();
	const db = drizzle(database);
	const [acme] = await db.insert(organisations).values({ name: "Acme", slug: "acme" }).returning();
	const people = await db
		.insert(users)
		.values([
			{ name: "Ada", email: "ada@example.com" },
			{ name: "Bola", email: "bola@example.com" },
		])
		.returning();
	const [first, second] = people;
	if (!acme || !first || !second) throw new Error("seed failed");
	ada = first;
	bola = second;
	await seedMembership(acme.id, ada.id, "owner");
	await seedMembership(acme.id, bola.id, "member");
	scope = organisationScope(database, acme.id);
});

async function project(name: string, clientId: string | null = null) {
	const [made] = await scope.projects.insert({ name, nameKey: name.toLowerCase(), clientId });
	if (!made) throw new Error("seed failed");
	return made.id;
}

async function entry(userId: string, projectId: string, hoursAfterT0: number) {
	await scope.timeEntries.insert({
		userId,
		projectId,
		startedAt: new Date(T0 + hoursAfterT0 * HOUR),
		spentOn: dayOf(T0 + hoursAfterT0 * HOUR, "UTC"),
		endedAt: new Date(T0 + (hoursAfterT0 + 1) * HOUR),
	});
}

describe("recentProjectIds", () => {
	it("returns the person's own projects, most recent first, each once, archived left out", async () => {
		const [a, b, c, d, archived, others] = await Promise.all(
			["A", "B", "C", "D", "Old", "Bola's"].map((name) => project(name)),
		);
		if (!a || !b || !c || !d || !archived || !others) throw new Error("seed failed");
		await entry(ada.id, a, 1);
		await entry(ada.id, b, 2);
		await entry(ada.id, a, 3);
		await entry(ada.id, archived, 4);
		await entry(ada.id, c, 5);
		await entry(ada.id, d, 0);
		await entry(bola.id, others, 6);
		await scope.projects.update({ archivedAt: new Date(T0) }, (p) => eq(p.id, archived));

		expect(await recentProjectIds(scope, ada.id)).toEqual([c, a, b, d]);
		expect(await recentProjectIds(scope, ada.id, 2)).toEqual([c, a]);
		expect(await recentProjectIds(scope, bola.id)).toEqual([others]);
	});

	it("is empty for a person with no time", async () => {
		expect(await recentProjectIds(scope, ada.id)).toEqual([]);
	});
});

describe("trackChoices for the project picker", () => {
	it("gives the person's recent projects and each active project's client", async () => {
		const [client] = await scope.clients.insert({ name: "Globex", nameKey: "globex" });
		if (!client) throw new Error("seed failed");
		const withClient = await project("Website", client.id);
		const alone = await project("Admin");
		const archived = await project("Old site", client.id);
		await scope.projects.update({ archivedAt: new Date(T0) }, (p) => eq(p.id, archived));
		await entry(ada.id, alone, 1);
		await entry(ada.id, withClient, 2);
		await entry(bola.id, alone, 3);

		const membership = await membershipOf(ada, "acme");
		if (!membership) throw new Error("No membership.");
		const choices = await trackChoices(scope, membership, [], T0 + 5 * HOUR);
		expect(choices.recent).toEqual([withClient, alone]);
		expect(choices.clients).toEqual({ [withClient]: "Globex" });
	});
});
