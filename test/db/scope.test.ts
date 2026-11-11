import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { organisationScope } from "~/db";
import { memberships, organisations, users } from "~/db/schema";
import { freshDatabase } from "./database";

let database: D1Database;

/** Two organisations with two members each; Dana belongs to both. */
async function seed() {
	const db = drizzle(database);
	const [acme, globex] = await db
		.insert(organisations)
		.values([
			{ name: "Acme", slug: "acme" },
			{ name: "Globex", slug: "globex" },
		])
		.returning();
	const [ada, bola, chidi, dana] = await db
		.insert(users)
		.values([
			{ name: "Ada", email: "ada@example.com" },
			{ name: "Bola", email: "bola@example.com" },
			{ name: "Chidi", email: "chidi@example.com" },
			{ name: "Dana", email: "dana@example.com" },
		])
		.returning();
	if (!acme || !globex || !ada || !bola || !chidi || !dana) throw new Error("seed failed");

	await db.insert(memberships).values([
		{ organisationId: acme.id, userId: ada.id, role: "owner" },
		{ organisationId: acme.id, userId: dana.id, role: "member" },
		{ organisationId: globex.id, userId: bola.id, role: "owner" },
		{ organisationId: globex.id, userId: dana.id, role: "member" },
	]);
	return { acme, globex, ada, bola, chidi, dana };
}

/** Reads memberships straight from the table, past the scope, to see what is really stored. */
function storedMemberships(organisationId: string) {
	return drizzle(database)
		.select()
		.from(memberships)
		.where(eq(memberships.organisationId, organisationId))
		.orderBy(memberships.id);
}

beforeEach(async () => {
	database = await freshDatabase();
});

describe("organisation scope", () => {
	it("selects the rows of its own organisation and none of another's", async () => {
		const { acme, globex, ada, bola, dana } = await seed();
		const scope = organisationScope(database, acme.id);

		const rows = await scope.memberships.select();

		expect(rows.map((row) => row.userId).sort()).toEqual([ada.id, dana.id].sort());
		expect(rows.every((row) => row.organisationId === acme.id)).toBe(true);
		// Asking for the other organisation's rows by name still returns nothing.
		expect(await scope.memberships.select((m) => eq(m.organisationId, globex.id))).toEqual([]);
		expect(await scope.memberships.select((m) => eq(m.userId, bola.id))).toEqual([]);
	});

	it("narrows a select within its organisation with a filter", async () => {
		const { acme, dana } = await seed();
		const scope = organisationScope(database, acme.id);

		const rows = await scope.memberships.select((m) => eq(m.userId, dana.id));

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ organisationId: acme.id, userId: dana.id, role: "member" });
	});

	it("updates the rows of its own organisation and none of another's", async () => {
		const { acme, globex, bola } = await seed();
		const before = await storedMemberships(globex.id);
		const scope = organisationScope(database, acme.id);

		const updated = await scope.memberships.update({ role: "admin" });
		const aimedAtOther = await scope.memberships.update({ role: "admin" }, (m) =>
			eq(m.userId, bola.id),
		);

		expect(updated).toHaveLength(2);
		expect((await storedMemberships(acme.id)).map((row) => row.role)).toEqual(["admin", "admin"]);
		expect(aimedAtOther).toEqual([]);
		expect(await storedMemberships(globex.id)).toEqual(before);
	});

	it("deletes the rows of its own organisation and none of another's", async () => {
		const { acme, globex, bola } = await seed();
		const before = await storedMemberships(globex.id);
		const scope = organisationScope(database, acme.id);

		const aimedAtOther = await scope.memberships.delete((m) => eq(m.userId, bola.id));
		const deleted = await scope.memberships.delete();

		expect(aimedAtOther).toEqual([]);
		expect(deleted).toHaveLength(2);
		expect(await storedMemberships(acme.id)).toEqual([]);
		expect(await storedMemberships(globex.id)).toEqual(before);
	});

	it("inserts into its own organisation", async () => {
		const { acme, chidi } = await seed();
		const scope = organisationScope(database, acme.id);

		const [inserted] = await scope.memberships.insert({ userId: chidi.id, role: "admin" });

		expect(inserted).toMatchObject({ organisationId: acme.id, userId: chidi.id, role: "admin" });
		expect(await storedMemberships(acme.id)).toHaveLength(3);
	});

	it("cannot insert into another organisation, even when the values name it", async () => {
		const { acme, globex, chidi } = await seed();
		const before = await storedMemberships(globex.id);
		const scope = organisationScope(database, acme.id);

		// What an untyped caller could send, for example a parsed request body.
		const fromRequest = JSON.parse(JSON.stringify({ userId: chidi.id, organisationId: globex.id }));
		const [inserted] = await scope.memberships.insert(fromRequest);

		expect(inserted?.organisationId).toBe(acme.id);
		expect(await storedMemberships(globex.id)).toEqual(before);
	});

	it("cannot move a row to another organisation with an update", async () => {
		const { acme, globex } = await seed();
		const before = await storedMemberships(globex.id);
		const scope = organisationScope(database, acme.id);

		const fromRequest = JSON.parse(JSON.stringify({ organisationId: globex.id, role: "admin" }));
		await scope.memberships.update(fromRequest);

		expect(await storedMemberships(acme.id)).toHaveLength(2);
		expect(await storedMemberships(globex.id)).toEqual(before);
	});

	it("starts every test from an empty database", async () => {
		expect(await drizzle(database).select().from(organisations)).toEqual([]);
		expect(await drizzle(database).select().from(memberships)).toEqual([]);
	});
});
