import { eq, getTableColumns, is, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { beforeEach, describe, expect, it } from "vitest";
import * as publicSurface from "~/db";
import { everyRow, organisationScope } from "~/db";
import * as schema from "~/db/schema";
import { memberships, organisations, users } from "~/db/schema";
import { tenantTables } from "~/db/scope";
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

		const updated = await scope.memberships.update({ role: "admin" }, everyRow);
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
		const deleted = await scope.memberships.delete(everyRow);

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
		await scope.memberships.update(fromRequest, everyRow);

		expect(await storedMemberships(acme.id)).toHaveLength(2);
		expect(await storedMemberships(globex.id)).toEqual(before);
	});

	it("keeps a raw SQL condition with a top-level OR inside the organisation", async () => {
		const { acme, globex } = await seed();
		const before = await storedMemberships(globex.id);
		const scope = organisationScope(database, acme.id);
		// Without parentheses round the caller's condition this reads
		// "organisation = acme AND role = 'nobody' OR 1 = 1", which is every row.
		const anyRow = () => sql`${memberships.role} = 'nobody' or 1 = 1`;

		const selected = await scope.memberships.select(anyRow);
		const updated = await scope.memberships.update({ role: "admin" }, anyRow);

		expect(selected.map((row) => row.organisationId)).toEqual([acme.id, acme.id]);
		expect(updated.map((row) => row.organisationId)).toEqual([acme.id, acme.id]);
		expect(await storedMemberships(globex.id)).toEqual(before);

		const deleted = await scope.memberships.delete(anyRow);

		expect(deleted.map((row) => row.organisationId)).toEqual([acme.id, acme.id]);
		expect(await storedMemberships(globex.id)).toEqual(before);
	});

	it("refuses an update or delete whose filter produces no condition", async () => {
		const { acme } = await seed();
		const before = await storedMemberships(acme.id);
		const scope = organisationScope(database, acme.id);

		// `() => undefined` is what a filter built from optional input returns when
		// the input is missing.
		await expect(scope.memberships.update({ role: "admin" }, () => undefined)).rejects.toThrow(
			/needs a condition/,
		);
		await expect(scope.memberships.delete(() => undefined)).rejects.toThrow(/needs a condition/);
		expect(await storedMemberships(acme.id)).toEqual(before);
	});

	it("covers every table that has an organisation id, and exports none of them", () => {
		const withOrganisation = Object.values<unknown>(schema).filter(
			(table): table is SQLiteTable =>
				is(table, SQLiteTable) && "organisationId" in getTableColumns(table),
		);
		const exported: unknown[] = Object.values(publicSurface);

		expect(withOrganisation.length).toBeGreaterThan(0);
		for (const table of withOrganisation) {
			expect(Object.values<SQLiteTable>(tenantTables)).toContain(table);
			expect(exported).not.toContain(table);
		}
	});

	it("starts every test from an empty database", async () => {
		expect(await drizzle(database).select().from(organisations)).toEqual([]);
		expect(await drizzle(database).select().from(memberships)).toEqual([]);
	});
});
