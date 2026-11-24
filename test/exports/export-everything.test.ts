import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { record } from "~/activity/activity.server";
import { logoFile, saveLogo } from "~/brand/organisation-brand.server";
import { EXPORTED_TABLES, everyRow, exportedTable, organisationScope } from "~/db";
import { recordExpense } from "~/expenses/expenses.server";
import { getReceipt, receiptKey } from "~/expenses/receipts.server";
import {
	advanceExport,
	advanceExports,
	deleteExpiredExports,
	deleteOrganisationExports,
	EXPORT_LIMITS,
	type ExportLimits,
	exportKey,
	exportStateOf,
	requestExport,
} from "~/exports/job.server";
import { EXPORT_FORMAT_VERSION } from "~/exports/paths";
import { makeToken } from "~/integrations/api-tokens.server";
import { zipEnd, zipFile } from "~/lib/zip";
import { captureEmail, type Mailbox } from "../auth/harness";
import { png } from "../brand/files";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	seedInvitation,
	seedMember,
	seedMembership,
	seedTeam,
	value,
} from "../organisations/harness";
import { open, type Person, person, submit } from "../pages/harness";
import { seedLeave } from "../pages/leave-seed";
import { seedEntry, seedProject } from "../pages/periods-seed";
import { parseCsv } from "../reports/csv";
import { endRecord, localOffset, unzip } from "../zip";

// The export of everything (TS-126, docs/decisions.md entry 71). Two
// organisations hold work of the same kinds; Acme's owner exports Acme's, and
// the ZIP is read back: a CSV for every table of the organisation, Acme's rows
// alone, the receipts and the logo, and a manifest whose counts are the
// files'. The job is then stepped a unit at a time, across pages, files and
// parts, failed, retried, expired and deleted; and each role asks for it.

const PAGE = "/app/acme/settings/export";
const DOWNLOAD = "/app/acme/settings/export/download";
const DAY_MS = 24 * 60 * 60 * 1000;

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };
let globex: { id: string };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	const bob = await person(mailbox, "bob@example.com");
	globex = await createOrganisation(bob.cookie, "Globex");
	await seedWork(acme.id, ada.user.id, "Acme");
	await seedWork(globex.id, bob.user.id, "Globex");
}, 60_000);

afterEach(() => {
	vi.restoreAllMocks();
});

/** Work of every common kind in an organisation, each piece marked with `marker`. */
async function seedWork(organisationId: string, ownerId: string, marker: string) {
	const scope = organisationScope(env.DB, organisationId);
	const member = await seedMember(
		organisationId,
		"member",
		`${marker.toLowerCase()}-member@example.com`,
	);
	await seedTeam(organisationId, `${marker} Design`, { members: [member.userId] });
	const project = await seedProject(organisationId, `${marker} Website`);
	const [client] = await scope.clients.insert({ name: `${marker} Client`, nameKey: marker });
	const [tag] = await scope.tags.insert({ name: `${marker} tag`, nameKey: `${marker}-tag` });
	const [category] = await scope.expenseCategories.insert({
		name: `${marker} Taxis`,
		nameKey: `${marker}-taxis`,
	});
	if (!client || !tag || !category) throw new Error("seed failed");
	for (let n = 0; n < 3; n++) {
		const entry = await seedEntry(
			organisationId,
			member.userId,
			project,
			`2026-10-1${n}T09:00:00Z`,
			`2026-10-1${n}T11:00:00Z`,
			`${marker} copy ${n}`,
		);
		await scope.entryTags.insert({ timeEntryId: entry, tagId: tag.id });
	}
	const expense = await recordExpense(scope, member.userId, {
		spentOn: "2026-10-13",
		projectId: project,
		categoryId: category.id,
		amount: "12.50",
		quantity: "",
		notes: `${marker} train`,
		billable: false,
		reimbursable: true,
		receipt: new File([`%PDF-1.4 ${marker}`], "ticket.pdf", { type: "application/pdf" }),
		removeReceipt: false,
	});
	if (!expense.ok) throw new Error("seed failed");
	const logo = new File([await png(48, 16)], "logo.png", { type: "image/png" });
	if (!(await saveLogo(organisationId, ownerId, logo, null, Date.now())).ok) {
		throw new Error("seed failed");
	}
	await seedInvitation(organisationId, ownerId, `${marker.toLowerCase()}-invited@example.com`);
	await seedLeave(organisationId, member.userId, "annual", "2026-10-20", "2026-10-21");
	await makeToken(scope, ownerId, `${marker} token`, ["time:read"]);
	await record(scope, ownerId, "project.created", { type: "project", id: project });
	return { member, project, expense: expense.id };
}

/** Asks for an export as `ownerId` and steps it until it is made. Answers its id and the steps it took. */
async function exportMade(
	organisationId: string,
	ownerId: string,
	limits: ExportLimits = EXPORT_LIMITS,
	now = new Date(),
) {
	const scope = organisationScope(env.DB, organisationId);
	const requested = await requestExport(scope, ownerId, now);
	if (!requested.ok) throw new Error(requested.problem);
	let steps = 0;
	for (;;) {
		steps += 1;
		const stepped = await advanceExport(organisationId, requested.id, now, limits);
		if (stepped === "ready") break;
		if (stepped !== "running" || steps > 1_000) throw new Error(`the export is ${stepped}`);
	}
	return { id: requested.id, steps };
}

/** The made ZIP of export `id`, as stored. */
async function storedZip(organisationId: string, id: string): Promise<Uint8Array<ArrayBuffer>> {
	const object = await env.RECEIPTS.get(exportKey(organisationId, id));
	if (!object) throw new Error("no ZIP");
	return new Uint8Array(await object.arrayBuffer());
}

/** The files of a ZIP by name. */
async function filesOf(zip: Uint8Array<ArrayBuffer>): Promise<Map<string, Uint8Array>> {
	return new Map((await unzip(zip)).map((entry) => [entry.name, entry.bytes]));
}

/** UTF-8 as it is, its byte order mark kept: a decoder drops it unless told not to. */
const text = (bytes: Uint8Array | undefined) =>
	new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);

/** A CSV file's rows, its header first, without the byte order mark. */
function rowsOf(bytes: Uint8Array | undefined): string[][] {
	const read = text(bytes);
	expect(read.startsWith("\uFEFF")).toBe(true);
	return parseCsv(read.slice(1));
}

interface Manifest {
	format: string;
	version: number;
	organisation: { id: string; name: string };
	startedAt: string;
	exportedAt: string;
	tables: Record<string, number>;
	withheld: Record<string, string[]>;
	files: { name: string; table?: string; rows?: number; bytes: number }[];
}

function manifestOf(files: Map<string, Uint8Array>): Manifest {
	return JSON.parse(text(files.get("manifest.json")));
}

/** Every table of the database with an `organisation_id`, as SQLite lists them. */
async function organisationTables(): Promise<string[]> {
	const found = await env.DB.prepare(
		"select m.name from sqlite_master m, pragma_table_info(m.name) p where m.type = 'table' and p.name = 'organisation_id' order by m.name",
	).all<{ name: string }>();
	return found.results.map((r) => r.name);
}

/** The id of every row the organisation `organisationId` holds, in every table of its own. */
async function idsOf(organisationId: string): Promise<string[]> {
	const ids: string[] = [];
	for (const table of await organisationTables()) {
		const found = await env.DB.prepare(`select id from ${table} where organisation_id = ?`)
			.bind(organisationId)
			.all<{ id: string }>();
		ids.push(...found.results.map((r) => r.id));
	}
	return ids;
}

describe("the ZIP of everything", () => {
	it("holds every table of the organisation as CSV, its receipts and logo, and a manifest whose counts are the files'", async () => {
		const { id } = await exportMade(acme.id, ada.user.id);
		const zip = await storedZip(acme.id, id);
		expect(endRecord(zip).comment).toMatch(
			/^Acme: everything, exported \d{4}-\d{2}-\d{2}\. Made with Timesifier\.$/,
		);
		const files = await filesOf(zip);
		const manifest = manifestOf(files);

		// Every table with an organisation_id but the exports' own bookkeeping,
		// the organisation's own row and its members' accounts.
		const expected = [
			...(await organisationTables()).filter((t) => t !== "organisation_exports"),
			"organisations",
			"users",
		].sort();
		expect(Object.keys(manifest.tables).sort()).toEqual(expected);
		for (const table of expected) expect(files.has(`tables/${table}.csv`)).toBe(true);
		expect(EXPORTED_TABLES.map((t) => exportedTable(t).sqlName).sort()).toEqual(
			expected.filter((t) => t !== "organisations" && t !== "users"),
		);

		// The manifest lists every file but itself, with its size, and each
		// table file's rows, which are the rows it holds and the rows the
		// organisation has.
		expect(manifest.files.map((f) => f.name).sort()).toEqual(
			[...files.keys()].filter((name) => name !== "manifest.json").sort(),
		);
		for (const file of manifest.files) {
			expect(file.bytes).toBe(files.get(file.name)?.length);
			if (file.table === undefined) continue;
			expect(rowsOf(files.get(file.name)).length - 1).toBe(file.rows);
		}
		// Each count is the table's rows but the record that the export was made,
		// which is written once the ZIP is.
		const made = await value(
			"select count(*) from activity_records where subject_id = ? and action = 'organisation_export.made'",
			id,
		);
		expect(made).toBe(1);
		for (const table of expected) {
			const rows =
				table === "organisations"
					? 1
					: table === "users"
						? await value("select count(*) from memberships where organisation_id = ?", acme.id)
						: await value(`select count(*) from ${table} where organisation_id = ?`, acme.id);
			expect(manifest.tables[table], table).toBe(
				table === "activity_records" ? (rows ?? 0) - 1 : rows,
			);
		}
		expect(manifest.tables.time_entries).toBe(3);
		expect(manifest.format).toBe("Timesifier export of everything");
		expect(manifest.version).toBe(EXPORT_FORMAT_VERSION);
		expect(manifest.organisation).toEqual({ id: acme.id, name: "Acme" });
		expect(Date.parse(manifest.exportedAt)).toBeGreaterThanOrEqual(Date.parse(manifest.startedAt));

		// A table's columns are its own, by their SQL names, less the secrets.
		const entries = rowsOf(files.get("tables/time_entries.csv"));
		expect(entries[0]).toEqual(exportedTable("timeEntries").columns.map((c) => c.name));
		expect(
			entries
				.slice(1)
				.map((r) => r[entries[0]?.indexOf("description") ?? -1])
				.sort(),
		).toEqual(["Acme copy 0", "Acme copy 1", "Acme copy 2"]);
		expect(rowsOf(files.get("tables/api_tokens.csv"))[0]).not.toContain("token_hash");
		expect(rowsOf(files.get("tables/invitations.csv"))[0]).not.toContain("id");
		expect(rowsOf(files.get("tables/webhooks.csv"))[0]).not.toContain("secret_hash");
		expect(rowsOf(files.get("tables/calendar_feeds.csv"))[0]).not.toContain("token_hash");
		expect(manifest.withheld).toEqual({
			invitations: ["id"],
			api_tokens: ["token_hash"],
			webhooks: ["secret_hash"],
			calendar_feeds: ["token_hash"],
		});
		const hashes = await env.DB.prepare("select token_hash from api_tokens").all<{
			token_hash: string;
		}>();
		for (const { token_hash } of hashes.results) {
			for (const bytes of files.values()) expect(text(bytes)).not.toContain(token_hash);
		}

		// The members' accounts: name, address, zone, and nothing else.
		const users = rowsOf(files.get("tables/users.csv"));
		expect(users[0]).toEqual(["id", "name", "email", "time_zone", "created_at"]);
		expect(
			users
				.slice(1)
				.map((r) => r[2])
				.sort(),
		).toEqual(["acme-member@example.com", "ada@example.com"]);

		// The receipt, byte for byte, named by its expense, and the logo.
		const [expense] = await organisationScope(env.DB, acme.id).expenses.select();
		if (!expense) throw new Error("no expense");
		const receipt = await getReceipt(acme.id, expense.id);
		expect(files.get(`receipts/${expense.id}.pdf`)).toEqual(
			new Uint8Array((await receipt?.arrayBuffer()) ?? []),
		);
		const logo = await logoFile(acme.id);
		expect(files.get("brand/logo.png")).toEqual(new Uint8Array((await logo?.arrayBuffer()) ?? []));
	});

	it("holds no row, receipt or name of another organisation", async () => {
		const { id } = await exportMade(acme.id, ada.user.id);
		const files = await filesOf(await storedZip(acme.id, id));
		const all = [...files.values()].map(text).join("\n");
		const theirs = await idsOf(globex.id);
		expect(theirs.length).toBeGreaterThan(20);
		for (const row of theirs) expect(all.includes(row), row).toBe(false);
		expect(all).not.toContain(globex.id);
		expect(all).not.toContain("Globex");
		expect(all).not.toContain("bob@example.com");
		expect(all).not.toContain("globex-member@example.com");
		// Every row of every table names Acme as its organisation.
		for (const [name, bytes] of files) {
			if (!name.startsWith("tables/") || name === "tables/organisations.csv") continue;
			const [header = [], ...rows] = rowsOf(bytes);
			const column = header.indexOf("organisation_id");
			if (column < 0) continue;
			for (const row of rows) expect(row[column], name).toBe(acme.id);
		}
		// And Acme's own rows are all there: all but the invitations' secret ids,
		// the export's own row, and the record that it was made, written after.
		for (const row of await idsOf(acme.id)) {
			if ((await value("select count(*) from invitations where id = ?", row)) === 1) continue;
			if ((await value("select count(*) from organisation_exports where id = ?", row)) === 1)
				continue;
			if (
				(await value(
					"select count(*) from activity_records where id = ? and action = 'organisation_export.made'",
					row,
				)) === 1
			)
				continue;
			expect(all.includes(row), row).toBe(true);
		}
	});

	it("names a former member's rows by their id alone, as the export of all time does", async () => {
		const leaver = await seedMember(acme.id, "member", "leaver@example.com");
		const project = await seedProject(acme.id, "Old work");
		await seedEntry(
			acme.id,
			leaver.userId,
			project,
			"2026-10-01T09:00:00Z",
			"2026-10-01T10:00:00Z",
		);
		await env.DB.prepare("delete from memberships where id = ?").bind(leaver.memberId).run();
		const { id } = await exportMade(acme.id, ada.user.id);
		const files = await filesOf(await storedZip(acme.id, id));
		const all = [...files.values()].map(text).join("\n");
		expect(
			rowsOf(files.get("tables/time_entries.csv")).some((r) => r.includes(leaver.userId)),
		).toBe(true);
		expect(all).not.toContain("leaver@example.com");
	});

	it("is recorded, and the owner who asked is emailed a link to its page", async () => {
		const { id } = await exportMade(acme.id, ada.user.id);
		const actions = await env.DB.prepare(
			"select action, actor_id, source from activity_records where organisation_id = ? and subject_id = ? order by created_at, id",
		)
			.bind(acme.id, id)
			.all<{ action: string; actor_id: string | null; source: string }>();
		expect(actions.results).toEqual([
			{ action: "organisation_export.requested", actor_id: ada.user.id, source: "web" },
			{ action: "organisation_export.made", actor_id: null, source: "system" },
		]);
		const message = mailbox
			.sent()
			.find((m) => m.subject === "Your export of everything is ready on Timesifier");
		expect(message?.to).toBe("ada@example.com");
		expect(message?.text).toContain("https://timesifier.example/app/acme/settings/export");
		expect(message?.text).toContain("“Acme”");
	});
});

describe("the job", () => {
	/** Limits small enough that every unit is a step of its own, and pages and files are short. */
	const SMALL: ExportLimits = { ...EXPORT_LIMITS, pageRows: 2, fileRows: 3, stepCalls: 4 };

	it("pages each table by id across page boundaries, splits a table into files, and loses or repeats no row", async () => {
		const scope = organisationScope(env.DB, acme.id);
		const [member] = await scope.memberships.select();
		const project = await seedProject(acme.id, "Paged");
		for (let n = 0; n < 8; n++) {
			await seedEntry(
				acme.id,
				member?.userId ?? ada.user.id,
				project,
				`2026-09-0${n + 1}T09:00:00Z`,
				`2026-09-0${n + 1}T10:00:00Z`,
				`Paged ${n}`,
			);
		}
		// Four tags in all: two full pages fill the first file, the next page is empty, and no empty file follows.
		for (let n = 0; n < 3; n++) await scope.tags.insert({ name: `Tag ${n}`, nameKey: `tag-${n}` });
		const { id, steps } = await exportMade(acme.id, ada.user.id, SMALL);
		expect(steps).toBeGreaterThan(60);
		const files = await filesOf(await storedZip(acme.id, id));
		const manifest = manifestOf(files);

		const entryFiles = manifest.files.filter((f) => f.table === "time_entries").map((f) => f.name);
		expect(entryFiles).toEqual([
			"tables/time_entries.csv",
			"tables/time_entries-2.csv",
			"tables/time_entries-3.csv",
		]);
		const ids = entryFiles.flatMap((name) => {
			const [header = [], ...rows] = rowsOf(files.get(name));
			expect(header[0]).toBe("id");
			expect(rows.length).toBeLessThanOrEqual(SMALL.fileRows + SMALL.pageRows - 1);
			return rows.map((r) => r[0]);
		});
		const stored = await env.DB.prepare(
			"select id from time_entries where organisation_id = ? order by id",
		)
			.bind(acme.id)
			.all<{ id: string }>();
		expect(ids).toEqual(stored.results.map((r) => r.id));
		expect(manifest.tables.time_entries).toBe(11);

		expect(manifest.files.filter((f) => f.table === "tags").map((f) => [f.name, f.rows])).toEqual([
			["tables/tags.csv", 4],
		]);
	});

	it("keeps its place between steps, uploads parts of 5 MiB as it goes, and makes one ZIP of them", async () => {
		// Two receipts of 3 MiB that do not compress: the ZIP passes one part.
		const scope = organisationScope(env.DB, acme.id);
		const expenses = await scope.expenses.select();
		const big = new Uint8Array(3 * 1024 * 1024);
		for (let at = 0; at < big.length; at += 65_536) {
			crypto.getRandomValues(big.subarray(at, at + 65_536));
		}
		big.set(new TextEncoder().encode("%PDF-1.4"));
		const [first] = expenses;
		if (!first) throw new Error("no expense");
		await env.RECEIPTS.put(receiptKey(acme.id, first.id), big);
		const second = await recordExpense(scope, ada.user.id, {
			spentOn: "2026-10-14",
			projectId: first.projectId,
			categoryId: first.categoryId,
			amount: "3.00",
			quantity: "",
			notes: "",
			billable: false,
			reimbursable: true,
			receipt: new File(["%PDF-1.4"], "second.pdf", { type: "application/pdf" }),
			removeReceipt: false,
		});
		if (!second.ok) throw new Error("seed failed");
		const other = big.slice();
		other[100] = (other[100] ?? 0) ^ 0xff;
		await env.RECEIPTS.put(receiptKey(acme.id, second.id), other);

		const now = new Date();
		const requested = await requestExport(scope, ada.user.id, now);
		if (!requested.ok) throw new Error(requested.problem);
		const seen = { steps: 0, parts: 0, kept: false };
		for (;;) {
			const stepped = await advanceExport(acme.id, requested.id, now, {
				...EXPORT_LIMITS,
				stepCalls: 5,
			});
			seen.steps += 1;
			if (stepped === "ready") break;
			expect(stepped).toBe("running");
			const [row] = await scope.organisationExports.select();
			seen.parts = Math.max(seen.parts, row?.parts.length ?? 0);
			// What the next step starts from is kept in R2 under its number.
			const listed = await env.RECEIPTS.list({ prefix: `org/${acme.id}/exports/${requested.id}/` });
			if (listed.objects.length > 0) seen.kept = true;
		}
		expect(seen.steps).toBeGreaterThan(10);
		expect(seen.parts).toBe(1);
		expect(seen.kept).toBe(true);

		const zip = await storedZip(acme.id, requested.id);
		expect(zip.length).toBeGreaterThan(EXPORT_LIMITS.partBytes);
		const files = await filesOf(zip);
		expect(files.get(`receipts/${first.id}.pdf`)).toEqual(big);
		expect(files.get(`receipts/${second.id}.pdf`)).toEqual(other);
		// Nothing of the work is left once it is made.
		const left = await env.RECEIPTS.list({ prefix: `org/${acme.id}/exports/` });
		expect(left.objects.map((o) => o.key)).toEqual([exportKey(acme.id, requested.id)]);
		const [row] = await scope.organisationExports.select();
		expect(row).toMatchObject({ status: "ready", uploadId: null, parts: [], size: zip.length });
	}, 60_000);

	it("runs a failed step again from where the last one ended, and fails the export after three in a row", async () => {
		const scope = organisationScope(env.DB, acme.id);
		const now = new Date();
		const requested = await requestExport(scope, ada.user.id, now);
		if (!requested.ok) throw new Error(requested.problem);
		const small = { ...EXPORT_LIMITS, stepCalls: 6 };
		expect(await advanceExport(acme.id, requested.id, now, small)).toBe("running");
		const get = vi.spyOn(env.RECEIPTS, "get").mockRejectedValueOnce(new Error("R2 is away"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		const [before] = await scope.organisationExports.select();
		expect(await advanceExport(acme.id, requested.id, now, small)).toBe("running");
		const [after] = await scope.organisationExports.select();
		expect(after?.failures).toBe(1);
		expect(after?.progress).toEqual(before?.progress);
		get.mockRestore();
		for (;;) {
			const stepped = await advanceExport(acme.id, requested.id, now, small);
			if (stepped === "ready") break;
			expect(stepped).toBe("running");
		}
		// The same rows as an export made without a failure, the activity log aside, which records them.
		const retried = manifestOf(await filesOf(await storedZip(acme.id, requested.id)));
		const again = await exportMade(acme.id, ada.user.id);
		const clean = manifestOf(await filesOf(await storedZip(acme.id, again.id)));
		const { activity_records: _retriedLog, ...retriedTables } = retried.tables;
		const { activity_records: _cleanLog, ...cleanTables } = clean.tables;
		expect(retriedTables).toEqual(cleanTables);

		// Three failures in a row: failed, its work deleted, and the owner told.
		await env.DB.prepare("delete from organisation_exports").run();
		const third = await requestExport(scope, ada.user.id, now);
		if (!third.ok) throw new Error(third.problem);
		vi.spyOn(env.RECEIPTS, "get").mockRejectedValue(new Error("R2 is away"));
		expect(await advanceExport(acme.id, third.id, now)).toBe("running");
		expect(await advanceExport(acme.id, third.id, now)).toBe("running");
		expect(await advanceExport(acme.id, third.id, now)).toBe("failed");
		expect(await exportStateOf(scope, now)).toMatchObject({ status: "failed" });
		expect(
			mailbox
				.sent()
				.some((m) => m.subject === "Your export of everything could not be made on Timesifier"),
		).toBe(true);
		expect(
			await value(
				"select count(*) from activity_records where subject_id = ? and action = 'organisation_export.failed'",
				third.id,
			),
		).toBe(1);
	}, 60_000);

	it("holds a step against a second one, and the trigger steps the oldest export free of one", async () => {
		const scope = organisationScope(env.DB, acme.id);
		const now = new Date();
		const requested = await requestExport(scope, ada.user.id, now);
		if (!requested.ok) throw new Error(requested.problem);
		await scope.organisationExports.update(
			{ leaseUntil: new Date(now.getTime() + 60_000) },
			everyRow,
		);
		expect(await advanceExport(acme.id, requested.id, now)).toBe("busy");
		expect(await advanceExports(now)).toBeNull();
		// Past its lease, the trigger takes it up.
		expect(await advanceExports(new Date(now.getTime() + 61_000))).toBe("ready");
	});

	it("lets one export be made at a time, and a new one replaces the last", async () => {
		const scope = organisationScope(env.DB, acme.id);
		const now = new Date();
		const first = await requestExport(scope, ada.user.id, now);
		expect(first.ok).toBe(true);
		expect(await requestExport(scope, ada.user.id, now)).toEqual({
			ok: false,
			problem: "An export is being made already. You'll get an email when it's ready.",
		});
		if (!first.ok) return;
		expect(await advanceExport(acme.id, first.id, now)).toBe("ready");
		const second = await exportMade(acme.id, ada.user.id);
		expect(await env.RECEIPTS.head(exportKey(acme.id, first.id))).toBeNull();
		expect(await env.RECEIPTS.head(exportKey(acme.id, second.id))).not.toBeNull();
		expect(await value("select count(*) from organisation_exports")).toBe(1);
	});
});

describe("after 7 days", () => {
	it("is no longer offered, and the hourly trigger deletes its file and its row", async () => {
		const made = new Date();
		const { id } = await exportMade(acme.id, ada.user.id, EXPORT_LIMITS, made);
		const scope = organisationScope(env.DB, acme.id);
		const last = new Date(made.getTime() + 7 * DAY_MS - 1);
		const ended = new Date(made.getTime() + 7 * DAY_MS);
		expect(await exportStateOf(scope, last)).toMatchObject({ status: "ready" });
		expect(await deleteExpiredExports(last)).toBe(0);
		expect(await exportStateOf(scope, ended)).toEqual({ status: "none" });

		// The download stops when the 7 days do, before the trigger has run.
		await env.DB.prepare("update organisation_exports set expires_at = ?")
			.bind(Date.now() - 1)
			.run();
		expect((await open(DOWNLOAD, ada)).status).toBe(404);

		expect(await deleteExpiredExports(ended)).toBe(1);
		expect(await env.RECEIPTS.head(exportKey(acme.id, id))).toBeNull();
		expect(await value("select count(*) from organisation_exports")).toBe(0);
		expect(
			await value(
				"select count(*) from activity_records where subject_id = ? and action = 'organisation_export.deleted' and actor_id is null",
				id,
			),
		).toBe(1);
	});

	it("goes with its organisation, and no other organisation's", async () => {
		const { id } = await exportMade(acme.id, ada.user.id);
		const [bob] = await organisationScope(env.DB, globex.id).memberships.select();
		const theirs = await exportMade(globex.id, bob?.userId ?? "");
		await deleteOrganisationExports(acme.id);
		expect(await env.RECEIPTS.head(exportKey(acme.id, id))).toBeNull();
		expect((await env.RECEIPTS.list({ prefix: `org/${acme.id}/exports/` })).objects).toEqual([]);
		expect(await env.RECEIPTS.head(exportKey(globex.id, theirs.id))).not.toBeNull();
	});
});

describe("who may export", () => {
	type Who = "owner" | "admin" | "finance" | "manager" | "member" | "contractor" | "stranger";
	const ROLES: Who[] = ["owner", "admin", "finance", "manager", "member", "contractor", "stranger"];

	/** A person of each kind, in Acme, but the stranger, who is in Globex alone. */
	async function asWho(who: Who): Promise<Person> {
		if (who === "owner") return ada;
		const someone = await person(mailbox, `${who}@example.com`);
		if (who === "stranger") {
			await seedMembership(globex.id, someone.user.id, "owner");
			return someone;
		}
		const role = who === "manager" || who === "contractor" ? "member" : who;
		await seedMembership(acme.id, someone.user.id, role);
		if (who === "manager") await seedTeam(acme.id, "Managed", { managers: [someone.user.id] });
		if (who === "contractor") {
			await env.DB.prepare(
				"update memberships set is_contractor = 1 where organisation_id = ? and user_id = ?",
			)
				.bind(acme.id, someone.user.id)
				.run();
		}
		return someone;
	}

	it.each(ROLES)(
		"the %s",
		async (who) => {
			const { id } = await exportMade(acme.id, ada.user.id);
			const asker = await asWho(who);
			const owner = who === "owner";

			const page = await open(PAGE, asker);
			expect(page.status).toBe(owner ? 200 : 404);
			const download = await open(DOWNLOAD, asker);
			expect(download.status).toBe(owner ? 200 : 404);
			if (owner) {
				expect(download.headers.get("Content-Type")).toBe("application/zip");
				expect(download.headers.get("Cache-Control")).toBe("no-store");
				expect(download.headers.get("Content-Disposition")).toMatch(
					/^attachment; filename="acme-everything-exported-\d{4}-\d{2}-\d{2}\.zip"$/,
				);
				const bytes = new Uint8Array(await download.arrayBuffer());
				expect(bytes).toEqual(await storedZip(acme.id, id));
			} else {
				await download.arrayBuffer();
			}
			expect(
				await value(
					"select count(*) from activity_records where action = 'organisation_export.downloaded' and actor_id = ?",
					asker.user.id,
				),
			).toBe(owner ? 1 : 0);

			// Asking again: the owner's replaces it; anybody else's is 404 and changes nothing.
			const posted = await submit(PAGE, { intent: "export" }, asker, { byScript: true });
			await posted.arrayBuffer();
			expect(posted.status).toBe(owner ? 200 : 404);
			// The owner's new one is made by the step the request runs after answering.
			if (owner) {
				await vi.waitFor(
					async () =>
						expect(
							await value(
								"select count(*) from organisation_exports where status = 'ready' and organisation_id = ?",
								acme.id,
							),
						).toBe(1),
					{ timeout: 10_000 },
				);
			}
			const rows = await env.DB.prepare(
				"select id, status from organisation_exports where organisation_id = ?",
			)
				.bind(acme.id)
				.all<{ id: string; status: string }>();
			expect(rows.results.length).toBe(1);
			expect(rows.results[0]?.id === id).toBe(!owner);
			expect(
				await value(
					"select count(*) from activity_records where action = 'organisation_export.requested' and actor_id = ?",
					asker.user.id,
				),
				// The owner asked for the first one too.
			).toBe(owner ? 2 : 0);
		},
		60_000,
	);

	it("tells an owner asking while one is being made that it is", async () => {
		const running = await requestExport(
			organisationScope(env.DB, acme.id),
			ada.user.id,
			new Date(),
		);
		expect(running.ok).toBe(true);
		const second = await submit(PAGE, { intent: "export" }, ada, { byScript: true });
		expect(second.status).toBe(409);
		expect(await second.text()).toContain("An export is being made already.");
		expect(await value("select count(*) from organisation_exports")).toBe(1);
	});
});

describe("ZIP64", () => {
	it("writes a file's place past 4 GiB in its extra field", async () => {
		const offset = 5 * 1024 ** 3;
		const { central } = await zipFile(
			{ name: "far.csv", bytes: new TextEncoder().encode("a\r\n"), modified: new Date() },
			offset,
		);
		const view = new DataView(central.buffer);
		expect(view.getUint16(6, true)).toBe(45);
		expect(view.getUint32(42, true)).toBe(0xffff_ffff);
		expect(localOffset(view, 0)).toBe(offset);
		const near = await zipFile(
			{ name: "near.csv", bytes: new TextEncoder().encode("a\r\n"), modified: new Date() },
			10,
		);
		expect(new DataView(near.central.buffer).getUint16(30, true)).toBe(0);
	});

	it("writes ZIP64's end record and locator past 65,535 files or 4 GiB, and not before", () => {
		const comment = new TextEncoder().encode("Acme");
		const plain = zipEnd(3, 100, 50, comment);
		expect(plain.length).toBe(22 + comment.length);
		for (const [count, start] of [
			[70_000, 100],
			[3, 5 * 1024 ** 3],
		] as const) {
			const end = zipEnd(count, start, 50, comment);
			// A file of the end alone, its directory as if before it.
			const file = new Uint8Array(end);
			const view = new DataView(file.buffer);
			expect(view.getUint32(0, true)).toBe(0x0606_4b50);
			expect(view.getUint32(56, true)).toBe(0x0706_4b50);
			expect(Number(view.getBigUint64(32, true))).toBe(count);
			expect(Number(view.getBigUint64(48, true))).toBe(start);
			expect(Number(view.getBigUint64(64, true))).toBe(start + 50);
			expect(endRecord(file).comment).toBe("Acme");
		}
	});
});
