import { env } from "cloudflare:workers";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
	changes,
	type Recorded,
	recordStatement,
	recordStatementWhen,
	recordsStatement,
} from "~/activity/activity.server";
import { type OrganisationScope, organisations, type ScopedStatement, users, uuidv7 } from "~/db";
import { type KindsMs, kindOfNewTime, type RulesCalendar, weekOf } from "~/leave/rules";
import { rulesCalendarOf } from "~/leave/rules.server";
import { nameKey, recordName } from "~/lib/names";
import { lockOf } from "~/locks/locks";
import { PeriodStatus } from "~/periods/periods";
import { addDays, bounds, type Day, dayOf, instantAt } from "~/time/calendar";
import { formatDayWithYear, formatDuration } from "~/time/format";
import { ENTRY_FIELDS } from "~/time/manual.server";

import { type CsvRow, parseCsv } from "./csv";
import {
	harvestMapping,
	type ImportKind,
	type Mapping,
	missingFields,
	personKey,
	readDate,
	readMinutes,
} from "./mapping";

/**
 * CSV imports (TS-076). A file is uploaded, kept while it is previewed, and
 * read again with the columns chosen until the person imports it; nothing is
 * written before then. A time import makes each entry with the import's id, so
 * reverting deletes exactly those entries, unless one of them is locked. Rows
 * already in Timesifier are skipped, people are never created, and missing
 * clients, projects and tasks are. A row is held to its day's limits as the
 * Timesheet holds a change (TS-095): past the day's expected hours it is
 * overtime where the organisation allows that much, and skipped with the
 * reason where it does not.
 */

/** The largest file an import takes, in bytes. */
export const IMPORT_MAX_BYTES = 1024 * 1024;

/** The most rows an import takes. */
export const IMPORT_MAX_ROWS = 5000;

/**
 * Rows in one insert: D1 binds at most 100 values to a statement, and an
 * entry binds up to 14 of them since it gained `spent_on` (TS-111).
 */
const ROWS_PER_INSERT = 7;

/** Statements in one batch. */
const STATEMENTS_PER_BATCH = 50;

/** Where an imported day's entries start when the day has none: 09:00. */
const DAY_STARTS_AT_MINUTES = 9 * 60;

/** The most entries a refused revert names. */
const NAMED_LOCKED = 20;

export type Started = { ok: true; id: string } | { ok: false; problem: string };

/** Keeps an uploaded file for its preview, with the Harvest preset's columns chosen. */
export async function startImport(
	scope: OrganisationScope,
	actorId: string,
	kind: ImportKind,
	fileName: string,
	text: string,
): Promise<Started> {
	const rows = parseCsv(text);
	if (rows === null) return { ok: false, problem: "A quoted field in the file is never closed." };
	const [header, ...body] = rows;
	if (!header || body.length === 0) {
		return { ok: false, problem: "The file needs a line of headings and at least one row." };
	}
	if (body.length > IMPORT_MAX_ROWS) {
		return { ok: false, problem: `A file can hold at most ${IMPORT_MAX_ROWS} rows. Split it.` };
	}
	const id = uuidv7();
	await scope.importJobs.insert({
		id,
		kind,
		status: "previewed",
		fileName: fileName.slice(0, 200),
		rowCount: body.length,
		createdBy: actorId,
		source: text,
		mapping: Object.fromEntries(
			Object.entries(harvestMapping(kind, header.cells)).map(([field, column]) => [
				field,
				String(column),
			]),
		),
	});
	return { ok: true, id };
}

/** Chooses the columns of import `id`, while it is previewed. */
export async function setMapping(scope: OrganisationScope, id: string, mapping: Mapping) {
	const [changed] = await scope.importJobs.update(
		{
			mapping: Object.fromEntries(
				Object.entries(mapping).map(([field, column]) => [field, String(column)]),
			),
		},
		(j) => and(eq(j.id, id), eq(j.status, "previewed")),
	);
	return changed !== undefined;
}

/** Drops a previewed import, and the file it kept. */
export async function discardImport(scope: OrganisationScope, id: string) {
	const [dropped] = await scope.importJobs.delete((j) =>
		and(eq(j.id, id), eq(j.status, "previewed")),
	);
	return dropped !== undefined;
}

/** The organisation's imports of `kind`, newest first, with who made each. */
export async function listImports(scope: OrganisationScope, kind: ImportKind) {
	const jobs = await scope.importJobs.select((j) => eq(j.kind, kind), {
		orderBy: (j) => [desc(j.createdAt)],
		limit: 50,
	});
	const names = await namesOf(jobs.map((job) => job.createdBy));
	return jobs.map((job) => ({
		id: job.id,
		fileName: job.fileName,
		status: job.status as "previewed" | "imported" | "reverted" | "failed",
		rowCount: job.rowCount,
		importedCount: job.importedCount,
		skippedCount: job.skippedCount,
		madeBy: names.get(job.createdBy) ?? "",
		createdAt: job.createdAt.getTime(),
		importedAt: job.importedAt?.getTime() ?? null,
		revertedAt: job.revertedAt?.getTime() ?? null,
	}));
}

async function namesOf(ids: string[]) {
	const unique = [...new Set(ids)];
	if (unique.length === 0) return new Map<string, string>();
	const rows = await drizzle(env.DB)
		.select({ id: users.id, name: users.name })
		.from(users)
		.where(inArray(users.id, unique));
	return new Map(rows.map((row) => [row.id, row.name]));
}

// ── Reading a file ───────────────────────────────────────────────────────────

/** A row that will be imported. */
export interface TimeRow {
	line: number;
	userId: string;
	person: string;
	day: Day;
	client: string | null;
	project: string;
	task: string | null;
	notes: string | null;
	minutes: number;
	/** Whether the row is overtime: past its day's expected hours, where the organisation allows (TS-095). */
	overtime: boolean;
}

export interface Skipped {
	line: number;
	reason: string;
}

export interface Preview {
	kind: ImportKind;
	headers: string[];
	mapping: Mapping;
	/** The fields the file needs a column for and has none; nothing is imported until there is one. */
	missing: string[];
	/** Time: the rows to import. */
	rows: TimeRow[];
	/** Clients and projects: the names to add, with their clients for projects. */
	records: { line: number; name: string; client: string | null }[];
	skipped: Skipped[];
	/** The people the file names who are not members, each with their rows. */
	unmatched: { person: string; lines: number[] }[];
	/** What importing would add. */
	creates: { clients: string[]; projects: string[]; tasks: string[] };
}

interface Member {
	userId: string;
	name: string;
	email: string;
	zone: string;
}

async function membersOf(scope: OrganisationScope, organisationZone: string): Promise<Member[]> {
	const memberships = await scope.memberships.select();
	if (memberships.length === 0) return [];
	const rows = await drizzle(env.DB)
		.select({ id: users.id, name: users.name, email: users.email, timeZone: users.timeZone })
		.from(users)
		.where(
			inArray(
				users.id,
				memberships.map((m) => m.userId),
			),
		);
	return rows.map((row) => ({
		userId: row.id,
		name: row.name,
		email: row.email.toLowerCase(),
		zone: row.timeZone ?? organisationZone,
	}));
}

/** The organisation's zone and lock date, read for each import. */
async function organisationOf(organisationId: string) {
	const [found] = await drizzle(env.DB)
		.select({ timeZone: organisations.timeZone, lockedThrough: organisations.lockedThrough })
		.from(organisations)
		.where(eq(organisations.id, organisationId))
		.limit(1);
	return {
		zone: found?.timeZone ?? "UTC",
		lockedThrough: (found?.lockedThrough ?? null) as Day | null,
	};
}

/** The previewed or finished import `id`, or null. */
export async function findImport(scope: OrganisationScope, id: string) {
	const [job] = await scope.importJobs.select((j) => eq(j.id, id), { limit: 1 });
	return job ?? null;
}

/** What a preview reads of an import. */
export interface ImportSource {
	kind: string;
	source: string | null;
	mapping: Record<string, string> | null;
}

function mappingOf(job: Pick<ImportSource, "mapping">): Mapping {
	return Object.fromEntries(
		Object.entries(job.mapping ?? {}).map(([field, column]) => [field, Number(column)]),
	);
}

/** What importing `job` would do, worked out from its file and columns and the organisation as it is now. */
export async function previewImport(scope: OrganisationScope, job: ImportSource): Promise<Preview> {
	const kind = job.kind as ImportKind;
	const rows = parseCsv(job.source ?? "") ?? [];
	const [header, ...body] = rows;
	const mapping = mappingOf(job);
	const preview: Preview = {
		kind,
		headers: header?.cells ?? [],
		mapping,
		missing: missingFields(kind, mapping),
		rows: [],
		records: [],
		skipped: [],
		unmatched: [],
		creates: { clients: [], projects: [], tasks: [] },
	};
	if (preview.missing.length > 0) return preview;
	const cell = (row: CsvRow, field: string) => {
		const column = mapping[field];
		return column === undefined ? "" : (row.cells[column] ?? "").trim();
	};
	if (kind === "time") await previewTime(scope, body, cell, preview);
	else await previewRecords(scope, kind, body, cell, preview);
	return preview;
}

type Cell = (row: CsvRow, field: string) => string;

async function previewRecords(
	scope: OrganisationScope,
	kind: "clients" | "projects",
	body: CsvRow[],
	cell: Cell,
	preview: Preview,
) {
	const [clients, projects] = await Promise.all([scope.clients.select(), scope.projects.select()]);
	const clientKeys = new Set(clients.map((c) => c.nameKey));
	const taken = new Set((kind === "clients" ? clients : projects).map((r) => r.nameKey));
	const newClients = new Map<string, string>();
	for (const row of body) {
		const typed = cell(row, kind === "clients" ? "client" : "project");
		const name = recordName(typed);
		if (name === null) {
			preview.skipped.push({
				line: row.line,
				reason: typed
					? "The name is longer than 120 characters or holds a line break."
					: "No name.",
			});
			continue;
		}
		if (taken.has(nameKey(name))) {
			preview.skipped.push({
				line: row.line,
				reason: kind === "clients" ? "Already a client." : "Already a project.",
			});
			continue;
		}
		taken.add(nameKey(name));
		const client = kind === "projects" ? recordName(cell(row, "client")) : null;
		if (client !== null && !clientKeys.has(nameKey(client)))
			newClients.set(nameKey(client), client);
		preview.records.push({ line: row.line, name, client });
	}
	preview.creates.clients =
		kind === "clients" ? preview.records.map((r) => r.name) : [...newClients.values()];
	preview.creates.projects = kind === "projects" ? preview.records.map((r) => r.name) : [];
}

async function previewTime(scope: OrganisationScope, body: CsvRow[], cell: Cell, preview: Preview) {
	const { zone: organisationZone, lockedThrough } = await organisationOf(scope.organisationId);
	const members = await membersOf(scope, organisationZone);
	const byEmail = new Map(members.map((m) => [m.email, m]));
	const byName = new Map<string, Member[]>();
	for (const member of members) {
		const key = personKey(member.name);
		byName.set(key, [...(byName.get(key) ?? []), member]);
	}
	const unmatched = new Map<string, number[]>();
	const memberOf = new Map<string, Member>();
	const candidates: TimeRow[] = [];

	for (const row of body) {
		const email = cell(row, "email").toLowerCase();
		const typedName =
			cell(row, "person") || `${cell(row, "first_name")} ${cell(row, "last_name")}`.trim();
		const person = email || typedName;
		let member: Member | undefined;
		let reason: string | null = null;
		if (email) {
			member = byEmail.get(email);
			if (!member) reason = "No member has this email.";
		} else if (typedName) {
			const named = byName.get(personKey(typedName)) ?? [];
			member = named.length === 1 ? named[0] : undefined;
			if (named.length > 1)
				reason = `More than one member is called ${typedName}: add an Email column.`;
			else if (!member) reason = `No member is called ${typedName}.`;
		} else {
			reason = "No person.";
		}
		if (!member) {
			if (person) unmatched.set(person, [...(unmatched.get(person) ?? []), row.line]);
			preview.skipped.push({ line: row.line, reason: reason ?? "No person." });
			continue;
		}
		const day = readDate(cell(row, "date"));
		if (day === null) {
			preview.skipped.push({ line: row.line, reason: "The date is not YYYY-MM-DD or M/D/YYYY." });
			continue;
		}
		const minutes = readMinutes(cell(row, "hours"));
		if (minutes === null) {
			preview.skipped.push({
				line: row.line,
				reason: "The hours are not a number above 0 and at most 24.",
			});
			continue;
		}
		const project = recordName(cell(row, "project"));
		if (project === null) {
			preview.skipped.push({ line: row.line, reason: "No project, or its name is too long." });
			continue;
		}
		const notes = cell(row, "notes");
		memberOf.set(member.userId, member);
		candidates.push({
			line: row.line,
			userId: member.userId,
			person: member.name,
			day,
			client: recordName(cell(row, "client")),
			project,
			task: recordName(cell(row, "task")),
			notes: notes ? notes.slice(0, 2000) : null,
			minutes,
			overtime: false,
		});
	}
	preview.unmatched = [...unmatched].map(([person, lines]) => ({ person, lines }));
	if (candidates.length === 0) return;

	// What is already there: each person's entries over the file's days, and
	// their locked days; and, for the limits of their days (TS-095), their
	// rules and the time of each kind on each day of the weeks the file
	// touches, which the file's rows add to as they are taken.
	const [projects, tasks, clients] = await Promise.all([
		scope.projects.select(),
		scope.tasks.select(),
		scope.clients.select(),
	]);
	const projectKey = new Map(projects.map((p) => [p.id, p.nameKey]));
	const taskKey = new Map(tasks.map((t) => [t.id, t.nameKey]));
	const present = new Map<string, number>();
	const locked = new Set<string>();
	const calendars = new Map<string, RulesCalendar>();
	const tracked = new Map<string, KindsMs>();
	const trackedOf = (userId: string) => (day: Day) =>
		tracked.get(`${userId}|${day}`) ?? { regularMs: 0, overtimeMs: 0 };
	const now = Date.now();
	for (const userId of memberOf.keys()) {
		const days = candidates
			.filter((c) => c.userId === userId)
			.map((c) => c.day)
			.sort();
		const first = days[0] as Day;
		const last = days.at(-1) as Day;
		const calendar = await rulesCalendarOf(scope, userId, first, last);
		calendars.set(userId, calendar);
		const from = weekOf(calendar.rules, first);
		const to = addDays(weekOf(calendar.rules, last), 6);
		const [entries, periods] = await Promise.all([
			scope.timeEntries.select((e) =>
				and(eq(e.userId, userId), gte(e.spentOn, from), lte(e.spentOn, to)),
			),
			scope.periods.select((p) => eq(p.userId, userId)),
		]);
		for (const entry of entries) {
			const day = entry.spentOn;
			const slot = `${userId}|${day}`;
			const sum = tracked.get(slot) ?? { regularMs: 0, overtimeMs: 0 };
			const ms = (entry.endedAt?.getTime() ?? now) - entry.startedAt.getTime();
			if (entry.overtime) sum.overtimeMs += ms;
			else sum.regularMs += ms;
			tracked.set(slot, sum);
			if (entry.endedAt === null) continue;
			const key = duplicateKey(
				userId,
				day,
				projectKey.get(entry.projectId) ?? "",
				entry.taskId ? (taskKey.get(entry.taskId) ?? "") : "",
				Math.round((entry.endedAt.getTime() - entry.startedAt.getTime()) / 60_000),
				entry.description ?? "",
			);
			present.set(key, (present.get(key) ?? 0) + 1);
		}
		for (const day of new Set(days)) {
			const period = periods.find((p) => p.startsOn <= day && day <= p.endsOn);
			const status = PeriodStatus.safeParse(period?.status);
			if (
				lockOf({
					day,
					lockedThrough,
					periodStatus: status.success ? status.data : null,
					invoiced: false,
				})
			) {
				locked.add(`${userId}|${day}`);
			}
		}
	}

	const knownClients = new Set(clients.map((c) => c.nameKey));
	const knownProjects = new Set(projects.map((p) => p.nameKey));
	const knownTasks = new Set(tasks.map((t) => t.nameKey));
	const newClients = new Map<string, string>();
	const newProjects = new Map<string, string>();
	const newTasks = new Map<string, string>();
	for (const row of candidates) {
		const key = duplicateKey(
			row.userId,
			row.day,
			nameKey(row.project),
			row.task ? nameKey(row.task) : "",
			row.minutes,
			row.notes ?? "",
		);
		const already = present.get(key) ?? 0;
		if (already > 0) {
			present.set(key, already - 1);
			preview.skipped.push({ line: row.line, reason: "Already in Timesifier." });
			continue;
		}
		if (locked.has(`${row.userId}|${row.day}`)) {
			preview.skipped.push({
				line: row.line,
				reason: "That day is locked: submitted, approved or before the lock date.",
			});
			continue;
		}
		const calendar = calendars.get(row.userId);
		const ms = row.minutes * 60_000;
		const kind = calendar
			? kindOfNewTime(calendar, row.day, ms, trackedOf(row.userId))
			: { ok: true as const, overtime: false };
		if (!kind.ok) {
			preview.skipped.push({ line: row.line, reason: kind.message });
			continue;
		}
		const slot = `${row.userId}|${row.day}`;
		const sum = trackedOf(row.userId)(row.day);
		tracked.set(
			slot,
			kind.overtime
				? { ...sum, overtimeMs: sum.overtimeMs + ms }
				: { ...sum, regularMs: sum.regularMs + ms },
		);
		preview.rows.push({ ...row, overtime: kind.overtime });
		if (!knownProjects.has(nameKey(row.project))) {
			newProjects.set(nameKey(row.project), row.project);
			if (row.client && !knownClients.has(nameKey(row.client))) {
				newClients.set(nameKey(row.client), row.client);
			}
		}
		if (row.task && !knownTasks.has(nameKey(row.task))) newTasks.set(nameKey(row.task), row.task);
	}
	preview.skipped.sort((a, b) => a.line - b.line);
	preview.creates = {
		clients: [...newClients.values()],
		projects: [...newProjects.values()],
		tasks: [...newTasks.values()],
	};
}

function duplicateKey(
	userId: string,
	day: Day,
	project: string,
	task: string,
	minutes: number,
	notes: string,
) {
	return JSON.stringify([userId, day, project, task, minutes, notes.trim()]);
}

// ── Importing ────────────────────────────────────────────────────────────────

/**
 * Sends `groups` in batches of about `STATEMENTS_PER_BATCH` statements. A
 * group is never split: a write and the records of it land in one batch.
 */
async function sendAll(scope: OrganisationScope, groups: ScopedStatement<unknown>[][]) {
	let batch: ScopedStatement<unknown>[] = [];
	for (const group of [...groups, null]) {
		if (group === null || batch.length + group.length > STATEMENTS_PER_BATCH) {
			const [first, ...rest] = batch;
			if (first) await scope.batch([first, ...rest]);
			batch = [];
		}
		if (group) batch.push(...group);
	}
}

/** The records of `records`, as from an import by `actorId`, a statement per insert's worth. */
function importRecords(scope: OrganisationScope, actorId: string, records: Recorded[]) {
	return inChunks(records).map((chunk) => recordsStatement(scope, actorId, chunk, "import"));
}

function inChunks<T>(rows: T[], size = ROWS_PER_INSERT): T[][] {
	const chunks: T[][] = [];
	for (let start = 0; start < rows.length; start += size)
		chunks.push(rows.slice(start, start + size));
	return chunks;
}

export type Imported =
	| { ok: true; imported: number; skipped: number }
	| { ok: false; problem: string };

/**
 * Imports previewed import `id` as `actorId`: what the preview says, worked
 * out again now. The import is marked imported first, so even one cut short
 * can be reverted.
 */
export async function runImport(
	scope: OrganisationScope,
	actorId: string,
	id: string,
	now: number,
): Promise<Imported> {
	const job = await findImport(scope, id);
	if (job?.status !== "previewed")
		return { ok: false, problem: "This import is not waiting to be imported." };
	const preview = await previewImport(scope, job);
	if (preview.missing.length > 0) {
		return { ok: false, problem: `Choose a column for ${preview.missing.join(", ")}.` };
	}
	const count = preview.kind === "time" ? preview.rows.length : preview.records.length;
	const [, [claimed]] = await scope.batch([
		// Recorded first, while the import still waits: two imports at once record one.
		recordStatementWhen(
			scope,
			scope.importJobs.exists((j) => and(eq(j.id, id), eq(j.status, "previewed"))),
			actorId,
			"import.imported",
			{ type: "import", id },
			{ after: { kind: preview.kind, imported: count, skipped: preview.skipped.length } },
			"import",
		),
		scope.importJobs.statements.update(
			{ status: "imported", importedAt: new Date(now), source: null },
			(j) => and(eq(j.id, id), eq(j.status, "previewed")),
		),
	]);
	if (!claimed) return { ok: false, problem: "This import is not waiting to be imported." };

	const known = await recordsToCreate(scope, actorId, preview);
	const entries =
		preview.kind === "time" ? await entriesToCreate(scope, actorId, id, preview, known) : [];
	await sendAll(scope, [...known.groups, ...entries]);
	await scope.importJobs.update(
		{
			importedCount: count,
			skippedCount: preview.skipped.length,
			skipped: preview.skipped,
		},
		(j) => eq(j.id, id),
	);
	return { ok: true, imported: count, skipped: preview.skipped.length };
}

/** What adding a file's records takes, and the ids of the projects and tasks by name, the new ones included. */
interface Known {
	/** Each insert with the records of what it adds. */
	groups: ScopedStatement<unknown>[][];
	projectId: Map<string, string>;
	taskId: Map<string, string>;
	/** Whether a task is billable on a project, by `projectId|taskId`. */
	billable: Map<string, boolean>;
}

/** The clients, projects, tasks and project tasks the preview says to add, each recorded as from an import. */
async function recordsToCreate(
	scope: OrganisationScope,
	actorId: string,
	preview: Preview,
): Promise<Known> {
	const [clients, projects, tasks, links] = await Promise.all([
		scope.clients.select(),
		scope.projects.select(),
		scope.tasks.select(),
		scope.projectTasks.select(),
	]);
	const clientId = new Map(clients.map((c) => [c.nameKey, c.id]));
	const projectId = new Map(projects.map((p) => [p.nameKey, p.id]));
	const taskId = new Map(tasks.map((t) => [t.nameKey, t.id]));
	const billable = new Map(links.map((l) => [`${l.projectId}|${l.taskId}`, l.billable]));

	const newClients: { id: string; name: string; nameKey: string }[] = [];
	const ensureClient = (name: string | null) => {
		if (name === null) return null;
		const key = nameKey(name);
		const known = clientId.get(key);
		if (known) return known;
		const id = uuidv7();
		clientId.set(key, id);
		newClients.push({ id, name, nameKey: key });
		return id;
	};
	const newProjects: { id: string; name: string; nameKey: string; clientId: string | null }[] = [];
	const newTasks: { id: string; name: string; nameKey: string }[] = [];
	const newLinks: { projectId: string; taskId: string; billable: boolean }[] = [];

	if (preview.kind === "clients") {
		for (const row of preview.records) ensureClient(row.name);
	} else if (preview.kind === "projects") {
		for (const row of preview.records) {
			const id = uuidv7();
			newProjects.push({
				id,
				name: row.name,
				nameKey: nameKey(row.name),
				clientId: ensureClient(row.client),
			});
			projectId.set(nameKey(row.name), id);
		}
	} else {
		for (const row of preview.rows) {
			let project = projectId.get(nameKey(row.project));
			if (!project) {
				project = uuidv7();
				projectId.set(nameKey(row.project), project);
				newProjects.push({
					id: project,
					name: row.project,
					nameKey: nameKey(row.project),
					clientId: ensureClient(row.client),
				});
			}
			if (row.task) {
				let task = taskId.get(nameKey(row.task));
				if (!task) {
					task = uuidv7();
					taskId.set(nameKey(row.task), task);
					newTasks.push({ id: task, name: row.task, nameKey: nameKey(row.task) });
				}
				if (!billable.has(`${project}|${task}`)) {
					const flag = tasks.find((t) => t.id === task)?.billableByDefault ?? true;
					billable.set(`${project}|${task}`, flag);
					newLinks.push({ projectId: project, taskId: task, billable: flag });
				}
			}
		}
	}
	/** Each chunk's insert with a `<type>.created` record of each row it adds. */
	const created = <R extends { id: string; name: string }>(
		type: "client" | "project" | "task",
		rows: R[],
		insert: (chunk: R[]) => ScopedStatement<unknown>,
	) =>
		inChunks(rows).map((chunk) => [
			insert(chunk),
			...importRecords(
				scope,
				actorId,
				chunk.map((row) => ({
					action: `${type}.created` as const,
					subject: { type, id: row.id },
					summary: changes(null, row, ["name"]),
				})),
			),
		]);
	const groups = [
		...created("client", newClients, (chunk) => scope.clients.statements.insert(chunk)),
		...created("project", newProjects, (chunk) => scope.projects.statements.insert(chunk)),
		...created("task", newTasks, (chunk) => scope.tasks.statements.insert(chunk)),
		// A task's place on a project is part of making them: no record of its own.
		...inChunks(newLinks).map((chunk) => [scope.projectTasks.statements.insert(chunk)]),
	];
	return { groups, projectId, taskId, billable };
}

/** The entries of a time import: each day's rows one after another from 09:00, or after the day's last entry. */
async function entriesToCreate(
	scope: OrganisationScope,
	actorId: string,
	importId: string,
	preview: Preview,
	known: Known,
): Promise<ScopedStatement<unknown>[][]> {
	const { zone: organisationZone } = await organisationOf(scope.organisationId);
	const members = new Map((await membersOf(scope, organisationZone)).map((m) => [m.userId, m]));
	const nextStart = new Map<string, number>();
	const entries = [];
	for (const row of preview.rows) {
		const zone = members.get(row.userId)?.zone ?? organisationZone;
		const slot = `${row.userId}|${row.day}`;
		let startedAt = nextStart.get(slot);
		if (startedAt === undefined) {
			const sameDay = await scope.timeEntries.select((e) =>
				and(eq(e.userId, row.userId), eq(e.spentOn, row.day)),
			);
			const lastEnd = Math.max(0, ...sameDay.map((e) => (e.endedAt ?? e.startedAt).getTime()));
			startedAt = Math.max(instantAt(row.day, DAY_STARTS_AT_MINUTES, zone), lastEnd);
		}
		const endedAt = startedAt + row.minutes * 60_000;
		nextStart.set(slot, endedAt);
		const projectId = known.projectId.get(nameKey(row.project)) ?? "";
		const taskId = row.task ? (known.taskId.get(nameKey(row.task)) ?? null) : null;
		entries.push({
			id: uuidv7(),
			userId: row.userId,
			projectId,
			taskId,
			description: row.notes,
			startedAt: new Date(startedAt),
			endedAt: new Date(endedAt),
			spentOn: row.day,
			billable: taskId === null ? false : (known.billable.get(`${projectId}|${taskId}`) ?? false),
			overtime: row.overtime,
			importId,
		});
	}
	return inChunks(entries).map((chunk) => [
		scope.timeEntries.statements.insert(chunk),
		...importRecords(
			scope,
			actorId,
			chunk.map((entry) => ({
				action: "time_entry.created" as const,
				subject: { type: "time_entry" as const, id: entry.id, ownerId: entry.userId },
				summary: changes(null, entry, ENTRY_FIELDS),
			})),
		),
	]);
}

// ── Reverting ────────────────────────────────────────────────────────────────

export type Reverted =
	| { ok: true; deleted: number }
	| { ok: false; problem: string; locked: string[] };

/**
 * Deletes exactly the entries of time import `id`, unless one of them is
 * locked: on an invoice, before the lock date, or in a submitted or approved
 * period. Then nothing is deleted, and the locked entries are named.
 */
export async function revertImport(
	scope: OrganisationScope,
	actorId: string,
	id: string,
	now: number,
): Promise<Reverted> {
	const job = await findImport(scope, id);
	if (job?.kind !== "time" || job.status !== "imported") {
		return {
			ok: false,
			problem: "Only a time import that was imported can be reverted.",
			locked: [],
		};
	}
	const { zone: organisationZone, lockedThrough } = await organisationOf(scope.organisationId);
	const entries = await scope.timeEntries.select((e) => eq(e.importId, id));
	const ids = entries.map((e) => e.id);
	const invoiced = new Set<string>();
	for (const chunk of inChunks(ids, 90)) {
		const sources = await scope.invoiceLineSources.select((s) => inArray(s.timeEntryId, chunk));
		for (const source of sources) if (source.timeEntryId) invoiced.add(source.timeEntryId);
	}
	const members = new Map((await membersOf(scope, organisationZone)).map((m) => [m.userId, m]));
	const people = [...new Set(entries.map((e) => e.userId))];
	const periods = people.length ? await scope.periods.select((p) => inArray(p.userId, people)) : [];
	const projects = new Map((await scope.projects.select()).map((p) => [p.id, p.name]));
	const lockedEntries: string[] = [];
	for (const entry of entries) {
		const day = entry.spentOn;
		const period = periods.find(
			(p) => p.userId === entry.userId && p.startsOn <= day && day <= p.endsOn,
		);
		const status = PeriodStatus.safeParse(period?.status);
		const reason = lockOf({
			day,
			lockedThrough,
			periodStatus: status.success ? status.data : null,
			invoiced: invoiced.has(entry.id),
		});
		if (reason) {
			const minutes =
				((entry.endedAt ?? entry.startedAt).getTime() - entry.startedAt.getTime()) / 60_000;
			lockedEntries.push(
				`${members.get(entry.userId)?.name ?? "Someone"}, ${formatDayWithYear(day)}, ${projects.get(entry.projectId) ?? "a project"}, ${formatDuration(minutes * 60)}: ${LOCK_WORDS[reason]}`,
			);
		}
	}
	if (lockedEntries.length > 0) {
		return {
			ok: false,
			problem: `${lockedEntries.length} of this import's entries are locked, so nothing was reverted.`,
			locked: lockedEntries.slice(0, NAMED_LOCKED),
		};
	}
	const deletes = inChunks(entries, 90).map((chunk) => [
		scope.timeEntries.statements.delete((e) =>
			and(
				eq(e.importId, id),
				inArray(
					e.id,
					chunk.map((entry) => entry.id),
				),
			),
		),
		...importRecords(
			scope,
			actorId,
			chunk.map((entry) => ({
				action: "time_entry.deleted" as const,
				subject: { type: "time_entry" as const, id: entry.id, ownerId: entry.userId },
				summary: changes(entry, null, ENTRY_FIELDS),
			})),
		),
	]);
	await sendAll(scope, [
		...deletes,
		[
			scope.importJobs.statements.update({ status: "reverted", revertedAt: new Date(now) }, (j) =>
				eq(j.id, id),
			),
			recordStatement(
				scope,
				actorId,
				"import.reverted",
				{ type: "import", id },
				{ before: { entries: ids.length } },
				"import",
			),
		],
	]);
	return { ok: true, deleted: ids.length };
}

const LOCK_WORDS = {
	invoiced: "invoiced",
	"locked-through": "before the lock date",
	approved: "approved",
	submitted: "submitted",
} as const;
