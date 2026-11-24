import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEmail, type Mailbox } from "../auth/harness";
import { row, seedMembership } from "../organisations/harness";
import { open, type Person, pageBody, person, textOf } from "../pages/harness";

// Migration 0033_codes_and_work_model (TS-115a, decision 67) on a database
// built up to the migration before it: an organisation with Clients on becomes
// Both and one with Clients off becomes Internal work, still saying
// "Projects", and each is shown what it was shown before: the same
// navigation, the same projects under the same headings, and its clients.
// `clients_enabled` is kept as it was, and read by nothing.

const MIGRATIONS = (env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
const MIGRATION = "0033_codes_and_work_model.sql";

let mailbox: Mailbox;

beforeEach(async () => {
	await reset();
	const index = MIGRATIONS.findIndex((m) => m.name === MIGRATION);
	expect(index).toBeGreaterThan(0);
	await applyD1Migrations(env.DB, MIGRATIONS.slice(0, index));
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** An organisation as it was before 0033, with Clients on or off, and its clients and projects. */
async function seedBefore0033(slug: string, clientsEnabled: boolean) {
	const now = Date.now();
	await env.DB.batch([
		env.DB.prepare(
			"insert into organisations (id, name, slug, clients_enabled, seats, created_at, updated_at) values (?, ?, ?, ?, 100, ?, ?)",
		).bind(slug, slug, slug, clientsEnabled ? 1 : 0, now, now),
		env.DB.prepare(
			"insert into clients (id, organisation_id, name, name_key, created_at, updated_at) values (?, ?, 'Globex', 'globex', ?, ?)",
		).bind(`${slug}-globex`, slug, now, now),
		env.DB.prepare(
			"insert into projects (id, organisation_id, client_id, name, name_key, created_at, updated_at) values (?, ?, ?, 'Website', 'website', ?, ?)",
		).bind(`${slug}-website`, slug, `${slug}-globex`, now, now),
		env.DB.prepare(
			"insert into projects (id, organisation_id, name, name_key, created_at, updated_at) values (?, ?, 'Office move', 'office move', ?, ?)",
		).bind(`${slug}-move`, slug, now, now),
	]);
}

async function migrate() {
	await applyD1Migrations(env.DB, MIGRATIONS);
}

/** The labels of the main navigation's links, as read out. */
function navigationOf(html: string): string[] {
	const nav = /<nav aria-label="Main"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
	return [...nav.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map(([, inner]) =>
		textOf((inner ?? "").replace(/<span aria-hidden="true"[^>]*>[^<]*<\/span>/g, "")),
	);
}

/** The headings of the Projects page's groups, in order. */
function groupsOf(html: string): string[] {
	const main = /<main[\s\S]*<\/main>/.exec(html)?.[0] ?? "";
	return [...main.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g)].map(([, inner]) => textOf(inner ?? ""));
}

async function ownerOf(slug: string, email: string): Promise<Person> {
	const owner = await person(mailbox, email);
	await seedMembership(slug, owner.user.id, "owner");
	return owner;
}

describe("migration 0033 on a database at the migration before it", () => {
	it("makes an organisation with Clients on Both, and one with Clients off Internal work saying Projects", async () => {
		await seedBefore0033("on", true);
		await seedBefore0033("off", false);
		await migrate();
		expect(
			await row(
				"select work_model, internal_term, clients_enabled, project_code_pattern from organisations where id = 'on'",
			),
		).toEqual({
			work_model: "both",
			internal_term: "Work codes",
			clients_enabled: 1,
			project_code_pattern: null,
		});
		expect(
			await row(
				"select work_model, internal_term, clients_enabled, project_code_pattern from organisations where id = 'off'",
			),
		).toEqual({
			work_model: "internal",
			internal_term: "Projects",
			clients_enabled: 0,
			project_code_pattern: null,
		});
		// No code is given to what was there: nothing is renamed.
		expect(await row("select count(*) as n from projects where code is not null")).toEqual({
			n: 0,
		});
		expect(await row("select count(*) as n from clients where code is not null")).toEqual({ n: 0 });
	});

	it("shows the organisation that had Clients on what it was shown before", async () => {
		await seedBefore0033("on", true);
		await migrate();
		const owner = await ownerOf("on", "ada@example.com");

		const timesheet = await pageBody(await open("/app/on", owner));
		expect(navigationOf(timesheet)).toEqual(
			expect.arrayContaining(["Clients", "Projects", "Invoices", "Estimates"]),
		);
		const projects = await pageBody(await open("/app/on/projects", owner));
		expect(groupsOf(projects)).toEqual(["Globex", "No client"]);
		expect(textOf(projects)).toContain("Website");
		expect(textOf(projects)).toContain("Office move");
		expect(textOf(projects)).not.toMatch(/work codes?/i);
		expect((await open("/app/on/clients", owner)).status).toBe(200);
		expect((await open("/app/on/invoices", owner)).status).toBe(200);
		expect((await open("/app/on/estimates", owner)).status).toBe(200);
	});

	it("shows the organisation that had Clients off what it was shown before, in its words", async () => {
		await seedBefore0033("off", false);
		await migrate();
		const owner = await ownerOf("off", "grace@example.com");

		const timesheet = await pageBody(await open("/app/off", owner));
		const links = navigationOf(timesheet);
		expect(links).toContain("Projects");
		for (const gone of ["Clients", "Invoices", "Estimates"]) expect(links).not.toContain(gone);
		const projects = await pageBody(await open("/app/off/projects", owner));
		const text = textOf(projects);
		expect(text).toContain("Projects");
		expect(text).toContain("Website");
		expect(text).toContain("Office move");
		// Clients off showed no client and no groups; Internal work shows none either.
		expect(text).not.toContain("Globex");
		expect(groupsOf(projects)).toEqual([]);
		expect(text).not.toMatch(/work codes?/i);
		for (const gone of ["clients", "invoices", "estimates"]) {
			expect((await open(`/app/off/${gone}`, owner)).status, gone).toBe(404);
		}
	});
});
