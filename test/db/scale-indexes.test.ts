import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { freshDatabase } from "./database";

// Migration 0028_scale_indexes (TS-113, D7, decision 58): a wider index on the
// day carries the start and the id, and two indexes are added, for everyone's
// entries by start and everyone's expenses by day. It only adds, so it ships
// with the code; the shorter day index stays until TS-113b takes it away. It
// applies on a fresh database and on one already migrated to 0027 with rows in
// it, and the queries it is for use the indexes it makes, the shorter one
// beside them.

const MIGRATIONS = (env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
const INDEXES = "0028_scale_indexes.sql";
const ADDED = [
	"time_entries_organisation_id_spent_on_started_at_id_idx",
	"time_entries_organisation_id_started_at_id_idx",
	"expenses_organisation_id_spent_on_id_idx",
];

async function indexNames(): Promise<string[]> {
	const { results } = await env.DB.prepare(
		"select name from sqlite_master where type = 'index' and tbl_name in ('time_entries', 'expenses')",
	).all<{ name: string }>();
	return results.map((row) => row.name);
}

async function plan(query: string, ...values: unknown[]): Promise<string> {
	const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query}`)
		.bind(...values)
		.all<{ detail: string }>();
	return results.map((row) => row.detail).join("\n");
}

describe("migration 0028", () => {
	it("applies on a fresh database", async () => {
		await freshDatabase();
		const names = await indexNames();
		for (const name of ADDED) expect(names).toContain(name);
		expect(names).toContain("time_entries_organisation_id_spent_on_idx");
	});

	it("applies on a database migrated to 0027 that holds entries and expenses, and keeps them", async () => {
		await reset();
		const at = MIGRATIONS.findIndex((m) => m.name === INDEXES);
		expect(MIGRATIONS[at - 1]?.name).toBe("0027_rules_dated.sql");
		await applyD1Migrations(env.DB, MIGRATIONS.slice(0, at));
		expect(await indexNames()).toContain("time_entries_organisation_id_spent_on_idx");

		await env.DB.batch([
			env.DB.prepare(
				"insert into organisations (id, name, slug, created_at, updated_at) values ('o', 'O', 'o', 0, 0)",
			),
			env.DB.prepare(
				"insert into users (id, name, email, email_verified, created_at, updated_at) values ('u', 'U', 'u@example.com', 1, 0, 0)",
			),
			env.DB.prepare(
				"insert into projects (id, organisation_id, name, name_key, created_at, updated_at) values ('p', 'o', 'P', 'p', 0, 0)",
			),
			env.DB.prepare(
				"insert into expense_categories (id, organisation_id, name, name_key, created_at, updated_at) values ('c', 'o', 'C', 'c', 0, 0)",
			),
			env.DB.prepare(
				"insert into time_entries (id, organisation_id, user_id, project_id, started_at, ended_at, spent_on, created_at, updated_at) values ('e', 'o', 'u', 'p', 1000, 61000, '2026-10-01', 0, 0)",
			),
			env.DB.prepare(
				"insert into expenses (id, organisation_id, user_id, project_id, category_id, spent_on, amount_minor, currency, created_at, updated_at) values ('x', 'o', 'u', 'p', 'c', '2026-10-01', 100, 'GBP', 0, 0)",
			),
		]);

		await applyD1Migrations(env.DB, MIGRATIONS.slice(0, at + 1));
		const names = await indexNames();
		for (const name of ADDED) expect(names).toContain(name);
		expect(names).toContain("time_entries_organisation_id_spent_on_idx");
		const counts = await env.DB.prepare(
			"select (select count(*) from time_entries) entries, (select count(*) from expenses) expenses",
		).first();
		expect(counts).toEqual({ entries: 1, expenses: 1 });
	});

	it("serves a report's range, its pages, the API's pages and everyone's expenses", async () => {
		await freshDatabase();
		expect(
			await plan(
				"select * from time_entries where organisation_id = ? and (spent_on, started_at, id) > (?, ?, ?) and spent_on <= ? order by spent_on, started_at, id limit 2000",
				"o",
				"2026-10-01",
				0,
				"",
				"2026-10-31",
			),
		).toContain("time_entries_organisation_id_spent_on_started_at_id_idx");
		expect(
			await plan(
				"select * from time_entries where organisation_id = ? and (started_at, id) > (?, ?) order by started_at, id limit 500",
				"o",
				0,
				"",
			),
		).toContain("time_entries_organisation_id_started_at_id_idx");
		expect(
			await plan(
				"select * from expenses where organisation_id = ? and spent_on >= ? and spent_on <= ?",
				"o",
				"2026-10-01",
				"2026-10-31",
			),
		).toContain("expenses_organisation_id_spent_on_id_idx");
	});
});
