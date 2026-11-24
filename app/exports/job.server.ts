import { env } from "cloudflare:workers";
import { and, asc, eq, getTableColumns, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as z from "zod";

import { record, recordStatement } from "~/activity/activity.server";
import { EXTENSIONS } from "~/brand/images";
import { MADE_WITH } from "~/brand/made-with";
import {
	logoFile,
	logoRenditionFile,
	organisationBrandOf,
} from "~/brand/organisation-brand.server";
import {
	among,
	EXPORTED_TABLES,
	type ExportedTable,
	expiredExports,
	exportedPage,
	exportedTable,
	type OrganisationScope,
	organisationScope,
	organisations,
	runningExports,
	type ScopedStatement,
	type TenantRow,
	users,
	uuidv7,
} from "~/db";
import { getReceipt } from "~/expenses/receipts.server";
import { type ZipEntry, zipEnd, zipFile } from "~/lib/zip";
import {
	exportFailed,
	exportReady,
	type NewNotification,
	notificationStatements,
} from "~/notifications/words";
import { exportFilename } from "~/organisations/export-filename";
import { BYTE_ORDER_MARK, csvLine } from "~/reports/csv";
import { dayOf } from "~/time/calendar";

import { EXPORT_FORMAT_VERSION, EXPORT_KEEP_DAYS } from "./paths";

/**
 * The export of everything an organisation holds (TS-126, docs/decisions.md
 * entry 71): one ZIP of every table of the organisation as CSV with a header
 * row, its receipts and its logo as files, and `manifest.json`, which lists
 * each file, its rows and the export's time and version.
 *
 * A 300-person organisation holds hundreds of thousands of rows and may hold
 * gigabytes of receipts, more than one invocation of a Worker may read or hold
 * (128 MB of memory, 30 seconds of CPU, 1,000 D1 queries). So the ZIP is made
 * as a job, a step at a time, into one R2 multipart upload in the `RECEIPTS`
 * bucket, under the organisation's own prefix, `org/<id>/exports/`:
 *
 * - The owner's request makes the row and the upload, and runs the first step
 *   after answering (`waitUntil`); the every-minute trigger runs the next, one
 *   step a minute, until it is made. A small organisation's is made at once.
 * - A step stops after `stepMs` or `stepCalls` reads and writes, whichever
 *   comes first, between two files. Each file is made whole in memory: a CSV
 *   holds at most `fileRows` rows or `fileChars` characters, and a table past
 *   that is written as several files, each with its header. Its rows are read
 *   `pageRows` at a time, each page after the last id of the one before.
 * - Bytes go up in parts of exactly `partBytes`, as R2 asks of every part but
 *   the last. What is left over at the end of a step, the ZIP's directory so
 *   far and the files listed so far are kept in R2 beside the upload, under
 *   the step's number, so a step that fails is run again from where the last
 *   one ended, and uploads the same parts again under the same numbers.
 * - A step holds the row by `lease_until`, so two never run at once; one that
 *   fails three times running fails the export, and the owner is told.
 * - Once made, or failed, the owner who asked is told, in the bell and by
 *   email (TS-126b). The file is kept for `EXPORT_KEEP_DAYS` days, then
 *   deleted with its row by the hourly trigger.
 */

export interface ExportLimits {
	/** Rows one statement reads. */
	pageRows: number;
	/** Rows one CSV file holds at most. */
	fileRows: number;
	/** Characters one CSV file holds at most, past which the next page starts a new file. */
	fileChars: number;
	/** Expenses with a receipt one statement reads. */
	receiptsPage: number;
	/** The size of each uploaded part but the last. R2 asks at least 5 MiB, all the same. */
	partBytes: number;
	/** Milliseconds after which a step stops, between two files. */
	stepMs: number;
	/** Reads and writes of D1 and R2 after which a step stops, between two files. */
	stepCalls: number;
}

/**
 * The limits of a step. One file is at most `fileRows / pageRows` = 50
 * queries and two parts, so a step stays far below D1's 1,000 queries an
 * invocation; 15 seconds of time leaves the trigger's other work room within
 * the 30 seconds of CPU a Worker has by default; and a file of 8 million
 * characters, encoded and deflated, with a part waiting, is under 50 MB.
 */
export const EXPORT_LIMITS: ExportLimits = {
	pageRows: 1_000,
	fileRows: 50_000,
	fileChars: 8 * 1024 * 1024,
	receiptsPage: 50,
	partBytes: 5 * 1024 * 1024,
	stepMs: 15_000,
	stepCalls: 400,
};

/** How long a step holds the row: far longer than a step runs. */
const LEASE_MS = 2 * 60 * 1000;
/** Steps that fail running after which the export fails. */
const MOST_FAILURES = 3;
/** Running exports the trigger looks at, oldest first, for one free of a step. */
const RUNNING_LOOKED_AT = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A receipt's file is named by its expense, with the extension of its kind. */
const RECEIPT_EXTENSIONS: Record<string, string> = {
	"application/pdf": "pdf",
	"image/png": "png",
	"image/jpeg": "jpg",
};

/** What a person is told when an export is asked for while one is being made. */
export const ALREADY_RUNNING =
	"An export is being made already. We'll tell you in the bell and by email when it's ready.";

type ExportRow = TenantRow<"organisationExports">;

/** Where the next step starts, as the row keeps it. */
const Progress = z.object({
	/** The step's number, which names the work kept between steps. */
	step: z.number().int().nonnegative(),
	phase: z.enum(["tables", "receipts", "brand", "finish"]),
	/** Which of `SOURCES` the tables have reached. */
	source: z.number().int().nonnegative(),
	/** The last id read, of the source or of the expenses with receipts. */
	after: z.string().nullable(),
	/** The number of the source's next file, from 1. */
	file: z.number().int().positive(),
	/** Bytes of the ZIP made so far, those left over included. */
	offset: z.number().int().nonnegative(),
	/** Files in the ZIP so far. */
	entries: z.number().int().nonnegative(),
	startedAt: z.number().int(),
});
type Progress = z.infer<typeof Progress>;

/** One file as `manifest.json` lists it. */
const Listed = z.object({
	name: z.string(),
	table: z.string().optional(),
	rows: z.number().int().optional(),
	bytes: z.number().int(),
});
type Listed = z.infer<typeof Listed>;

// ---------------------------------------------------------------------------
// What is read: the organisation's own row, its members' accounts, and every
// tenant table.

/**
 * Where the rows come from, in the order they are written: the organisation's
 * own row; the account of each member, as much of it as the organisation
 * sees (name, address and time zone; never a former member's, whose rows
 * keep their id and nothing more, as the export of all time does); then
 * every table of the organisation.
 */
type Source = "organisations" | "users" | ExportedTable;
const SOURCES: readonly Source[] = ["organisations", "users", ...EXPORTED_TABLES];

const ORGANISATION_COLUMNS = Object.entries(getTableColumns(organisations)).map(
	([key, column]) => ({ key, name: column.name }),
);
const MEMBER_COLUMNS = [
	{ key: "id", name: "id" },
	{ key: "name", name: "name" },
	{ key: "email", name: "email" },
	{ key: "timeZone", name: "time_zone" },
	{ key: "createdAt", name: "created_at" },
] as const;

/** The SQL name a source's files are named by, and its header. */
function shapeOf(source: Source): { name: string; header: string[] } {
	if (source === "organisations") {
		return { name: "organisations", header: ORGANISATION_COLUMNS.map((c) => c.name) };
	}
	if (source === "users") return { name: "users", header: MEMBER_COLUMNS.map((c) => c.name) };
	const { sqlName, columns } = exportedTable(source);
	return { name: sqlName, header: columns.map((c) => c.name) };
}

/** A page of a source, after the row whose id is `after`. */
async function pageOf(
	scope: OrganisationScope,
	source: Source,
	after: string | null,
	limit: number,
	budget: Budget,
): Promise<{ rows: unknown[][]; last: string | null }> {
	budget.spend();
	if (source === "organisations") {
		if (after !== null) return { rows: [], last: null };
		const found = await drizzle(env.DB)
			.select()
			.from(organisations)
			.where(eq(organisations.id, scope.organisationId))
			.limit(1);
		const row: Record<string, unknown> | undefined = found[0];
		return {
			rows: row ? [ORGANISATION_COLUMNS.map(({ key }) => row[key])] : [],
			last: scope.organisationId,
		};
	}
	if (source === "users") {
		const members = await scope.memberships.select(
			(m) => (after === null ? undefined : gt(m.id, after)),
			{ orderBy: (m) => [asc(m.id)], limit },
		);
		if (members.length === 0) return { rows: [], last: null };
		budget.spend();
		const accounts = await drizzle(env.DB)
			.select({
				id: users.id,
				name: users.name,
				email: users.email,
				timeZone: users.timeZone,
				createdAt: users.createdAt,
			})
			.from(users)
			.where(
				among(
					users.id,
					members.map((m) => m.userId),
				),
			);
		const byId = new Map(accounts.map((a) => [a.id, a]));
		return {
			rows: members.flatMap((m) => {
				const account: Record<string, unknown> | undefined = byId.get(m.userId);
				return account ? [MEMBER_COLUMNS.map(({ key }) => account[key])] : [];
			}),
			last: members.at(-1)?.id ?? null,
		};
	}
	return exportedPage(scope, source, after, limit);
}

/** One value as a cell: an instant in ISO 8601 UTC to the millisecond, JSON as JSON, nothing as empty. */
function cellOf(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "bigint") return String(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	return JSON.stringify(value);
}

/**
 * One CSV file of `source` from after `after`: its header, then rows until
 * the file is full or the source has no more. `done` is whether it has none.
 */
async function csvFile(
	scope: OrganisationScope,
	source: Source,
	after: string | null,
	limits: ExportLimits,
	budget: Budget,
): Promise<{ text: string; rows: number; last: string | null; done: boolean }> {
	let text = BYTE_ORDER_MARK + csvLine(shapeOf(source).header);
	let rows = 0;
	let last = after;
	for (;;) {
		const page = await pageOf(scope, source, last, limits.pageRows, budget);
		for (const row of page.rows) text += csvLine(row.map(cellOf));
		rows += page.rows.length;
		if (page.last === null || page.rows.length < limits.pageRows || source === "organisations") {
			return { text, rows, last: page.last ?? last, done: true };
		}
		last = page.last;
		if (rows >= limits.fileRows || text.length >= limits.fileChars) {
			return { text, rows, last, done: false };
		}
	}
}

// ---------------------------------------------------------------------------
// How it is written: a step's reads and writes, and the ZIP's bytes in parts.

/** The reads and writes a step has made, and the time it has left. */
class Budget {
	private calls = 0;
	private readonly until: number;

	constructor(private readonly limits: ExportLimits) {
		this.until = Date.now() + limits.stepMs;
	}

	spend(calls = 1): void {
		this.calls += calls;
	}

	get left(): boolean {
		return this.calls < this.limits.stepCalls && Date.now() < this.until;
	}
}

type Part = { partNumber: number; etag: string };

function joined(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	return bytes;
}

/**
 * The ZIP's bytes on their way into the upload: files added through
 * `zipFile`, held until a part of exactly `partBytes` can go up. Keeps the
 * directory records and the listing of the files it added.
 */
class ZipParts {
	private pending: Uint8Array[] = [];
	private pendingBytes = 0;
	readonly directory: Uint8Array[] = [];
	readonly listing: string[] = [];

	constructor(
		private readonly upload: R2MultipartUpload,
		readonly parts: Part[],
		carried: Uint8Array,
		private readonly partBytes: number,
		public offset: number,
		public entries: number,
		private readonly budget: Budget,
	) {
		if (carried.length > 0) this.write(carried);
	}

	/** Adds a file, listed in the manifest unless `listed` is null. */
	async add(entry: ZipEntry, listed: Omit<Listed, "bytes"> | null): Promise<void> {
		const file = await zipFile(entry, this.offset);
		this.offset += file.header.length + file.data.length;
		this.entries += 1;
		this.directory.push(file.central);
		if (listed) {
			this.listing.push(`${JSON.stringify({ ...listed, bytes: entry.bytes.length })}\n`);
		}
		this.write(file.header);
		this.write(file.data);
		await this.send();
	}

	/** Bytes that follow the files: the directory and the end. */
	write(bytes: Uint8Array): void {
		this.pending.push(bytes);
		this.pendingBytes += bytes.length;
	}

	/** Uploads every whole part held. */
	async send(): Promise<void> {
		while (this.pendingBytes >= this.partBytes) await this.uploadPart(this.take(this.partBytes));
	}

	/** What is held after the last whole part, taken out. */
	leftOver(): Uint8Array<ArrayBuffer> {
		return this.take(this.pendingBytes);
	}

	/** Uploads every part held, the last shorter. */
	async close(): Promise<void> {
		await this.send();
		if (this.pendingBytes > 0 || this.parts.length === 0) await this.uploadPart(this.leftOver());
	}

	private take(size: number): Uint8Array<ArrayBuffer> {
		const all = joined(this.pending);
		this.pending = all.length > size ? [all.subarray(size)] : [];
		this.pendingBytes = all.length - size;
		return all.slice(0, size);
	}

	private async uploadPart(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
		this.budget.spend();
		const uploaded = await this.upload.uploadPart(this.parts.length + 1, bytes);
		this.parts.push({ partNumber: uploaded.partNumber, etag: uploaded.etag });
	}
}

// ---------------------------------------------------------------------------
// Where it is kept.

function exportsPrefix(organisationId: string): string {
	return `org/${organisationId}/exports/`;
}

/** The key of an export's ZIP: built from its row, never from a request. */
export function exportKey(organisationId: string, id: string): string {
	return `${exportsPrefix(organisationId)}${id}.zip`;
}

type Work = "carry" | "directory" | "listing";
const WORK: readonly Work[] = ["carry", "directory", "listing"];

/** What one step leaves the next, under the step's number. */
function workKey(organisationId: string, id: string, step: number, work: Work): string {
	return `${exportsPrefix(organisationId)}${id}/${step}/${work}`;
}

async function readWork(key: string): Promise<Uint8Array<ArrayBuffer>> {
	const object = await env.RECEIPTS.get(key);
	return object ? new Uint8Array(await object.arrayBuffer()) : new Uint8Array();
}

/** Deletes every object under `prefix` in the bucket. */
async function deleteUnder(prefix: string): Promise<void> {
	let cursor: string | undefined;
	do {
		const page = await env.RECEIPTS.list({ prefix, cursor });
		if (page.objects.length > 0) await env.RECEIPTS.delete(page.objects.map(({ key }) => key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}

/** Abandons an export's upload, if it has one still open. An upload already gone is no matter. */
async function abortUpload(row: ExportRow): Promise<void> {
	if (!row.uploadId) return;
	try {
		await env.RECEIPTS.resumeMultipartUpload(
			exportKey(row.organisationId, row.id),
			row.uploadId,
		).abort();
	} catch (error) {
		console.error(`export: upload not aborted, ${error instanceof Error ? error.name : "unknown"}`);
	}
}

// ---------------------------------------------------------------------------
// The steps.

const encoder = new TextEncoder();

/** Does one unit of work: a CSV file, a page of receipts, or the logo. Answers where the next starts. */
async function unit(
	scope: OrganisationScope,
	progress: Progress,
	zip: ZipParts,
	limits: ExportLimits,
	budget: Budget,
	now: Date,
): Promise<Progress> {
	const organisationId = scope.organisationId;
	switch (progress.phase) {
		case "tables": {
			const source = SOURCES[progress.source];
			if (!source) return { ...progress, phase: "receipts", source: 0, after: null, file: 1 };
			const file = await csvFile(scope, source, progress.after, limits, budget);
			// Every source has a file, of a header alone when it has no rows; a
			// table that ends exactly where its last file did has no empty one after.
			if (file.rows > 0 || progress.file === 1) {
				const { name } = shapeOf(source);
				const fileName =
					progress.file === 1 ? `tables/${name}.csv` : `tables/${name}-${progress.file}.csv`;
				await zip.add(
					{ name: fileName, bytes: encoder.encode(file.text), modified: now },
					{ name: fileName, table: name, rows: file.rows },
				);
			}
			return file.done
				? { ...progress, source: progress.source + 1, after: null, file: 1 }
				: { ...progress, after: file.last, file: progress.file + 1 };
		}
		case "receipts": {
			budget.spend();
			const expenses = await scope.expenses.select(
				(e) =>
					and(
						isNotNull(e.receiptKey),
						progress.after === null ? undefined : gt(e.id, progress.after),
					),
				{ orderBy: (e) => [asc(e.id)], limit: limits.receiptsPage },
			);
			let after = progress.after;
			for (const expense of expenses) {
				// At least one receipt a unit, so a step always moves on.
				if (after !== progress.after && !budget.left) return { ...progress, after };
				budget.spend();
				const file = await getReceipt(organisationId, expense.id);
				if (file) {
					const name = `receipts/${expense.id}.${RECEIPT_EXTENSIONS[expense.receiptType ?? ""] ?? "bin"}`;
					await zip.add(
						{ name, bytes: new Uint8Array(await file.arrayBuffer()), modified: now },
						{ name },
					);
				}
				after = expense.id;
			}
			return expenses.length < limits.receiptsPage
				? { ...progress, phase: "brand", after: null }
				: { ...progress, after };
		}
		case "brand": {
			budget.spend();
			const brand = await organisationBrandOf(organisationId);
			if (brand?.logo) {
				budget.spend();
				const logo = await logoFile(organisationId);
				if (logo) {
					const name = `brand/logo.${EXTENSIONS[brand.logo.type]}`;
					await zip.add(
						{ name, bytes: new Uint8Array(await logo.arrayBuffer()), modified: now },
						{ name },
					);
				}
				if (brand.logo.rendition) {
					budget.spend();
					const drawn = await logoRenditionFile(organisationId);
					if (drawn) {
						const name = "brand/logo-drawn.png";
						await zip.add(
							{ name, bytes: new Uint8Array(await drawn.arrayBuffer()), modified: now },
							{ name },
						);
					}
				}
			}
			return { ...progress, phase: "finish" };
		}
		case "finish":
			return progress;
	}
}

/** The manifest: the organisation, the export's times and version, and each file with its rows. */
function manifestOf(
	organisation: { id: string; name: string },
	listed: readonly Listed[],
	startedAt: number,
	now: Date,
) {
	const tables: Record<string, number> = {};
	for (const file of listed) {
		if (file.table !== undefined) tables[file.table] = (tables[file.table] ?? 0) + (file.rows ?? 0);
	}
	const withheld: Record<string, string[]> = {};
	for (const name of EXPORTED_TABLES) {
		const table = exportedTable(name);
		if (table.withheld.length > 0) withheld[table.sqlName] = table.withheld;
	}
	return {
		format: "Timesifier export of everything",
		version: EXPORT_FORMAT_VERSION,
		organisation,
		startedAt: new Date(startedAt).toISOString(),
		exportedAt: now.toISOString(),
		tables,
		withheld,
		files: listed,
	};
}

/** The organisation's name and zone, which the ZIP's comment, the notice's day and the file's name use. */
async function organisationOf(organisationId: string) {
	const [row] = await drizzle(env.DB)
		.select({
			name: organisations.name,
			timeZone: organisations.timeZone,
		})
		.from(organisations)
		.where(eq(organisations.id, organisationId))
		.limit(1);
	return row ?? null;
}

/**
 * The last step: `manifest.json`, the directory and the end record, the last
 * part, and the upload completed. The row is marked made, to be deleted
 * after `EXPORT_KEEP_DAYS` days, and the owner who asked is told.
 */
async function finish(
	scope: OrganisationScope,
	row: ExportRow,
	lease: Date,
	progress: Progress,
	zip: ZipParts,
	upload: R2MultipartUpload,
	kept: { directory: Uint8Array; listing: Uint8Array },
	now: Date,
): Promise<void> {
	const organisation = await organisationOf(scope.organisationId);
	if (!organisation) throw new Error("The organisation has gone.");
	const listed = new TextDecoder()
		.decode(joined([kept.listing, encoder.encode(zip.listing.join(""))]))
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => Listed.parse(JSON.parse(line)));
	const manifest = manifestOf(
		{ id: scope.organisationId, name: organisation.name },
		listed,
		progress.startedAt,
		now,
	);
	await zip.add(
		{
			name: "manifest.json",
			bytes: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`),
			modified: now,
		},
		null,
	);
	const directory = joined([kept.directory, ...zip.directory]);
	const start = zip.offset;
	const day = dayOf(now.getTime(), organisation.timeZone);
	const comment = `${organisation.name}: everything, exported ${day}. ${MADE_WITH}.`;
	zip.write(directory);
	zip.write(zipEnd(zip.entries, start, directory.length, encoder.encode(comment)));
	await zip.close();
	const object = await upload.complete(zip.parts);
	const subject = { type: "organisation_export" as const, id: row.id };
	const keptUntil = dayOf(now.getTime() + EXPORT_KEEP_DAYS * DAY_MS, organisation.timeZone);
	await scope.batch([
		scope.organisationExports.statements.update(
			{
				status: "ready",
				progress: { ...progress, phase: "finish", offset: zip.offset, entries: zip.entries },
				parts: [],
				uploadId: null,
				size: object.size,
				leaseUntil: null,
				finishedAt: now,
				expiresAt: new Date(now.getTime() + EXPORT_KEEP_DAYS * DAY_MS),
				updatedAt: now,
			},
			(e) => and(eq(e.id, row.id), eq(e.leaseUntil, lease)),
		),
		recordStatement(scope, null, "organisation_export.made", subject, {}, "system"),
		...(await toldOwner(scope, row, (userId) => exportReady(userId, row.id, keptUntil))),
	]);
	await deleteUnder(`${exportsPrefix(scope.organisationId)}${row.id}/`);
}

/** One step of the export `row`, which this invocation holds until `lease`. */
async function step(
	scope: OrganisationScope,
	row: ExportRow,
	lease: Date,
	now: Date,
	limits: ExportLimits,
): Promise<"running" | "ready"> {
	if (!row.uploadId) throw new Error("The export has no upload.");
	const organisationId = scope.organisationId;
	let progress = Progress.parse(row.progress);
	const upload = env.RECEIPTS.resumeMultipartUpload(
		exportKey(organisationId, row.id),
		row.uploadId,
	);
	const budget = new Budget(limits);
	budget.spend(WORK.length);
	const [carry = new Uint8Array(), directory = new Uint8Array(), listing = new Uint8Array()] =
		await Promise.all(
			WORK.map((work) => readWork(workKey(organisationId, row.id, progress.step, work))),
		);
	const zip = new ZipParts(
		upload,
		[...row.parts],
		carry,
		limits.partBytes,
		progress.offset,
		progress.entries,
		budget,
	);
	while (progress.phase !== "finish" && budget.left) {
		progress = await unit(scope, progress, zip, limits, budget, now);
	}
	if (progress.phase === "finish") {
		await finish(scope, row, lease, progress, zip, upload, { directory, listing }, now);
		return "ready";
	}
	// What the next step starts from, kept under its own number, so this
	// step's stays whole until the row says the next one starts there.
	const next = progress.step + 1;
	const left: Record<Work, Uint8Array> = {
		carry: zip.leftOver(),
		directory: joined([directory, ...zip.directory]),
		listing: joined([listing, encoder.encode(zip.listing.join(""))]),
	};
	await Promise.all(
		WORK.filter((work) => left[work].length > 0).map((work) =>
			env.RECEIPTS.put(workKey(organisationId, row.id, next, work), left[work]),
		),
	);
	const saved = await scope.organisationExports.update(
		{
			progress: { ...progress, step: next, offset: zip.offset, entries: zip.entries },
			parts: zip.parts,
			failures: 0,
			leaseUntil: null,
			updatedAt: now,
		},
		(e) => and(eq(e.id, row.id), eq(e.leaseUntil, lease)),
	);
	if (saved.length > 0) {
		await env.RECEIPTS.delete(
			WORK.map((work) => workKey(organisationId, row.id, progress.step, work)),
		);
	}
	return "running";
}

/** What became of a step: the export moved on, was made, failed, or was not there to step. */
export type Stepped = "running" | "ready" | "failed" | "busy";

/**
 * Runs one step of export `id` of `organisationId`, unless another step holds
 * it. A step that throws is tried again by the next trigger; after
 * `MOST_FAILURES` in a row the export fails, its upload and its work are
 * deleted, and the owner who asked is told.
 */
export async function advanceExport(
	organisationId: string,
	id: string,
	now: Date,
	limits: ExportLimits = EXPORT_LIMITS,
): Promise<Stepped> {
	const scope = organisationScope(env.DB, organisationId);
	const lease = new Date(now.getTime() + LEASE_MS);
	const [row] = await scope.organisationExports.update({ leaseUntil: lease }, (e) =>
		and(eq(e.id, id), eq(e.status, "running"), or(isNull(e.leaseUntil), lte(e.leaseUntil, now))),
	);
	if (!row) return "busy";
	try {
		return await step(scope, row, lease, now, limits);
	} catch (error) {
		console.error(`export: a step failed, ${error instanceof Error ? error.name : "unknown"}`);
		if (row.failures + 1 < MOST_FAILURES) {
			await scope.organisationExports.update(
				{ failures: row.failures + 1, leaseUntil: null, updatedAt: now },
				(e) => and(eq(e.id, row.id), eq(e.leaseUntil, lease)),
			);
			return "running";
		}
		await abortUpload(row);
		await deleteUnder(`${exportsPrefix(organisationId)}${row.id}/`);
		await scope.batch([
			scope.organisationExports.statements.update(
				{
					status: "failed",
					failures: row.failures + 1,
					uploadId: null,
					parts: [],
					leaseUntil: null,
					finishedAt: now,
					expiresAt: new Date(now.getTime() + EXPORT_KEEP_DAYS * DAY_MS),
					updatedAt: now,
				},
				(e) => eq(e.id, row.id),
			),
			recordStatement(
				scope,
				null,
				"organisation_export.failed",
				{ type: "organisation_export", id: row.id },
				{},
				"system",
			),
			...(await toldOwner(scope, row, (userId) => exportFailed(userId, row.id))),
		]);
		return "failed";
	}
}

/**
 * The every-minute trigger's part: one step of the oldest export being made
 * that no other step holds, in any organisation. One a minute keeps the
 * trigger's own time and CPU within a Worker's limits whatever the number of
 * exports; an organisation's request runs its first step itself.
 */
export async function advanceExports(
	now: Date,
	limits: ExportLimits = EXPORT_LIMITS,
): Promise<Stepped | null> {
	for (const running of await runningExports(env.DB, RUNNING_LOOKED_AT)) {
		const stepped = await advanceExport(running.organisationId, running.id, now, limits);
		if (stepped !== "busy") return stepped;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Asking, reading, downloading and deleting.

export type Requested = { ok: true; id: string } | { ok: false; problem: string };

/** The first step's place: the organisation's own row, from the start. */
function initialProgress(now: Date): Progress {
	return {
		step: 0,
		phase: "tables",
		source: 0,
		after: null,
		file: 1,
		offset: 0,
		entries: 0,
		startedAt: now.getTime(),
	};
}

/**
 * Asks for an export of everything, as `actorId`, an owner: refused while one
 * is being made; otherwise the last one, made or failed, is deleted, and the
 * new one's row and upload are made and the request is recorded. The caller
 * runs its first step.
 */
export async function requestExport(
	scope: OrganisationScope,
	actorId: string,
	now: Date,
): Promise<Requested> {
	const earlier = await scope.organisationExports.select();
	if (earlier.some((e) => e.status === "running")) return { ok: false, problem: ALREADY_RUNNING };
	for (const old of earlier) await deleteExport(scope, old, actorId);
	const id = uuidv7(now.getTime());
	const upload = await env.RECEIPTS.createMultipartUpload(exportKey(scope.organisationId, id), {
		httpMetadata: { contentType: "application/zip" },
	});
	try {
		await scope.batch([
			scope.organisationExports.statements.insert({
				id,
				requestedBy: actorId,
				progress: initialProgress(now),
				uploadId: upload.uploadId,
				createdAt: now,
				updatedAt: now,
			}),
			recordStatement(scope, actorId, "organisation_export.requested", {
				type: "organisation_export",
				id,
			}),
		]);
	} catch (error) {
		await upload.abort();
		// Another request got there first: the index allows one running export.
		const [running] = await scope.organisationExports.select((e) => eq(e.status, "running"));
		if (running) return { ok: false, problem: ALREADY_RUNNING };
		throw error;
	}
	return { ok: true, id };
}

/** The organisation's export as its page shows it: none, being made, made, past its 7 days, or failed. */
export type ExportState =
	| { status: "none" }
	| { status: "running"; requestedAt: Date }
	| { status: "ready"; finishedAt: Date; expiresAt: Date; size: number }
	| { status: "expired"; finishedAt: Date; expiresAt: Date }
	| { status: "failed"; requestedAt: Date };

/**
 * The organisation's export: there is at most one. A made one past its 7 days
 * is expired until the hourly trigger deletes it, and none after.
 */
export async function exportStateOf(scope: OrganisationScope, now: Date): Promise<ExportState> {
	const [row] = await scope.organisationExports.select(undefined, {
		orderBy: (e) => [asc(e.createdAt)],
	});
	if (!row) return { status: "none" };
	if (row.status === "running") return { status: "running", requestedAt: row.createdAt };
	if (row.status === "failed") return { status: "failed", requestedAt: row.createdAt };
	if (!row.finishedAt || !row.expiresAt) return { status: "none" };
	if (row.expiresAt.getTime() <= now.getTime()) {
		return { status: "expired", finishedAt: row.finishedAt, expiresAt: row.expiresAt };
	}
	return {
		status: "ready",
		finishedAt: row.finishedAt,
		expiresAt: row.expiresAt,
		size: row.size ?? 0,
	};
}

/**
 * The made export's ZIP as a download, for `actorId`, an owner, and the
 * download recorded; null when there is none, or its 7 days have ended.
 */
export async function downloadExport(
	scope: OrganisationScope,
	actorId: string,
	now: Date,
): Promise<Response | null> {
	const [row] = await scope.organisationExports.select((e) => eq(e.status, "ready"));
	if (!row?.finishedAt || !row.expiresAt || row.expiresAt.getTime() <= now.getTime()) return null;
	const object = await env.RECEIPTS.get(exportKey(scope.organisationId, row.id));
	const organisation = await organisationOf(scope.organisationId);
	if (!object || !organisation) return null;
	await record(scope, actorId, "organisation_export.downloaded", {
		type: "organisation_export",
		id: row.id,
	});
	const day = dayOf(row.finishedAt.getTime(), organisation.timeZone);
	return new Response(object.body, {
		headers: {
			"Content-Type": "application/zip",
			"Content-Length": String(object.size),
			"Content-Disposition": `attachment; filename="${exportFilename(organisation.name, "everything", day, "zip")}"`,
			"Cache-Control": "no-store",
		},
	});
}

/**
 * Deletes an export: its upload if one is open, its ZIP and its work in R2,
 * then its row, and records the deletion, by `actorId`, or by the system
 * when its 7 days have ended.
 */
async function deleteExport(
	scope: OrganisationScope,
	row: ExportRow,
	actorId: string | null,
): Promise<void> {
	await abortUpload(row);
	await deleteUnder(`${exportsPrefix(scope.organisationId)}${row.id}`);
	await scope.batch([
		scope.organisationExports.statements.delete((e) => eq(e.id, row.id)),
		recordStatement(
			scope,
			actorId,
			"organisation_export.deleted",
			{ type: "organisation_export", id: row.id },
			{},
			actorId ? "web" : "system",
		),
	]);
}

/** The hourly trigger's part: every export, in any organisation, whose 7 days have ended, deleted. Answers how many. */
export async function deleteExpiredExports(now: Date): Promise<number> {
	let deleted = 0;
	for (const { id, organisationId } of await expiredExports(env.DB, now)) {
		const scope = organisationScope(env.DB, organisationId);
		const [row] = await scope.organisationExports.select((e) => eq(e.id, id));
		if (!row) continue;
		await deleteExport(scope, row, null);
		deleted += 1;
	}
	return deleted;
}

/**
 * Deletes every export file of the organisation, and abandons any upload, as
 * the organisation itself is deleted; its rows go with it. Throws when a
 * delete fails, so the organisation is kept and asking again deletes the rest.
 */
export async function deleteOrganisationExports(organisationId: string): Promise<void> {
	const scope = organisationScope(env.DB, organisationId);
	for (const row of await scope.organisationExports.select()) await abortUpload(row);
	await deleteUnder(exportsPrefix(organisationId));
}

// ---------------------------------------------------------------------------
// Telling the owner.

/**
 * The write of the notice of what became of `row`, to the owner who asked for
 * it and nobody else, if they are an owner still (TS-126b). The bell shows it,
 * and the every-minute sender emails it unless they turned that kind's email
 * off (`app/notifications/mail.server.ts`), so the owner is emailed once.
 */
async function toldOwner(
	scope: OrganisationScope,
	row: ExportRow,
	notice: (userId: string) => NewNotification,
): Promise<ScopedStatement<unknown>[]> {
	const requestedBy = row.requestedBy;
	if (!requestedBy) return [];
	const [owner] = await scope.memberships.select((m) =>
		and(eq(m.userId, requestedBy), eq(m.role, "owner")),
	);
	return owner ? notificationStatements(scope, [notice(requestedBy)]) : [];
}
