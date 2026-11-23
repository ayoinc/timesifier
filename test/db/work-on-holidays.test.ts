import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

// Migration 0029_work_on_holidays (TS-111e, decision 52) rebuilds
// work_requests so its kind may be `holiday`. It ships alone, ahead of the
// code that writes that kind, so the Worker already running must find the
// table as it was: the same columns, indexes and triggers, and every row. The
// schema is built up to the migration before it, requests of every kind and
// status are written, then the rebuild runs and the table is compared.

const MIGRATIONS = (env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
const REBUILD = "0029_work_on_holidays.sql";

const indexOfRebuild = () => MIGRATIONS.findIndex((m) => m.name === REBUILD);

beforeEach(async () => {
	await reset();
	expect(indexOfRebuild()).toBeGreaterThan(0);
	await applyD1Migrations(env.DB, MIGRATIONS.slice(0, indexOfRebuild()));
});

async function rebuild() {
	await applyD1Migrations(env.DB, MIGRATIONS.slice(0, indexOfRebuild() + 1));
}

/** Two organisations, each with two members, the people's requests between them. */
async function seed() {
	const statements: D1PreparedStatement[] = [];
	for (const org of ["acme", "kiwi"]) {
		statements.push(
			env.DB.prepare(
				"insert into organisations (id, name, slug, created_at, updated_at) values (?, ?, ?, 0, 0)",
			).bind(org, org, org),
		);
		for (const person of ["grace", "mona"]) {
			const userId = `${org}-${person}`;
			statements.push(
				env.DB.prepare(
					"insert into users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 1, 0, 0)",
				).bind(userId, userId, `${userId}@example.com`),
				env.DB.prepare(
					"insert into memberships (id, organisation_id, user_id, role, created_at, updated_at) values (?, ?, ?, 'member', 0, 0)",
				).bind(`m-${userId}`, org, userId),
			);
		}
	}
	const kinds = ["overtime", "weekend"];
	const statuses = ["pending", "approved", "refused", "withdrawn", "cancelled"];
	let n = 0;
	for (const org of ["acme", "kiwi"]) {
		for (const kind of kinds) {
			for (const status of statuses) {
				n += 1;
				const decided = status === "pending" ? null : `${org}-mona`;
				statements.push(
					env.DB.prepare(
						"insert into work_requests (id, organisation_id, user_id, kind, starts_on, ends_on, minutes_per_day, reason, status, decided_by, decided_at, comment, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					).bind(
						`w${n}`,
						org,
						`${org}-grace`,
						kind,
						"2026-12-05",
						n % 2 === 0 ? "2026-12-06" : "2026-12-05",
						30 * n,
						n % 3 === 0 ? null : `Reason ${n}`,
						status,
						decided,
						decided ? 1_700_000_000_000 + n : null,
						decided ? `Comment ${n}` : null,
						1_600_000_000_000 + n,
						1_650_000_000_000 + n,
					),
				);
			}
		}
	}
	await env.DB.batch(statements);
	return n;
}

const rowsOf = async () =>
	(await env.DB.prepare("select * from work_requests order by id").all()).results;

/** The table's columns, and every index and trigger on it, as SQLite keeps them. */
async function shapeOf() {
	const columns = (await env.DB.prepare("pragma table_info(work_requests)").all()).results;
	const attached = (
		await env.DB.prepare(
			"select type, name, sql from sqlite_master where tbl_name = 'work_requests' and type in ('index', 'trigger') order by type, name",
		).all()
	).results;
	return { columns, attached };
}

function request(id: string, kind: string) {
	return env.DB.prepare(
		"insert into work_requests (id, organisation_id, user_id, kind, starts_on, ends_on, minutes_per_day, status, created_at, updated_at) values (?, 'acme', 'acme-grace', ?, '2026-12-25', '2026-12-25', 240, 'pending', 0, 0)",
	).bind(id, kind);
}

describe("the rebuild of work_requests for work on a public holiday", () => {
	it("keeps every row, column, index and trigger the running Worker reads", async () => {
		const count = await seed();
		const rows = await rowsOf();
		const shape = await shapeOf();
		expect(rows).toHaveLength(count);
		expect(shape.attached.map((a) => a.name)).toEqual([
			"sqlite_autoindex_work_requests_1",
			"work_requests_organisation_id_id_unique",
			"work_requests_organisation_id_status_starts_on_idx",
			"work_requests_organisation_id_user_id_starts_on_idx",
		]);

		await rebuild();

		expect(await rowsOf()).toEqual(rows);
		expect(await shapeOf()).toEqual(shape);
		const leftOver = await env.DB.prepare(
			"select count(*) as n from sqlite_master where name like '__new_%'",
		).first<{ n: number }>();
		expect(leftOver?.n).toBe(0);
		const { results: broken } = await env.DB.prepare("pragma foreign_key_check").all();
		expect(broken).toEqual([]);
	});

	it("takes kind 'holiday' after it, and still refuses a kind it does not know", async () => {
		await seed();
		await expect(request("before", "holiday").run()).rejects.toThrow(/CHECK constraint failed/);
		await rebuild();
		await request("after", "holiday").run();
		await expect(request("unknown", "party").run()).rejects.toThrow(/CHECK constraint failed/);
		// The rest of the table's rules hold as before: an organisation deleted takes its requests.
		await env.DB.prepare("delete from organisations where id = 'kiwi'").run();
		const left = await env.DB.prepare(
			"select count(*) as n from work_requests where organisation_id = 'kiwi'",
		).first<{ n: number }>();
		expect(left?.n).toBe(0);
	});
});
