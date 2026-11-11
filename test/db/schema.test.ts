import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { memberships, organisations, users } from "~/db/schema";
import { freshDatabase } from "./database";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let database: D1Database;

beforeEach(async () => {
	database = await freshDatabase();
});

async function seedMembership() {
	const db = drizzle(database);
	const [organisation] = await db
		.insert(organisations)
		.values({ name: "Acme", slug: "acme" })
		.returning();
	const [user] = await db
		.insert(users)
		.values({ name: "Ada", email: "ada@example.com" })
		.returning();
	if (!organisation || !user) throw new Error("seed failed");
	const [membership] = await db
		.insert(memberships)
		.values({ organisationId: organisation.id, userId: user.id })
		.returning();
	if (!membership) throw new Error("seed failed");
	return { db, organisation, user, membership };
}

describe("schema built from the committed migrations", () => {
	it("has the users, organisations and memberships tables", async () => {
		const { results } = await database
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.all<{ name: string }>();

		expect(results.map((row) => row.name)).toEqual(
			expect.arrayContaining(["memberships", "organisations", "users"]),
		);
	});

	it("gives each new row a UUIDv7 id that carries its creation time", async () => {
		const before = Date.now();
		const { organisation, user, membership } = await seedMembership();
		const after = Date.now();

		for (const row of [organisation, user, membership]) {
			expect(row.id).toMatch(UUID_V7);
			const embedded = Number.parseInt(row.id.replaceAll("-", "").slice(0, 12), 16);
			expect(embedded).toBeGreaterThanOrEqual(before);
			expect(embedded).toBeLessThanOrEqual(after);
		}
	});

	it("stores timestamps as integer milliseconds since the Unix epoch", async () => {
		const before = Date.now();
		await seedMembership();
		const after = Date.now();

		for (const table of ["users", "organisations", "memberships"]) {
			const row = await database
				.prepare(
					`SELECT created_at, updated_at, typeof(created_at) AS created_type, typeof(updated_at) AS updated_type FROM ${table}`,
				)
				.first<{
					created_at: number;
					updated_at: number;
					created_type: string;
					updated_type: string;
				}>();

			expect(row, table).toMatchObject({ created_type: "integer", updated_type: "integer" });
			expect(row?.created_at, table).toBeGreaterThanOrEqual(before);
			expect(row?.created_at, table).toBeLessThanOrEqual(after);
			expect(row?.updated_at, table).toBe(row?.created_at);
		}
	});

	it("moves updated_at when a row changes and leaves created_at alone", async () => {
		const db = drizzle(database);
		const created = new Date(Date.UTC(2026, 0, 1));
		const [user] = await db
			.insert(users)
			.values({ name: "Ada", email: "ada@example.com", createdAt: created, updatedAt: created })
			.returning();
		if (!user) throw new Error("seed failed");

		const [renamed] = await db
			.update(users)
			.set({ name: "Ada L." })
			.where(eq(users.id, user.id))
			.returning();

		expect(renamed?.createdAt).toEqual(created);
		expect(renamed?.updatedAt.getTime()).toBeGreaterThan(created.getTime());
	});

	it("rejects a membership whose organisation or user does not exist", async () => {
		const { db, organisation, user } = await seedMembership();
		const missing = "01900000-0000-7000-8000-000000000000";

		await expect(
			db.insert(memberships).values({ organisationId: missing, userId: user.id }),
		).rejects.toThrow();
		await expect(
			db.insert(memberships).values({ organisationId: organisation.id, userId: missing }),
		).rejects.toThrow();
		expect(await db.select().from(memberships)).toHaveLength(1);
	});

	it("removes an organisation's memberships with the organisation", async () => {
		const { db, organisation } = await seedMembership();

		await db.delete(organisations).where(eq(organisations.id, organisation.id));

		expect(await db.select().from(memberships)).toEqual([]);
	});

	it("removes a user's memberships with the user", async () => {
		const { db, user } = await seedMembership();

		await db.delete(users).where(eq(users.id, user.id));

		expect(await db.select().from(memberships)).toEqual([]);
	});

	it("allows one membership per organisation and user", async () => {
		const { db, organisation, user } = await seedMembership();

		await expect(
			db.insert(memberships).values({ organisationId: organisation.id, userId: user.id }),
		).rejects.toThrow();
	});

	it("keeps user emails and organisation slugs unique", async () => {
		const { db } = await seedMembership();

		await expect(
			db.insert(users).values({ name: "Other Ada", email: "ada@example.com" }),
		).rejects.toThrow();
		await expect(
			db.insert(organisations).values({ name: "Other Acme", slug: "acme" }),
		).rejects.toThrow();
	});

	it("marks a new user's email as unverified", async () => {
		const { user } = await seedMembership();

		expect(user.emailVerified).toBe(false);
	});
});
