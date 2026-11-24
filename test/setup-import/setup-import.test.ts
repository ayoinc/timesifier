import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "~/db";
import {
	decideSetup,
	readSetupFile,
	SETUP_MAX_ROWS,
	type SetupKnown,
	type SetupOutcome,
	type SetupRow,
	stretchKey,
} from "~/setup-import/setup";
import { captureEmail, type Mailbox, ORIGIN } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { accept, row, seedInvitation, value } from "../organisations/harness";
import { open, type Person, pageBody, person, submit, textOf } from "../pages/harness";
import { seedEntry } from "../pages/periods-seed";
import { type Roles, seedRoles } from "../pages/roles-seed";

// The set-up import (TS-115d, docs/decisions.md entry 77): projects, work
// packages and assignments from one CSV with a Kind column. Reading the file,
// codes resolved within it whatever the order of its rows, duplicates against
// what exists whatever their case, people who are members or invited, the
// dry run, one batch for the import, assignments waiting for invited people
// and applied when they join, the revert and when it is refused, a 500-row
// file, and who may do any of it.

const IMPORT = "/app/acme/projects/import";
const PROJECTS = "/app/acme/projects";

// ── Reading and deciding, without the database ──────────────────────────────

/** The rows of `text`, which must read. */
function rowsOf(text: string): SetupRow[] {
	const read = readSetupFile(text);
	if (!read.ok) throw new Error(read.problem);
	return read.rows;
}

const HEADER = "Kind,Client code,Project code,Code,Name,Starts,Ends,Billing,Budget,Email,Role";

const KNOWN: SetupKnown = {
	workModel: "client_projects",
	workCode: "work code",
	currency: "GBP",
	today: "2026-12-01",
	clients: new Map([
		["acme", { id: "c1", code: "ACME", archived: false, currency: null }],
		["old", { id: "c2", code: "OLD", archived: true, currency: null }],
		["euro", { id: "c3", code: "EURO", archived: false, currency: "EUR" }],
	]),
	projects: new Map([
		[
			"acme-001",
			{ id: "p1", code: "ACME-001", name: "Website", archived: false, currency: "GBP", billable: true },
		],
		[
			"acme-000",
			{ id: "p0", code: "ACME-000", name: "Old site", archived: true, currency: "GBP", billable: true },
		],
	]),
	projectNames: new Set(["website", "old site"]),
	workPackages: new Map([["p1", new Set(["wp1"])]]),
	members: new Map([
		["linus@example.com", "u1"],
		["hedy@example.com", "u2"],
	]),
	invited: new Map([["new@x.example", "i1"]]),
	stretches: new Map([
		[stretchKey("p1", { userId: "u1" }), [{ startsOn: "2026-01-01", endsOn: "2026-06-30" }]],
	]),
};

const decided = (text: string, known = KNOWN) => decideSetup(rowsOf(`${HEADER}\n${text}`), known);

/** Each row's problems, by line, or "ok". */
function problemsOf(outcomes: SetupOutcome[]) {
	return Object.fromEntries(
		outcomes.map((o) => [o.line, o.ok ? "ok" : o.problems.join(" ")] as const),
	);
}

describe("reading a set-up file", () => {
	it("reads quoted commas, a byte order mark, any order of columns and any case, and names the columns it does not read", () => {
		const read = readSetupFile(
			'\uFEFFproject code,KIND,Name,Notes,starts on\nACME-002,Project,"Brand, and site",ignored,2027-01-04\r\n,,,,\nACME-002,work package,"Discovery, phase 1",x,\n',
		);
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.read).toEqual(["kind", "project_code", "name", "starts"]);
		expect(read.unknown).toEqual(["Notes"]);
		expect(read.rows).toHaveLength(2);
		expect(read.rows[0]).toMatchObject({
			line: 2,
			kind: "Project",
			project_code: "ACME-002",
			name: "Brand, and site",
			starts: "2027-01-04",
			email: "",
		});
		expect(read.rows[1]).toMatchObject({ line: 4, name: "Discovery, phase 1" });
	});

	it("refuses a file with no Kind or Project code column, an unclosed quote, no rows, or too many", () => {
		expect(readSetupFile("Project code,Name\nA,B\n")).toEqual({
			ok: false,
			problem: expect.stringContaining("no Kind column"),
		});
		expect(readSetupFile("Kind,Name\nProject,B\n")).toEqual({
			ok: false,
			problem: expect.stringContaining("no Project code column"),
		});
		expect(readSetupFile('Kind,Project code\nProject,"A\n')).toEqual({
			ok: false,
			problem: "A quoted field in the file is never closed.",
		});
		expect(readSetupFile("Kind,Project code\n").ok).toBe(false);
		const many = Array.from({ length: SETUP_MAX_ROWS + 1 }, (_, i) => `Project,P${i}`);
		expect(readSetupFile(["Kind,Project code", ...many].join("\n"))).toEqual({
			ok: false,
			problem: `A file can hold at most ${SETUP_MAX_ROWS} rows. Split it.`,
		});
	});
});

describe("deciding each row", () => {
	it("resolves codes within the same file, whatever the order of its rows", () => {
		const outcomes = decided(
			[
				// The assignment and the work package come before their project's row.
				"Assignment,,acme-002,,,2027-01-04,,,,linus@example.com,Delivery manager",
				"Work package,,Acme-002,WP1,Discovery,,,,120h,,",
				"Project,ACME,ACME-002,,Brand,2027-01-04,2027-06-30,Fixed fee,,,",
				// A work package of a project the organisation has, whatever the case of its code.
				"Work package,,acme-001,WP2,Build,,,,£5000,,",
			].join("\n"),
		);
		expect(problemsOf(outcomes)).toEqual({ 2: "ok", 3: "ok", 4: "ok", 5: "ok" });
		const [assignment, wp, project, existing] = outcomes;
		expect(assignment).toMatchObject({
			kind: "assignment",
			plan: {
				project: { existing: false, code: "ACME-002", line: 4 },
				who: { userId: "u1" },
				role: "delivery_manager",
				startsOn: "2027-01-04",
				endsOn: null,
			},
		});
		expect(wp).toMatchObject({
			kind: "work_package",
			plan: { project: { existing: false, line: 4 }, budget: { kind: "hours", amount: 7200 } },
		});
		expect(project).toMatchObject({
			kind: "project",
			plan: { code: "ACME-002", client: { id: "c1" }, billing: "fixed_fee", workCode: false },
		});
		expect(existing).toMatchObject({
			plan: {
				project: { existing: true, id: "p1" },
				budget: { kind: "fees", amount: 500000 },
				currency: "GBP",
			},
		});
	});

	it("refuses duplicates of existing codes and names whatever their case, and repeats within the file", () => {
		expect(
			problemsOf(
				decided(
					[
						"Project,,acme-001,,New name,,,,,,",
						"Project,,ACME-003,,WEBSITE,,,,,,",
						"Project,,ACME-004,,Brand,,,,,,",
						"Project,,acme-004,,Other,,,,,,",
						"Project,,ACME-005,,brand,,,,,,",
						"Work package,,ACME-001,wp1,Again,,,,,,",
						"Work package,,ACME-004,WP1,One,,,,,,",
						"Work package,,acme-004,wp1,Two,,,,,,",
					].join("\n"),
				),
			),
		).toEqual({
			2: "A project with the code acme-001 already exists.",
			3: "A project called “WEBSITE” already exists.",
			4: "ok",
			5: "The same project code is on line 4.",
			6: "The same name is on line 4.",
			7: "ACME-001 already has a work package with the code wp1.",
			8: "ok",
			9: "The same work package code is on line 8.",
		});
	});

	it("says why a row is not added: a project not found, archived, or whose own row is not added", () => {
		expect(
			problemsOf(
				decided(
					[
						"Project,,ACME-006,,,,,,,,",
						"Work package,,ACME-006,WP1,One,,,,,,",
						"Work package,,NOPE-1,WP1,One,,,,,,",
						"Assignment,,ACME-000,,,,,,,linus@example.com,",
						"Thing,,ACME-001,,,,,,,,",
						",,ACME-001,,,,,,,,",
					].join("\n"),
				),
			),
		).toEqual({
			2: "It has no name.",
			3: "Its project, on line 2, is not imported.",
			4: "No project has the code NOPE-1, here or in this file.",
			5: "The project ACME-000 is archived.",
			6: "“Thing” is not a kind. Write Project, Work package or Assignment.",
			7: "It has no kind. Write Project, Work package or Assignment.",
		});
	});

	it("puts members and invited people on teams, refuses anyone else, reads roles and dates, and refuses overlaps", () => {
		const outcomes = decided(
			[
				"Assignment,,ACME-001,,,2026-07-01,,,,Linus@Example.com,member",
				"Assignment,,ACME-001,,,,,,,new@x.example,",
				"Assignment,,ACME-001,,,2026-03-01,2026-03-31,,,linus@example.com,",
				"Assignment,,ACME-001,,,2026-08-01,2026-08-31,,,linus@example.com,",
				"Assignment,,ACME-001,,,,,,,stranger@x.example,",
				"Assignment,,ACME-001,,,,,,,hedy@example.com,Boss",
				"Assignment,,ACME-001,,,2027-02-01,2027-01-01,,,hedy@example.com,",
				"Assignment,,ACME-001,,,01/02/2027,,,,hedy@example.com,",
				"Assignment,,ACME-001,,,2027-01-01,,,,not-an-address,",
			].join("\n"),
		);
		expect(problemsOf(outcomes)).toEqual({
			2: "ok",
			3: "ok",
			4: "linus@example.com is already on ACME-001's team on some of those days.",
			5: "Line 2 puts linus@example.com on ACME-001's team on some of those days.",
			6: "Nobody in this organisation or invited to it has the address stranger@x.example. Invite them first.",
			7: "“Boss” is not a team role. Write Member or Delivery manager.",
			8: "It ends before it starts.",
			9: "“01/02/2027” is not a date. Write it as 2026-12-01.",
			10: "“not-an-address” is not an email address.",
		});
		expect(outcomes[1]).toMatchObject({
			ok: true,
			plan: { who: { invitationId: "i1" }, startsOn: "2026-12-01", startsToday: true, role: "member" },
		});
	});

	it("applies the organisation's clients, work codes, billing and budgets", () => {
		expect(
			problemsOf(
				decided(
					[
						"Project,NOPE,P-1,,One,,,,,,",
						"Project,OLD,P-2,,Two,,,,,,",
						"Project,EURO,P-3,,Three,,,Weekly,,,",
						"Work package,,P-3,WP1,Fees,,,,5000 EUR,,",
						"Work package,,P-3,WP2,Wrong,,,,5000 GBP,,",
						"Work package,,P-3,WP3,Plain,,,,5000,,",
					].join("\n"),
				),
			),
		).toEqual({
			2: "No client has the code NOPE. Add it, or its code, on Clients first.",
			3: "The client OLD is archived.",
			4: "“Weekly” is not a way of billing. Write Hourly, Fixed fee or Non-billable.",
			5: "Its project, on line 4, is not imported.",
			6: "Its project, on line 4, is not imported.",
			7: "Its project, on line 4, is not imported.",
		});
		const euro = decided(
			[
				"Project,EURO,P-3,,Three,,,,,,",
				"Work package,,P-3,WP1,Fees,,,,EUR 5000.50,,",
				"Work package,,P-3,WP2,Wrong,,,,5000 GBP,,",
				"Work package,,P-3,WP3,Plain,,,,5000,,",
			].join("\n"),
		);
		expect(problemsOf(euro)).toMatchObject({
			2: "ok",
			3: "ok",
			4: "“5000 GBP” is not a budget. Write hours, such as 120h, or fees in the project's currency, such as 5000 EUR.",
			5: "“5000” is not a budget. Write hours, such as 120h, or fees in the project's currency, such as 5000 EUR.",
		});
		expect(euro[1]).toMatchObject({ plan: { budget: { kind: "fees", amount: 500050 } } });

		// Under internal work there are no clients; under Both a project with none is a work code.
		expect(
			problemsOf(decided("Project,ACME,P-4,,Four,,,,,,", { ...KNOWN, workModel: "internal" })),
		).toEqual({ 2: "This organisation has no clients. Leave Client code empty." });
		const both = decided(
			["Project,,P-5,,Five,,,Hourly,,,", "Project,,P-6,,Six,,,,,,"].join("\n"),
			{ ...KNOWN, workModel: "both" },
		);
		expect(problemsOf(both)).toEqual({
			2: "A project with no client is a work code here, and bills nothing. Leave Billing empty, or name its client.",
			3: "ok",
		});
		expect(both[1]).toMatchObject({ plan: { workCode: true, billing: "non_billable" } });
	});
});

// ── Through the Worker ──────────────────────────────────────────────────────

let mailbox: Mailbox;
let roles: Roles;
let acme: Roles["acme"];
let clientId: string;
let website: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	roles = await seedRoles(mailbox);
	acme = roles.acme;
	const now = Date.now();
	clientId = uuidv7();
	website = uuidv7();
	await env.DB.batch([
		env.DB.prepare(
			"insert into clients (id, organisation_id, name, name_key, code, code_key, created_at, updated_at) values (?, ?, 'Acme Corp', 'acme corp', 'ACME', 'acme', ?, ?)",
		).bind(clientId, acme.id, now, now),
		env.DB.prepare(
			"insert into projects (id, organisation_id, name, name_key, client_id, code, code_key, created_at, updated_at) values (?, ?, 'Website', 'website', ?, 'ACME-001', 'acme-001', ?, ?)",
		).bind(website, acme.id, clientId, now, now),
	]);
}, 60_000);

afterEach(() => {
	vi.restoreAllMocks();
});

const count = (sql: string, ...values: unknown[]) => value<number>(sql, ...values);

/** Uploads `text` as a CSV file to the set-up import, as the page's form does. */
async function upload(who: Person, text: string, name = "setup.csv") {
	const body = new FormData();
	body.set("intent", "upload");
	body.set("file", new File([text], name, { type: "text/csv" }));
	return exports.default.fetch(
		new Request(`${ORIGIN}${IMPORT}`, {
			method: "POST",
			headers: { Cookie: who.cookie, "CF-Connecting-IP": who.client, Origin: ORIGIN },
			body,
			redirect: "manual",
		}),
	);
}

/** Uploads a file and answers the id of the import it started. */
async function started(who: Person, text: string) {
	const response = await upload(who, text);
	expect(response.status, await response.clone().text()).toBe(302);
	const id = new URL(response.headers.get("Location") ?? "", ORIGIN).searchParams.get("import");
	expect(id).toBeTruthy();
	return id as string;
}

const page = async (path: string, who: Person) => {
	const response = await open(path, who);
	expect(response.status, path).toBe(200);
	return textOf(await pageBody(response));
};

/** Imports `text` as the owner: started, then imported. */
async function imported(text: string) {
	const { owner } = roles.people;
	const id = await started(owner, text);
	const response = await submit(IMPORT, { intent: "import", importId: id }, owner);
	expect(response.status, await response.clone().text()).toBe(302);
	return id;
}

const revert = async (id: string, who = roles.people.owner) => {
	const response = await submit(IMPORT, { intent: "revert", importId: id }, who, {
		byScript: true,
	});
	return { status: response.status, said: await response.text() };
};

const projectId = async (code: string) =>
	(await value<string>(
		"select id from projects where organisation_id = ? and code = ?",
		acme.id,
		code,
	)) as string;

const SETUP = [
	HEADER,
	"Project,ACME,ACME-002,,Brand,2027-01-04,2027-06-30,Fixed fee,,,",
	"Work package,,ACME-002,WP1,Discovery,2027-01-04,2027-01-31,,40h,,",
	"Work package,,ACME-001,WP9,Support,,,,£1000,,",
	"Assignment,,ACME-002,,,2027-01-04,,,,linus@example.com,Delivery manager",
	"Assignment,,ACME-001,,,2027-01-04,2027-03-31,,,hedy@example.com,",
	"Assignment,,ACME-002,,,2027-01-04,,,,new@x.example,",
	"Assignment,,ACME-002,,,2027-01-04,,,,nobody@x.example,",
].join("\n");

describe("the dry run", () => {
	it("shows each row's outcome and why a row is not added, and writes nothing", async () => {
		const { owner } = roles.people;
		await seedInvitation(acme.id, owner.user.id, "new@x.example");
		const id = await started(owner, `${SETUP}\n`.replace(HEADER, `${HEADER},Notes`));
		const text = await page(`${IMPORT}?import=${id}`, owner);
		expect(text).toContain("Dry run of setup.csv");
		expect(text).toContain("Not read: Notes.");
		expect(text).toContain("1 project, 2 work packages and 3 assignments to add; 1 row not added.");
		expect(text).toContain("1 assignment is for invited people, and waits until each joins.");
		expect(text).toContain("ACME-002 · Brand");
		expect(text).toContain("for ACME · Fixed fee · Monday 4 January 2027 to Wednesday 30 June 2027");
		expect(text).toContain("in ACME-002 (line 2) · 40 hours budget");
		expect(text).toContain("in ACME-001 · 1000.00 GBP budget");
		expect(text).toContain("Delivery manager on ACME-002 (line 2) · from Monday 4 January 2027");
		expect(text).toContain("invited, not joined: put on the team when they join");
		expect(text).toContain(
			"Nobody in this organisation or invited to it has the address nobody@x.example. Invite them first.",
		);
		expect(await count("select count(*) from projects where organisation_id = ?", acme.id)).toBe(1);
		expect(await count("select count(*) from work_packages")).toBe(0);
		expect(await count("select count(*) from project_members")).toBe(0);
		expect(await count("select count(*) from invitation_assignments")).toBe(0);
	});

	it("names a file it cannot read, and keeps nothing of it", async () => {
		const response = await upload(roles.people.owner, "Name\nBrand\n");
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("The file has no Kind column.");
		expect(await count("select count(*) from setup_imports")).toBe(0);
	});
});

describe("importing", () => {
	it("adds projects, then their work packages, then assignments, in one batch, and records it", async () => {
		const { owner } = roles.people;
		await seedInvitation(acme.id, owner.user.id, "new@x.example");
		const batch = vi.spyOn(env.DB, "batch");
		const id = await imported(SETUP);
		// The import's own write is one batch: the import, the four tables and the records.
		const writes = batch.mock.calls.filter(([statements]) => statements.length >= 6);
		expect(writes).toHaveLength(1);

		const brand = await projectId("ACME-002");
		expect(
			await row(
				"select name, client_id, billing_type, starts_on, ends_on from projects where id = ?",
				brand,
			),
		).toEqual({
			name: "Brand",
			client_id: clientId,
			billing_type: "fixed_fee",
			starts_on: "2027-01-04",
			ends_on: "2027-06-30",
		});
		expect(
			await row(
				"select project_id, budget_kind, budget_amount, billable from work_packages where code = 'WP1'",
			),
		).toEqual({ project_id: brand, budget_kind: "hours", budget_amount: 2400, billable: 1 });
		expect(
			await row("select project_id, budget_kind, budget_amount from work_packages where code = 'WP9'"),
		).toEqual({ project_id: website, budget_kind: "fees", budget_amount: 100000 });
		expect(
			await env.DB.prepare(
				"select project_id, user_id, role, starts_on, ends_on, source_kind, source_id from project_members order by starts_on, role",
			).all(),
		).toMatchObject({
			results: expect.arrayContaining([
				{
					project_id: brand,
					user_id: roles.people.member.user.id,
					role: "delivery_manager",
					starts_on: "2027-01-04",
					ends_on: null,
					source_kind: "import",
					source_id: id,
				},
				{
					project_id: website,
					user_id: roles.people.manager.user.id,
					role: "member",
					starts_on: "2027-01-04",
					ends_on: "2027-03-31",
					source_kind: "import",
					source_id: id,
				},
			]),
		});
		expect(
			await row("select project_id, role, starts_on, setup_import_id from invitation_assignments"),
		).toEqual({ project_id: brand, role: "member", starts_on: "2027-01-04", setup_import_id: id });
		expect(
			await row(
				"select status, imported_count, skipped_count, source, created from setup_imports where id = ?",
				id,
			),
		).toMatchObject({ status: "imported", imported_count: 6, skipped_count: 1, source: null });
		const created = JSON.parse(
			(await value<string>("select created from setup_imports where id = ?", id)) as string,
		);
		expect(created.projects).toEqual([brand]);
		expect(created.workPackages).toHaveLength(2);
		expect(
			await row(
				"select actor_id, source, summary from activity_records where action = 'import.imported' and subject_id = ?",
				id,
			),
		).toEqual({
			actor_id: owner.user.id,
			source: "import",
			summary: JSON.stringify({
				after: {
					kind: "setup",
					projects: 1,
					workPackages: 2,
					assignments: 2,
					waiting: 1,
					skipped: 1,
				},
			}),
		});
		expect(
			await env.DB.prepare(
				"select action, count(*) as n from activity_records where source = 'import' group by action order by action",
			).all(),
		).toMatchObject({
			results: [
				{ action: "import.imported", n: 1 },
				{ action: "project.created", n: 1 },
				{ action: "project.member_added", n: 2 },
				{ action: "work_package.created", n: 2 },
			],
		});
		const text = await page(`${IMPORT}?import=${id}`, owner);
		expect(text).toContain("6 rows added, 1 not added.");
		expect(text).toContain("2 assignments are on teams now; 1 still waits for invited people to join.");
	});

	it("imports once, however often it is asked", async () => {
		const { owner } = roles.people;
		const id = await imported(`${HEADER}\nProject,ACME,ACME-002,,Brand,,,,,,`);
		const again = await submit(IMPORT, { intent: "import", importId: id }, owner, {
			byScript: true,
		});
		expect(again.status).toBe(409);
		expect(await again.text()).toContain("This import is no longer waiting to be imported.");
		expect(await count("select count(*) from projects where code = 'ACME-002'")).toBe(1);
	});

	it("imports a 500-row file within D1's limits: one batch, every row", async () => {
		const lines: string[] = [];
		for (let i = 1; i <= 100; i++) {
			const code = `P-${String(i).padStart(3, "0")}`;
			lines.push(
				`Project,ACME,${code},,Project ${i},2027-01-01,2027-12-31,,,,`,
				`Work package,,${code},WP1,Discovery,,,,100h,,`,
				`Work package,,${code},WP2,"Build, test and launch",,,,£25000,,`,
				`Assignment,,${code},,,2027-01-01,,,,linus@example.com,`,
				`Assignment,,${code},,,2027-01-01,,,,hedy@example.com,Delivery manager`,
			);
		}
		expect(lines).toHaveLength(500);
		const batch = vi.spyOn(env.DB, "batch");
		const id = await imported([HEADER, ...lines].join("\n"));
		// The import, projects, work packages, assignments and records: five statements, one batch.
		expect(batch.mock.calls.filter(([statements]) => statements.length === 5)).toHaveLength(1);
		expect(await row("select imported_count, skipped_count from setup_imports where id = ?", id)).toEqual({
			imported_count: 500,
			skipped_count: 0,
		});
		expect(await count("select count(*) from projects where code like 'P-%'")).toBe(100);
		expect(await count("select count(*) from work_packages")).toBe(200);
		expect(await count("select count(*) from project_members where source_id = ?", id)).toBe(200);
		expect(
			await count("select count(*) from activity_records where source = 'import'"),
		).toBe(501);
	});
});

describe("invited people", () => {
	const FOR_NEW = `${HEADER}\nAssignment,,ACME-001,,,2027-01-04,2027-03-31,,,new@x.example,Delivery manager`;

	it("puts an invited person on the team when they accept, recorded as made by the importer", async () => {
		const { owner } = roles.people;
		const invitationId = await seedInvitation(acme.id, owner.user.id, "new@x.example");
		const id = await imported(FOR_NEW);
		expect(await count("select count(*) from invitation_assignments")).toBe(1);

		const newcomer = await person(mailbox, "new@x.example");
		expect((await accept(newcomer.cookie, invitationId)).status).toBe(200);
		expect(
			await row(
				"select project_id, user_id, role, starts_on, ends_on, source_kind, source_id, created_by from project_members",
			),
		).toEqual({
			project_id: website,
			user_id: newcomer.user.id,
			role: "delivery_manager",
			starts_on: "2027-01-04",
			ends_on: "2027-03-31",
			source_kind: "import",
			source_id: id,
			created_by: owner.user.id,
		});
		expect(await count("select count(*) from invitation_assignments")).toBe(0);
		expect(
			await row(
				"select actor_id, source from activity_records where action = 'project.member_added'",
			),
		).toEqual({ actor_id: owner.user.id, source: "import" });
	});

	it("leaves nothing of a cancelled invitation: its person, invited again and joining, is put on no team by it", async () => {
		const { owner } = roles.people;
		const first = await seedInvitation(acme.id, owner.user.id, "new@x.example");
		const id = await imported(FOR_NEW);
		await env.DB.prepare("update invitations set status = 'canceled' where id = ?")
			.bind(first)
			.run();
		expect(await page(`${IMPORT}?import=${id}`, owner)).toContain(
			"1 never will: the invitation was cancelled or ran out",
		);
		const second = await seedInvitation(acme.id, owner.user.id, "new@x.example");
		const newcomer = await person(mailbox, "new@x.example");
		expect((await accept(newcomer.cookie, second)).status).toBe(200);
		expect(await count("select count(*) from project_members")).toBe(0);
		expect(await count("select count(*) from invitation_assignments")).toBe(0);
	});

	it("skips and records an assignment that overlaps one given by hand meanwhile, or whose project was archived, and the person still joins", async () => {
		const { owner } = roles.people;
		const brand = uuidv7();
		const now = Date.now();
		await env.DB.prepare(
			"insert into projects (id, organisation_id, name, name_key, code, code_key, created_at, updated_at) values (?, ?, 'Brand', 'brand', 'ACME-002', 'acme-002', ?, ?)",
		)
			.bind(brand, acme.id, now, now)
			.run();
		const invitationId = await seedInvitation(acme.id, owner.user.id, "new@x.example");
		await imported(
			`${FOR_NEW}\nAssignment,,ACME-002,,,2027-01-04,,,,new@x.example,`,
		);
		await env.DB.prepare("update projects set archived_at = ? where id = ?").bind(now, brand).run();
		const newcomer = await person(mailbox, "new@x.example");
		// Put on the Website team by hand, before they accept, through the trigger's own table.
		await env.DB.prepare(
			"insert into project_members (id, organisation_id, project_id, user_id, role, starts_on, source_kind, created_at, updated_at) values (?, ?, ?, ?, 'member', '2027-02-01', 'manual', ?, ?)",
		)
			.bind(uuidv7(), acme.id, website, newcomer.user.id, now, now)
			.run();

		expect((await accept(newcomer.cookie, invitationId)).status).toBe(200);
		expect(
			await value<string>(
				"select role from memberships where organisation_id = ? and user_id = ?",
				acme.id,
				newcomer.user.id,
			),
		).toBe("member");
		expect(await count("select count(*) from project_members where source_kind = 'import'")).toBe(0);
		const skipped = await env.DB.prepare(
			"select subject_id, summary from activity_records where action = 'project.member_skipped' order by subject_id",
		).all<{ subject_id: string; summary: string }>();
		expect(
			Object.fromEntries(
				skipped.results.map((r) => [r.subject_id, JSON.parse(r.summary).after.reason]),
			),
		).toEqual({
			[website]: "They were already on the project's team on some of those days when they joined.",
			[brand]: "Its project was archived before they joined.",
		});
	});
});

describe("reverting", () => {
	it("before anyone joins: takes away its projects, its work packages, its assignments and those still waiting, and leaves what was there", async () => {
		const { owner } = roles.people;
		await seedInvitation(acme.id, owner.user.id, "new@x.example");
		const id = await imported(SETUP);
		const reverted = await revert(id);
		expect(reverted.status, reverted.said).toBe(200);
		expect(reverted.said).toContain(
			"Import reverted: 1 project, 2 work packages and 3 assignments taken away.",
		);
		expect(await count("select count(*) from projects where organisation_id = ?", acme.id)).toBe(1);
		expect(await count("select count(*) from work_packages")).toBe(0);
		expect(await count("select count(*) from project_members")).toBe(0);
		expect(await count("select count(*) from invitation_assignments")).toBe(0);
		expect(await value<string>("select status from setup_imports where id = ?", id)).toBe("reverted");
		expect(
			await row(
				"select summary from activity_records where action = 'import.reverted' and subject_id = ?",
				id,
			),
		).toEqual({
			summary: JSON.stringify({
				before: { kind: "setup", projects: 1, workPackages: 2, assignments: 2, waiting: 1 },
			}),
		});
		// Hedy's stretch was on a project that stays, so it is recorded as taken off.
		expect(
			await row(
				"select subject_id from activity_records where action = 'project.member_removed'",
			),
		).toEqual({ subject_id: website });
		// Invitations stay.
		expect(await count("select count(*) from invitations where status = 'pending'")).toBe(1);
	});

	it("after a person joins: takes away the assignment made when they joined", async () => {
		const { owner } = roles.people;
		const invitationId = await seedInvitation(acme.id, owner.user.id, "new@x.example");
		const id = await imported(
			`${HEADER}\nAssignment,,ACME-001,,,2027-01-04,,,,new@x.example,`,
		);
		const newcomer = await person(mailbox, "new@x.example");
		expect((await accept(newcomer.cookie, invitationId)).status).toBe(200);
		expect(await count("select count(*) from project_members")).toBe(1);
		const reverted = await revert(id);
		expect(reverted.status, reverted.said).toBe(200);
		expect(await count("select count(*) from project_members")).toBe(0);
		// They stay in the organisation.
		expect(
			await count(
				"select count(*) from memberships where organisation_id = ? and user_id = ?",
				acme.id,
				newcomer.user.id,
			),
		).toBe(1);
	});

	it("is refused, whole, once time is tracked to a project, a work package or an assignment it added, and says what is in the way", async () => {
		const { member, manager } = roles.people;
		const onProject = await imported(SETUP);
		const brand = await projectId("ACME-002");
		await seedEntry(acme.id, member.user.id, brand, "2027-01-05T09:00:00Z", "2027-01-05T10:00:00Z");
		const refused = await revert(onProject);
		expect(refused.status).toBe(409);
		expect(refused.said).toContain("Time has been tracked to ACME-002 · Brand, which this import added.");
		expect(refused.said).toContain("Nothing was reverted");
		expect(await count("select count(*) from projects where organisation_id = ?", acme.id)).toBe(2);
		expect(await count("select count(*) from work_packages")).toBe(2);
		expect(await count("select count(*) from project_members")).toBe(2);
		expect(await value<string>("select status from setup_imports where id = ?", onProject)).toBe(
			"imported",
		);

		// On a work package it added to a project that was already here.
		await env.DB.prepare("delete from time_entries").run();
		const wp9 = await value<string>("select id from work_packages where code = 'WP9'");
		const entry = await seedEntry(
			acme.id,
			member.user.id,
			website,
			"2026-11-02T09:00:00Z",
			"2026-11-02T10:00:00Z",
		);
		await env.DB.prepare("update time_entries set work_package_id = ? where id = ?")
			.bind(wp9, entry)
			.run();
		expect((await revert(onProject)).said).toContain(
			"Time has been tracked to work package WP9, which this import added.",
		);

		// By a person in the stretch it put them on an existing project's team; before it, nothing stops it.
		await env.DB.prepare("delete from time_entries").run();
		await seedEntry(acme.id, manager.user.id, website, "2026-12-01T09:00:00Z", "2026-12-01T10:00:00Z");
		expect((await revert(onProject)).status).toBe(200);
	});

	it("is refused when the person's time falls in the stretch it gave them", async () => {
		const { manager } = roles.people;
		const id = await imported(
			`${HEADER}\nAssignment,,ACME-001,,,2027-01-04,2027-03-31,,,hedy@example.com,`,
		);
		await seedEntry(acme.id, manager.user.id, website, "2027-02-01T09:00:00Z", "2027-02-01T10:00:00Z");
		const refused = await revert(id);
		expect(refused.status).toBe(409);
		expect(refused.said).toContain(
			"Time has been tracked to hedy@example.com on ACME-001 · Website, which this import added.",
		);
		expect(await count("select count(*) from project_members")).toBe(1);
	});

	it("reverts only an import that was imported", async () => {
		const id = await started(roles.people.owner, `${HEADER}\nProject,,P-1,,One,,,,,,`);
		const refused = await revert(id);
		expect(refused.status).toBe(409);
		expect(refused.said).toContain("Only a set-up import that was imported can be reverted.");
	});
});

describe("who may set up from a file", () => {
	it("is a page for owners and admins alone, linked from Projects for them alone", async () => {
		const { owner, admin, finance, manager, member } = roles.people;
		const now = Date.now();
		const [accountManager, deliveryManager, contractor, stranger] = await Promise.all([
			person(mailbox, "account@example.com"),
			person(mailbox, "delivery@example.com"),
			person(mailbox, "con@example.com"),
			person(mailbox, "stranger@example.com"),
		]);
		await env.DB.batch([
			...[accountManager, deliveryManager, contractor].map((who) =>
				env.DB.prepare(
					"insert into memberships (id, organisation_id, user_id, role, is_contractor, created_at, updated_at) values (?, ?, ?, 'member', ?, ?, ?)",
				).bind(uuidv7(), acme.id, who.user.id, who === contractor ? 1 : 0, now, now),
			),
			env.DB.prepare(
				"insert into client_managers (organisation_id, client_id, user_id, created_at) values (?, ?, ?, ?)",
			).bind(acme.id, clientId, accountManager.user.id, now),
			env.DB.prepare(
				"insert into project_members (id, organisation_id, project_id, user_id, role, starts_on, source_kind, created_at, updated_at) values (?, ?, ?, ?, 'delivery_manager', '2026-01-01', 'manual', ?, ?)",
			).bind(uuidv7(), acme.id, website, deliveryManager.user.id, now, now),
		]);
		const LINK = "Set up projects, work packages and teams from a CSV";
		for (const who of [owner, admin]) {
			expect((await open(IMPORT, who)).status, who.user.email).toBe(200);
			expect(await page(PROJECTS, who), who.user.email).toContain(LINK);
		}
		const id = await started(owner, `${HEADER}\nProject,,P-1,,One,,,,,,`);
		for (const who of [finance, accountManager, deliveryManager, manager, member, contractor]) {
			expect((await open(IMPORT, who)).status, who.user.email).toBe(404);
			expect((await upload(who, `${HEADER}\nProject,,P-2,,Two,,,,,,`)).status, who.user.email).toBe(
				404,
			);
			for (const intent of ["import", "revert", "discard"]) {
				expect(
					(await submit(IMPORT, { intent, importId: id }, who, { byScript: true })).status,
					`${who.user.email} ${intent}`,
				).toBe(404);
			}
			expect(await page(PROJECTS, who), who.user.email).not.toContain(LINK);
		}
		expect((await open(IMPORT, stranger)).status).toBe(404);
		expect((await upload(stranger, `${HEADER}\nProject,,P-2,,Two,,,,,,`)).status).toBe(404);
		expect(await count("select count(*) from setup_imports")).toBe(1);
		expect(await value<string>("select status from setup_imports where id = ?", id)).toBe(
			"previewed",
		);
	});
});
