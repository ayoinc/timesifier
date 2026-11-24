import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEmail, type Mailbox } from "../auth/harness";
import { row, seedMembership } from "../organisations/harness";
import { open, type Person, pageBody, person, textOf } from "../pages/harness";

// Migration 0033_codes_and_work_model (TS-115a, decision 67) on a database
// built up to the migration before it. The owner's decision 8
// (research/projects-model.md) promised that nothing an organisation sees
// changes: one with Clients on becomes Client projects, where a project with
// no client stays under "No client", whether it bills or not; one with Clients
// off becomes Internal work, still saying "Projects". `clients_enabled` is
// kept as it was, and read by nothing.
//
// BEFORE is what each was shown before the migration: the same seed, rendered
// by main at 94d2a50 (the code before TS-115a, which read `clients_enabled`)
// with the same helpers below; Clients off hid Clients alone, whether or not
// the organisation held an invoice or an estimate. Each test renders the
// migrated organisation and expects exactly that, with one difference,
// recorded in decision 67: an organisation with Clients off that holds no
// invoice and no estimate is no longer shown the empty Invoices and Estimates.

const MIGRATIONS = (env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
const MIGRATION = "0033_codes_and_work_model.sql";

/** The main navigation's links with Clients on: the bar's, then the same again in its More menu. */
const NAVIGATION_ON = [
	"Timesheet",
	"Time off",
	"Expenses",
	...["Team", "Clients", "Projects", "Tasks", "Invoices", "Estimates", "Approvals", "Reports"],
	...["Dashboards", "Activity log", "Integrations", "Workspace settings"],
	...["Team", "Clients", "Tasks", "Invoices", "Estimates", "Approvals", "Reports"],
	...["Dashboards", "Activity log", "Integrations", "Workspace settings"],
];

/** What the owner was shown before 0033: the navigation, the Projects page's groups, which pages answer. */
const BEFORE = {
	on: {
		navigation: NAVIGATION_ON,
		groups: ["Globex", "No client"],
		reached: { clients: 200, invoices: 200, estimates: 200 },
	},
	// Clients off hid Clients alone: Invoices and Estimates stayed.
	off: {
		navigation: NAVIGATION_ON.filter((label) => label !== "Clients"),
		groups: [],
		reached: { clients: 404, invoices: 200, estimates: 200 },
	},
};

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

/**
 * An organisation as it was before 0033, with Clients on or off: a client's
 * project, and two with no client, one billing by the hour and one billing
 * nothing (which Both would have moved under its work codes); and, if asked,
 * an invoice or an estimate for its client.
 */
async function seedBefore0033(
	slug: string,
	clientsEnabled: boolean,
	holds: "invoice" | "estimate" | null = null,
) {
	const now = Date.now();
	const held =
		holds === "invoice"
			? env.DB.prepare(
					"insert into invoices (id, organisation_id, number, client_id, currency, issued_on, due_on, created_at, updated_at) values (?, ?, '1', ?, 'GBP', '2026-11-02', '2026-12-02', ?, ?)",
				).bind(`${slug}-invoice`, slug, `${slug}-globex`, now, now)
			: holds === "estimate"
				? env.DB.prepare(
						"insert into estimates (id, organisation_id, number, client_id, currency, issued_on, created_at, updated_at) values (?, ?, '1', ?, 'GBP', '2026-11-02', ?, ?)",
					).bind(`${slug}-estimate`, slug, `${slug}-globex`, now, now)
				: null;
	const project = env.DB.prepare(
		"insert into projects (id, organisation_id, client_id, name, name_key, billing_type, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
	);
	await env.DB.batch([
		env.DB.prepare(
			"insert into organisations (id, name, slug, clients_enabled, seats, created_at, updated_at) values (?, ?, ?, ?, 100, ?, ?)",
		).bind(slug, slug, slug, clientsEnabled ? 1 : 0, now, now),
		env.DB.prepare(
			"insert into clients (id, organisation_id, name, name_key, created_at, updated_at) values (?, ?, 'Globex', 'globex', ?, ?)",
		).bind(`${slug}-globex`, slug, now, now),
		project.bind(
			`${slug}-website`,
			slug,
			`${slug}-globex`,
			"Website",
			"website",
			"hourly",
			now,
			now,
		),
		project.bind(`${slug}-pitch`, slug, null, "Pitch", "pitch", "hourly", now, now),
		project.bind(
			`${slug}-move`,
			slug,
			null,
			"Office move",
			"office move",
			"non_billable",
			now,
			now,
		),
		...(held ? [held] : []),
	]);
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

/** What the organisation's owner is shown: its navigation, its projects' groups, and which pages answer. */
async function shown(slug: string, email: string) {
	const owner: Person = await person(mailbox, email);
	await seedMembership(slug, owner.user.id, "owner");
	const projects = await pageBody(await open(`/app/${slug}/projects`, owner));
	const status = async (page: string) => (await open(`/app/${slug}/${page}`, owner)).status;
	return {
		navigation: navigationOf(await pageBody(await open(`/app/${slug}`, owner))),
		groups: groupsOf(projects),
		reached: {
			clients: await status("clients"),
			invoices: await status("invoices"),
			estimates: await status("estimates"),
		},
		text: textOf(projects),
	};
}

describe("migration 0033 on a database at the migration before it", () => {
	it("makes an organisation with Clients on Client projects, and one with Clients off Internal work saying Projects", async () => {
		await seedBefore0033("on", true);
		await seedBefore0033("off", false);
		await applyD1Migrations(env.DB, MIGRATIONS);
		const settings = (id: string) =>
			row(
				`select work_model, internal_term, clients_enabled, project_code_pattern from organisations where id = '${id}'`,
			);
		expect(await settings("on")).toEqual({
			work_model: "client_projects",
			internal_term: "Work codes",
			clients_enabled: 1,
			project_code_pattern: null,
		});
		expect(await settings("off")).toEqual({
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

	it("shows the organisation that had Clients on exactly what it was shown before", async () => {
		await seedBefore0033("on", true);
		await applyD1Migrations(env.DB, MIGRATIONS);
		const { text, ...after } = await shown("on", "ada@example.com");
		expect(after).toEqual(BEFORE.on);
		// Both no-client projects, billable or not, stay under No client: no work codes.
		for (const name of ["Website", "Pitch", "Office move"]) expect(text).toContain(name);
		expect(text).not.toMatch(/work codes?/i);
	});

	it.each(["invoice", "estimate"] as const)(
		"shows the organisation that had Clients off and holds an %s exactly what it was shown before",
		async (holds) => {
			await seedBefore0033("off", false, holds);
			await applyD1Migrations(env.DB, MIGRATIONS);
			const { text, ...after } = await shown("off", "grace@example.com");
			expect(after).toEqual(BEFORE.off);
			for (const name of ["Website", "Pitch", "Office move"]) expect(text).toContain(name);
			expect(text).not.toContain("Globex");
			expect(text).not.toMatch(/work codes?/i);
		},
	);

	it("shows the organisation that had Clients off and holds none what it was shown before, but the empty Invoices and Estimates", async () => {
		await seedBefore0033("off", false);
		await applyD1Migrations(env.DB, MIGRATIONS);
		const { text, ...after } = await shown("off", "grace@example.com");
		const billing = ["Invoices", "Estimates"];
		expect(after).toEqual({
			...BEFORE.off,
			navigation: BEFORE.off.navigation.filter((label) => !billing.includes(label)),
			reached: { ...BEFORE.off.reached, invoices: 404, estimates: 404 },
		});
		for (const name of ["Website", "Pitch", "Office move"]) expect(text).toContain(name);
		expect(text).not.toMatch(/work codes?/i);
	});
});
