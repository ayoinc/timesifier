import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { type OrganisationScope, organisationScope } from "~/db";
import { NOT_ALLOWED } from "~/organisations/problems";
import { copyName } from "~/projects/projects";
import { destinationPath } from "~/shell/destinations";
import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, seedMembership, value } from "../organisations/harness";
import { open, type Person, pageBody, person, submit, textOf } from "./harness";
import { type Kind, seedRoles } from "./roles-seed";

// Duplicate a project (TS-122, S2-06): a copy of its client, settings,
// budget and lines, tasks, tags and rates, under a new name, with none of
// its time, expenses or dates; owners and admins make one, as no other role
// sees all that is copied (decision 65), and the log says what it was
// duplicated from.

const ACME = "acme";
const PROJECTS = destinationPath(ACME, "projects");

let acme: { id: string };
let scope: OrganisationScope;
let people: Record<Kind | "contractor" | "stranger", Person>;
let site: string;

beforeEach(async () => {
	await freshDatabase();
	const mailbox = captureEmail();
	const seeded = await seedRoles(mailbox);
	acme = seeded.acme;
	scope = organisationScope(env.DB, acme.id);
	const contractor = await person(mailbox, "ida@example.com");
	await seedMembership(acme.id, contractor.user.id, "member");
	await env.DB.prepare("update memberships set is_contractor = 1 where user_id = ?")
		.bind(contractor.user.id)
		.run();
	const stranger = await person(mailbox, "mallory@example.com");
	await createOrganisation(stranger.cookie, "Globex");
	people = { ...seeded.people, contractor, stranger };

	const [client] = await scope.clients.insert({ name: "Wayne", nameKey: "wayne" });
	const [design, build] = await scope.tasks.insert([
		{ name: "Design", nameKey: "design", billableByDefault: true },
		{ name: "Build", nameKey: "build", billableByDefault: true },
	]);
	const [tag] = await scope.tags.insert({ name: "Retainer", nameKey: "retainer" });
	if (!client || !design || !build || !tag) throw new Error("seed failed");
	const [project] = await scope.projects.insert({
		name: "Site",
		nameKey: "site",
		clientId: client.id,
		billingType: "hourly",
		rateMode: "task",
		currency: "EUR",
		startsOn: "2026-01-01",
		endsOn: "2026-12-31",
		budgetKind: "task_hours",
		budgetResetsMonthly: true,
		budgetAlertPercent: 70,
		budgetWarnMembers: true,
		overtimeRateMilli: 1500,
	});
	if (!project) throw new Error("seed failed");
	site = project.id;
	await scope.projectTasks.insert([
		{ projectId: site, taskId: design.id, billable: true },
		{ projectId: site, taskId: build.id, billable: false },
	]);
	await scope.projectTags.insert({ projectId: site, tagId: tag.id });
	await scope.budgetLines.insert([
		{ projectId: site, taskId: design.id, amount: 600 },
		{ projectId: site, taskId: build.id, amount: 1200 },
	]);
	await scope.rates.insert([
		{
			kind: "billable",
			projectId: site,
			taskId: design.id,
			amountMinor: 9_000,
			currency: "EUR",
			effectiveFrom: "2026-01-01",
		},
		{
			kind: "billable",
			projectId: site,
			taskId: design.id,
			amountMinor: 9_500,
			currency: "EUR",
			effectiveFrom: "2026-06-01",
		},
		{
			kind: "cost",
			projectId: site,
			userId: people.member.user.id,
			amountMinor: 4_000,
			currency: "EUR",
			effectiveFrom: "2026-01-01",
		},
	]);
	await scope.timeEntries.insert({
		userId: people.member.user.id,
		projectId: site,
		taskId: design.id,
		billable: true,
		description: null,
		startedAt: new Date("2026-11-02T09:00:00Z"),
		spentOn: "2026-11-02",
		endedAt: new Date("2026-11-02T11:00:00Z"),
	});
	const [category] = await scope.expenseCategories.insert({ name: "Taxis", nameKey: "taxis" });
	if (!category) throw new Error("seed failed");
	await scope.expenses.insert({
		userId: people.member.user.id,
		projectId: site,
		categoryId: category.id,
		spentOn: "2026-11-02",
		amountMinor: 25_00,
		currency: "EUR",
	});
}, 60_000);

async function duplicate(who: Person, fields: Record<string, string>) {
	const response = await submit(PROJECTS, { intent: "duplicate", ...fields }, who, {
		byScript: true,
	});
	return { status: response.status, said: await response.text() };
}

const copyId = () =>
	value<string>(
		"select id from projects where organisation_id = ? and name = 'Site (copy)'",
		acme.id,
	);

describe("duplicating a project", () => {
	it("copies its client, settings, budget, tasks, tags and rates, and none of its time, expenses or dates", async () => {
		const { status, said } = await duplicate(people.owner, {
			projectId: site,
			name: "Site (copy)",
		});
		expect(status).toBe(200);
		expect(said).toContain("Project duplicated: Site (copy).");
		const copy = (await copyId()) as string;
		expect(copy).toBeTruthy();

		const shape = (id: string) =>
			env.DB.prepare(
				`select client_id, billing_type, rate_mode, fee_minor, currency, budget_kind, budget_amount,
				budget_resets_monthly, budget_alert_percent, budget_warn_members, budget_includes_expenses,
				overtime_rate_milli, starts_on, ends_on, archived_at from projects where id = ?`,
			)
				.bind(id)
				.first<Record<string, unknown>>();
		const [from, to] = [await shape(site), await shape(copy)];
		expect(to).toEqual({ ...from, starts_on: null, ends_on: null });

		const rows = async (sql: string, id: string) =>
			(await env.DB.prepare(sql).bind(id).all()).results.map((r) => JSON.stringify(r));
		for (const sql of [
			"select task_id, billable from project_tasks where project_id = ? order by task_id",
			"select tag_id from project_tags where project_id = ?",
			"select task_id, user_id, amount from budget_lines where project_id = ? order by amount",
			`select kind, user_id, task_id, amount_minor, currency, effective_from from rates
				where project_id = ? order by kind, effective_from, amount_minor`,
		]) {
			const source = await rows(sql, site);
			expect(source.length, sql).toBeGreaterThan(0);
			expect(await rows(sql, copy), sql).toEqual(source);
		}
		for (const table of ["time_entries", "expenses"]) {
			expect(await value(`select count(*) from ${table} where project_id = ?`, copy), table).toBe(
				0,
			);
			expect(await value(`select count(*) from ${table} where project_id = ?`, site), table).toBe(
				1,
			);
		}
	});

	it("is in the activity log as a project created, duplicated from its source", async () => {
		await duplicate(people.admin, { projectId: site, name: "Site (copy)" });
		const copy = (await copyId()) as string;
		const summary = await value<string>(
			"select summary from activity_records where action = 'project.created' and subject_id = ?",
			copy,
		);
		expect(JSON.parse(summary ?? "{}").after).toMatchObject({
			name: "Site (copy)",
			duplicatedFromId: site,
		});
		const log = textOf(await pageBody(await open(`/app/${ACME}/activity`, people.owner)));
		expect(log).toContain("Created project Site (copy)");
		expect(log).toContain("Duplicated from: Site");
	});

	it("refuses a name another project has, and makes nothing", async () => {
		const { status, said } = await duplicate(people.owner, { projectId: site, name: "site" });
		expect(status).toBe(400);
		expect(said).toContain("A project with this name already exists.");
		expect(await value("select count(*) from projects")).toBe(1);
	});

	it("a project of another organisation is no project here: 404, and nothing is made", async () => {
		const globex = await value<string>("select id from organisations where slug <> ?", ACME);
		const [theirs] = await organisationScope(env.DB, globex as string).projects.insert({
			name: "Secret",
			nameKey: "secret",
		});
		const { status } = await duplicate(people.owner, {
			projectId: theirs?.id ?? "",
			name: "Secret (copy)",
		});
		expect(status).toBe(404);
		expect(await value("select count(*) from projects where name = 'Secret (copy)'")).toBe(0);
	});
});

describe.each(["owner", "admin"] as const)("to the %s", (kind) => {
	it("the project's page offers Duplicate in its Actions, and the copy is made", async () => {
		const page = await pageBody(await open(`${PROJECTS}/${site}`, people[kind]));
		expect(page).toContain('aria-label="Actions for Site"');
		expect(page).toContain("Site (copy)");
		const { status } = await duplicate(people[kind], { projectId: site, name: "Site (copy)" });
		expect(status).toBe(200);
		expect(await copyId()).toBeTruthy();
	});
});

describe.each(["finance", "manager", "member", "contractor"] as const)("to the %s", (kind) => {
	it("the project's page offers no Duplicate, and a duplicate is refused and makes nothing", async () => {
		const page = await pageBody(await open(`${PROJECTS}/${site}`, people[kind]));
		expect(page).not.toContain('aria-label="Actions for Site"');
		expect(page).not.toContain("Site (copy)");
		const { status, said } = await duplicate(people[kind], {
			projectId: site,
			name: "Site (copy)",
		});
		expect(status).toBe(403);
		expect(said).toContain(NOT_ALLOWED);
		expect(await copyId()).toBeNull();
	});
});

describe("to a stranger", () => {
	it("Projects is not there, and a duplicate makes nothing", async () => {
		expect((await open(PROJECTS, people.stranger)).status).toBe(404);
		const { status } = await duplicate(people.stranger, { projectId: site, name: "Site (copy)" });
		expect(status).toBe(404);
		expect(await copyId()).toBeNull();
	});
});

describe("the name a copy is offered", () => {
	it("is the name with (copy), then (copy 2) and on while one is taken", () => {
		expect(copyName("Site", new Set())).toBe("Site (copy)");
		expect(copyName("Site", new Set(["site (copy)"]))).toBe("Site (copy 2)");
		expect(copyName("Site", new Set(["site (copy)", "site (copy 2)"]))).toBe("Site (copy 3)");
	});

	it("is offered on the project's page", async () => {
		await duplicate(people.owner, { projectId: site, name: "Site (copy)" });
		const page = await pageBody(await open(`${PROJECTS}/${site}`, people.owner));
		expect(page).toContain("Site (copy 2)");
	});
});
