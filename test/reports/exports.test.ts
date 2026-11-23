import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "~/db";
import { EXPORT_PAGE } from "~/routes/app/integrations.export";

import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { insertAll } from "../lists/crowd";
import { createOrganisation } from "../organisations/harness";
import { open, type Person, person } from "../pages/harness";
import { parseCsv } from "./csv";

// The CSV exports read their entries a page at a time, each page one
// statement that starts after the last row of the one before (keyset paging,
// TS-113, decision 58), and write each page before reading the next: no
// export holds the organisation's entries. Here there are more entries than
// a page holds, so the file is read across a page boundary, and its first,
// last and boundary rows are checked.

/** More than one page: two full pages would be 4,000. */
const ENTRIES = EXPORT_PAGE + 101;
const FIRST = Date.parse("2026-02-02T09:00:00Z");
const STEP = 20 * 60_000;

let ada: Person;

/** The `i`th entry's note: they sort as the entries start. */
const note = (i: number) => `Entry ${String(i).padStart(4, "0")}`;

beforeAll(async () => {
	await freshDatabase();
	ada = await person(captureEmail(), "ada@example.com");
	const acme = await createOrganisation(ada.cookie, "Acme");
	const project = uuidv7();
	const now = Date.now();
	await insertAll(
		"insert into projects (id, organisation_id, name, name_key, created_at, updated_at) values (?, ?, 'Site', 'site', ?, ?)",
		[[project, acme.id, now, now]],
	);
	await insertAll(
		"insert into time_entries (id, organisation_id, user_id, project_id, description, started_at, ended_at, spent_on, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		Array.from({ length: ENTRIES }, (_, i) => {
			const start = FIRST + i * STEP;
			const day = new Date(start).toISOString().slice(0, 10);
			return [
				uuidv7(),
				acme.id,
				ada.user.id,
				project,
				note(i),
				start,
				start + 15 * 60_000,
				day,
				now,
				now,
			];
		}),
	);
}, 120_000);

afterEach(() => {
	vi.restoreAllMocks();
});

/** The file at `path`, as rows, and how many statements reading it made. */
async function exported(path: string): Promise<{ rows: string[][]; statements: string[] }> {
	const statements: string[] = [];
	const prepare = env.DB.prepare.bind(env.DB);
	vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
		statements.push(query);
		return prepare(query);
	});
	const response = await open(path, ada);
	expect(response.status).toBe(200);
	const rows = parseCsv((await response.text()).replace(/^\uFEFF/, ""));
	return { rows, statements: statements.filter((s) => s.includes('from "time_entries"')) };
}

describe("an export longer than a page", () => {
	it("the report's holds every entry once, in the order of day, start and id, across the boundary", async () => {
		const { rows, statements } = await exported(
			"/app/acme/reports/export?range=custom&from=2026-02-01&to=2026-03-31&group=project",
		);
		const [header, ...entries] = rows;
		const at = header?.indexOf("description") ?? -1;
		const notes = entries.map((row) => row[at]);
		expect(notes).toHaveLength(ENTRIES);
		expect(notes[0]).toBe(note(0));
		expect(notes.at(-1)).toBe(note(ENTRIES - 1));
		// The last row of the first page and the first of the second follow each other.
		expect(notes.slice(EXPORT_PAGE - 1, EXPORT_PAGE + 1)).toEqual([
			note(EXPORT_PAGE - 1),
			note(EXPORT_PAGE),
		]);
		expect(new Set(notes).size).toBe(ENTRIES);
		// Two pages of entries, the second starting after the first's last row.
		expect(statements).toHaveLength(2);
		expect(statements[1]).toMatch(/\(.*"spent_on".*"started_at".*"id"\) > \(/);
	});

	it("the all-time one holds every entry once, oldest first, across the boundary", async () => {
		const { rows, statements } = await exported("/app/acme/integrations/export");
		const [header, ...entries] = rows;
		const at = header?.indexOf("Notes") ?? -1;
		const notes = entries.map((row) => row[at]);
		expect(notes).toHaveLength(ENTRIES);
		expect(notes[0]).toBe(note(0));
		expect(notes.at(-1)).toBe(note(ENTRIES - 1));
		expect(notes.slice(EXPORT_PAGE - 1, EXPORT_PAGE + 1)).toEqual([
			note(EXPORT_PAGE - 1),
			note(EXPORT_PAGE),
		]);
		expect(new Set(notes).size).toBe(ENTRIES);
		expect(statements).toHaveLength(2);
		expect(statements[1]).toMatch(/\(.*"started_at".*"id"\) > \(/);
	});
});
