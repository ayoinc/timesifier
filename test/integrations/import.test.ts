import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "~/db";
import { parseCsv } from "~/import/csv";
import { harvestMapping, readDate, readMinutes } from "~/import/mapping";
import { captureEmail, type Mailbox, ORIGIN } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	type Role,
	row,
	seedMembership,
	value,
} from "../organisations/harness";
import { open, type Person, person, submit, textOf } from "../pages/harness";
import { seedEntry, seedPeriod, seedProject } from "../pages/periods-seed";
import harvestExport from "./fixtures/harvest-time-export.csv?raw";

// Importing from a CSV (TS-076): Harvest's export read as it is, a preview
// before anything is written, members matched by email or name, missing
// clients, projects and tasks added, rows already here skipped, and a time
// import reverted exactly, unless an entry of it is locked. Clients and
// projects import too, and all time exports in the columns the import reads.

const IMPORT = "/app/acme/integrations/import";

let mailbox: Mailbox;
let ada: Person;
let max: Person;
let acme: { id: string };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	max = await memberOfAcme("member", "max@example.com", "Max Member");
	await env.DB.prepare("update users set name = 'Ada Lovelace' where id = ?")
		.bind(ada.user.id)
		.run();
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

async function memberOfAcme(role: Role, email: string, name: string): Promise<Person> {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, role);
	await env.DB.prepare("update users set name = ? where id = ?").bind(name, who.user.id).run();
	return who;
}

/** Uploads `text` as a CSV of `kind` the way the page's form does; the address it is previewed at. */
async function upload(text: string, kind = "time", who: Person = ada) {
	const body = new FormData();
	body.set("intent", "upload");
	body.set("kind", kind);
	body.set("file", new File([text], "harvest.csv", { type: "text/csv" }));
	const response = await exports.default.fetch(
		new Request(`${ORIGIN}${IMPORT}?kind=${kind}`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: who.cookie, "CF-Connecting-IP": who.client },
			body,
			redirect: "manual",
		}),
	);
	return { status: response.status, location: response.headers.get("Location") ?? "" };
}

const importIdOf = (location: string) => new URL(location, ORIGIN).searchParams.get("import") ?? "";

/** Ada's own Apollo entry on 6 October, Programming, which line 4 of the file repeats. */
async function seedExisting() {
	const apollo = await seedProject(acme.id, "Apollo");
	const now = Date.now();
	const programming = uuidv7();
	await env.DB.batch([
		env.DB.prepare(
			"insert into tasks (id, organisation_id, name, name_key, created_at, updated_at) values (?, ?, 'Programming', 'programming', ?, ?)",
		).bind(programming, acme.id, now, now),
		env.DB.prepare(
			"insert into project_tasks (id, organisation_id, project_id, task_id, billable, created_at, updated_at) values (?, ?, ?, ?, 1, ?, ?)",
		).bind(uuidv7(), acme.id, apollo, programming, now, now),
	]);
	const entry = await seedEntry(
		acme.id,
		ada.user.id,
		apollo,
		"2026-10-06T09:00:00Z",
		"2026-10-06T11:15:00Z",
		"Fixed the build",
	);
	await env.DB.prepare("update time_entries set task_id = ? where id = ?")
		.bind(programming, entry)
		.run();
	return { apollo, entry };
}

describe("reading a file", () => {
	it("reads quoted fields, doubled quotes and both line endings", () => {
		expect(parseCsv('a,"b, c","say ""hi"""\r\n1,2,3\n\n')).toEqual([
			{ line: 1, cells: ["a", "b, c", 'say "hi"'] },
			{ line: 2, cells: ["1", "2", "3"] },
		]);
		expect(parseCsv('a,"b\nc"\r\nd,e')).toEqual([
			{ line: 1, cells: ["a", "b\nc"] },
			{ line: 3, cells: ["d", "e"] },
		]);
		expect(parseCsv('a,"open')).toBeNull();
	});

	it("takes Harvest's headings, its dates and its hours", () => {
		const [header] = parseCsv(harvestExport) ?? [];
		expect(harvestMapping("time", header?.cells ?? [])).toEqual({
			date: 0,
			client: 1,
			project: 2,
			task: 4,
			notes: 5,
			hours: 6,
			first_name: 11,
			last_name: 12,
		});
		expect(readDate("10/6/2026")).toBe("2026-10-06");
		expect(readDate("2026-02-30")).toBeNull();
		expect(readMinutes("2.25")).toBe(135);
		expect(readMinutes("1:30")).toBe(90);
		expect(readMinutes("0")).toBeNull();
		expect(readMinutes("25")).toBeNull();
	});
});

describe("importing Harvest's export of all time", () => {
	it("previews the rows to import and to skip, with reasons, before anything is written", async () => {
		await seedExisting();
		const uploaded = await upload(harvestExport);
		expect(uploaded.status).toBe(302);
		expect(await value("select count(*) from time_entries")).toBe(1);
		expect(await value("select count(*) from projects")).toBe(1);

		const page = textOf(await (await open(uploaded.location, ada)).text());
		expect(page).toContain("3 to import, 5 to skip.");
		expect(page).toContain("Grace Hopper: lines 5, 6");
		expect(page).toContain("No member is called Grace Hopper.");
		expect(page).toContain("Already in Timesifier.");
		expect(page).toContain("The hours are not a number above 0 and at most 24.");
		expect(page).toContain("The date is not YYYY-MM-DD or M/D/YYYY.");
		expect(page).toContain(
			"It adds clients Example Client, Acme Internal; projects Website Redesign, Research; tasks Design, Project Management, Reading.",
		);
		expect(page).toContain("Ada Lovelace · Website Redesign · Design");
		expect(await value("select count(*) from time_entries")).toBe(1);
	});

	it("imports the rows, adds what is missing, and records the import", async () => {
		await seedExisting();
		const { location } = await upload(harvestExport);
		const id = importIdOf(location);
		const imported = await submit(`${IMPORT}?kind=time`, { intent: "import", importId: id }, ada);
		expect(imported.status).toBe(302);

		expect(await value("select count(*) from time_entries where import_id = ?", id)).toBe(3);
		const first = await row<{
			started_at: number;
			ended_at: number;
			description: string;
			user_id: string;
			billable: number;
		}>(
			"select started_at, ended_at, description, user_id, billable from time_entries where import_id = ? and description = ?",
			id,
			"Homepage, first draft",
		);
		expect(first?.user_id).toBe(ada.user.id);
		expect(new Date(first?.started_at ?? 0).toISOString()).toBe("2026-10-05T09:00:00.000Z");
		expect(((first?.ended_at ?? 0) - (first?.started_at ?? 0)) / 60_000).toBe(210);
		expect(first?.billable).toBe(1);
		expect(
			await value(
				"select c.name from projects p join clients c on c.id = p.client_id where p.name = 'Website Redesign'",
			),
		).toBe("Example Client");
		// General, which every organisation has (TS-066), Programming and the three added.
		expect(await value("select count(*) from tasks")).toBe(5);
		// Each of the three projects has General; Apollo Programming, and the two added theirs.
		expect(await value("select count(*) from project_tasks")).toBe(7);
		expect(
			await row("select status, imported_count, skipped_count, source from import_jobs"),
		).toEqual({
			status: "imported",
			imported_count: 3,
			skipped_count: 5,
			source: null,
		});
		expect(
			await value(
				"select count(*) from activity_records where action = 'import.imported' and source = 'import'",
			),
		).toBe(1);
		expect(
			await value(
				"select count(*) from activity_records where action = 'project.created' and source = 'import'",
			),
		).toBe(2);

		// The same file again: everything is already here.
		const again = await upload(harvestExport);
		expect(textOf(await (await open(again.location, ada)).text())).toContain(
			"0 to import, 8 to skip.",
		);
	});

	it("matches people by email where the file has one", async () => {
		const csv =
			"Date,Project,Hours,Email,First name,Last name\r\n2026-10-05,Apollo,1,MAX@example.com,Someone,Else\r\n";
		const { location } = await upload(csv);
		expect(textOf(await (await open(location, ada)).text())).toContain("Max Member · Apollo");
	});

	it("lets the columns be chosen when the headings are not Harvest's", async () => {
		const csv = "When,Job,Length,Who\r\n2026-10-05,Apollo,2,Max Member\r\n";
		const { location } = await upload(csv);
		const id = importIdOf(location);
		expect(textOf(await (await open(location, ada)).text())).toContain(
			"Choose a column for Date, Project, Hours",
		);
		const mapped = await submit(
			location,
			{
				intent: "map",
				importId: id,
				"column-date": "0",
				"column-project": "1",
				"column-hours": "2",
				"column-person": "3",
			},
			ada,
			{ byScript: true },
		);
		expect(mapped.status).toBe(200);
		expect(textOf(await (await open(location, ada)).text())).toContain("1 to import, 0 to skip.");
	});

	it("reverts exactly its own entries, and refuses, naming them, while one is locked", async () => {
		const { entry } = await seedExisting();
		const { location } = await upload(harvestExport);
		const id = importIdOf(location);
		await submit(`${IMPORT}?kind=time`, { intent: "import", importId: id }, ada);

		await seedPeriod(acme.id, max.user.id, "2026-10-05", "approved");
		const refused = await submit(`${IMPORT}?kind=time`, { intent: "revert", importId: id }, ada, {
			byScript: true,
		});
		expect(refused.status).toBe(409);
		const said = await refused.text();
		expect(said).toContain("2 of this import's entries are locked, so nothing was reverted.");
		expect(said).toContain("Max Member, Monday 5 October 2026, Website Redesign, 1:00: approved");
		expect(await value("select count(*) from time_entries where import_id = ?", id)).toBe(3);

		await env.DB.prepare("delete from periods").run();
		const reverted = await submit(`${IMPORT}?kind=time`, { intent: "revert", importId: id }, ada, {
			byScript: true,
		});
		expect(reverted.status).toBe(200);
		expect(await reverted.text()).toContain("Import reverted: 3 entries deleted.");
		expect(await value("select count(*) from time_entries where import_id = ?", id)).toBe(0);
		expect(await value("select count(*) from time_entries where id = ?", entry)).toBe(1);
		expect(await value("select status from import_jobs")).toBe("reverted");
		expect(
			await value("select count(*) from activity_records where action = 'import.reverted'"),
		).toBe(1);
	});

	it("is refused to anyone but an owner or admin", async () => {
		for (const role of ["member", "finance"] as const) {
			const who = await memberOfAcme(role, `${role}@example.com`, role);
			expect((await open(`${IMPORT}?kind=time`, who)).status).toBe(404);
			expect((await upload(harvestExport, "time", who)).status).toBe(404);
		}
		const ben = await memberOfAcme("admin", "ben@example.com", "Ben Admin");
		expect((await upload(harvestExport, "time", ben)).status).toBe(302);
	});
});

describe("clients and projects", () => {
	it("import clients, skipping those already here", async () => {
		const now = Date.now();
		await env.DB.prepare(
			"insert into clients (id, organisation_id, name, name_key, created_at, updated_at) values (?, ?, 'Initech', 'initech', ?, ?)",
		)
			.bind(uuidv7(), acme.id, now, now)
			.run();
		const { location } = await upload("Client\r\nInitech\r\nUmbrella\r\nHooli\r\n", "clients");
		const page = textOf(await (await open(location, ada)).text());
		expect(page).toContain("2 to import, 1 to skip.");
		expect(page).toContain("Already a client.");
		const done = await submit(
			`${IMPORT}?kind=clients`,
			{ intent: "import", importId: importIdOf(location) },
			ada,
		);
		expect(done.status).toBe(302);
		expect(
			await value("select group_concat(name, ',') from (select name from clients order by name)"),
		).toBe("Hooli,Initech,Umbrella");
	});

	it("import projects in Harvest's columns, adding their clients", async () => {
		const csv =
			"Client,Project,Project code,Start date,End date,Project notes\r\nUmbrella,Hive,,,,\r\n,Internal,,,,\r\n";
		const { location } = await upload(csv, "projects");
		await submit(
			`${IMPORT}?kind=projects`,
			{ intent: "import", importId: importIdOf(location) },
			ada,
		);
		expect(
			await value(
				"select c.name from projects p join clients c on c.id = p.client_id where p.name = 'Hive'",
			),
		).toBe("Umbrella");
		expect(await value("select client_id from projects where name = 'Internal'")).toBeNull();
	});
});

describe("exporting all time", () => {
	it("gives an owner or admin every entry in the columns the import reads, and nobody else", async () => {
		const { apollo } = await seedExisting();
		await seedEntry(
			acme.id,
			max.user.id,
			apollo,
			"2026-10-07T10:00:00Z",
			"2026-10-07T10:30:00Z",
			"=SUM(A1)",
		);
		const response = await open("/app/acme/integrations/export", ada);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Disposition")).toContain("acme-all-time.csv");
		const csv = await response.text();
		const rows = parseCsv(csv) ?? [];
		expect(rows[0]?.cells).toEqual([
			"Date",
			"Client",
			"Project",
			"Task",
			"Notes",
			"Hours",
			"First name",
			"Last name",
			"Email",
		]);
		expect(rows.slice(1).map((r) => r.cells)).toEqual([
			[
				"2026-10-06",
				"",
				"Apollo",
				"Programming",
				"Fixed the build",
				"2.25",
				"Ada",
				"Lovelace",
				"ada@example.com",
			],
			["2026-10-07", "", "Apollo", "", "'=SUM(A1)", "0.50", "Max", "Member", "max@example.com"],
		]);
		expect((await open("/app/acme/integrations/export", max)).status).toBe(404);
	});
});
