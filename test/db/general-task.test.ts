import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { row, seedOrganisation, value } from "../organisations/harness";
import { seedEntry, seedProject } from "../pages/periods-seed";

// Migration 0014 (TS-066): the entries made before tasks get a task called
// "General", put on every project of their organisation, billable unless the
// project bills nothing. From then on a new organisation starts with General,
// and a new project with the organisation's common tasks that are not archived.

const { TEST_MIGRATIONS } = env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] };
const GENERAL = TEST_MIGRATIONS.findIndex((m) => m.name.startsWith("0014_general_task"));

beforeEach(async () => {
	await reset();
	expect(GENERAL).toBeGreaterThan(0);
	// The schema as it was before tasks.
	await applyD1Migrations(env.DB, TEST_MIGRATIONS.slice(0, GENERAL));
});

async function seedUser(email: string) {
	const id = crypto.randomUUID();
	await env.DB.prepare(
		"insert into users (id, name, email, email_verified, created_at, updated_at) values (?, '', ?, 1, 0, 0)",
	)
		.bind(id, email)
		.run();
	return id;
}

describe("the entries made before tasks", () => {
	it("are given General, on every project, billable as their project bills", async () => {
		const acme = await seedOrganisation("Acme", "acme");
		const globex = await seedOrganisation("Globex", "globex");
		const ada = await seedUser("ada@example.com");
		const site = await seedProject(acme.id, "Site");
		const internal = await seedProject(acme.id, "Internal");
		await env.DB.prepare("update projects set billing_type = 'non_billable' where id = ?")
			.bind(internal)
			.run();
		const theirs = await seedProject(globex.id, "Theirs");
		const onSite = await seedEntry(
			acme.id,
			ada,
			site,
			"2026-11-02T09:00:00Z",
			"2026-11-02T10:00:00Z",
		);
		const onInternal = await seedEntry(
			acme.id,
			ada,
			internal,
			"2026-11-02T11:00:00Z",
			"2026-11-02T12:00:00Z",
		);

		await applyD1Migrations(env.DB, TEST_MIGRATIONS);

		const general = (organisationId: string) =>
			value<string>(
				"select id from tasks where organisation_id = ? and name = 'General' and common = 1 and billable_by_default = 1",
				organisationId,
			);
		const acmeGeneral = await general(acme.id);
		const globexGeneral = await general(globex.id);
		expect(acmeGeneral).toBeTruthy();
		expect(globexGeneral).toBeTruthy();
		expect(acmeGeneral).not.toBe(globexGeneral);
		expect(
			await row("select task_id, billable from project_tasks where project_id = ?", site),
		).toEqual({ task_id: acmeGeneral, billable: 1 });
		expect(
			await row("select task_id, billable from project_tasks where project_id = ?", internal),
		).toEqual({ task_id: acmeGeneral, billable: 0 });
		expect(await value("select task_id from project_tasks where project_id = ?", theirs)).toBe(
			globexGeneral,
		);
		expect(await row("select task_id, billable from time_entries where id = ?", onSite)).toEqual({
			task_id: acmeGeneral,
			billable: 1,
		});
		expect(
			await row("select task_id, billable from time_entries where id = ?", onInternal),
		).toEqual({ task_id: acmeGeneral, billable: 0 });
		expect(await value("select count(*) from time_entries where task_id is null")).toBe(0);
	});
});

describe("after the migration", () => {
	beforeEach(async () => {
		await applyD1Migrations(env.DB, TEST_MIGRATIONS);
	});

	it("gives a new organisation General", async () => {
		const acme = await seedOrganisation("Acme", "acme");
		expect(
			await row(
				"select name, name_key, common, billable_by_default, archived_at from tasks where organisation_id = ?",
				acme.id,
			),
		).toEqual({
			name: "General",
			name_key: "general",
			common: 1,
			billable_by_default: 1,
			archived_at: null,
		});
	});

	it("gives a new project the common tasks that are not archived, billable as each says", async () => {
		const acme = await seedOrganisation("Acme", "acme");
		const now = Date.now();
		const insert = (
			id: string,
			name: string,
			billable: number,
			common: number,
			archived: number | null,
		) =>
			env.DB.prepare(
				"insert into tasks (id, organisation_id, name, name_key, billable_by_default, common, archived_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
				.bind(id, acme.id, name, name.toLowerCase(), billable, common, archived, now, now)
				.run();
		await insert("t-meet", "Meetings", 0, 1, null);
		await insert("t-rare", "Rare", 1, 0, null);
		await insert("t-old", "Old", 1, 1, now);

		const site = await seedProject(acme.id, "Site");
		const tasks = await env.DB.prepare(
			"select t.name, pt.billable from project_tasks pt join tasks t on t.id = pt.task_id where pt.project_id = ? order by t.name",
		)
			.bind(site)
			.all();
		expect(tasks.results).toEqual([
			{ name: "General", billable: 1 },
			{ name: "Meetings", billable: 0 },
		]);
	});
});
