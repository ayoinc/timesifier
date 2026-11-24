import { env } from "cloudflare:workers";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
	changes,
	type Recorded,
	recordStatement,
	recordStatementWhen,
	recordsStatement,
} from "~/activity/activity.server";
import {
	among,
	type OrganisationScope,
	organisations,
	type ScopedStatement,
	users,
	uuidv7,
} from "~/db";
import {
	closedReason,
	dayLimit,
	type KindsMs,
	kindOfNewTime,
	type RulesCalendar,
	splitAtLimit,
	weekOf,
} from "~/leave/rules";
import { rulesCalendarOf } from "~/leave/rules.server";
import { type CodeRules, codedName, codeKey, codeRuleFor, typedCode } from "~/lib/codes";
import { nameKey, recordName } from "~/lib/names";
import { lockOf, lockReachOf } from "~/locks/locks";
import { PeriodStatus } from "~/periods/periods";
import { nextPatternCodes, projectCodeRules } from "~/projects/projects.server";
import { teamRules } from "~/projects/teams.server";
import { type PackageRules, packageRules } from "~/projects/work-packages.server";
import { addDays, type Day, dayOf, instantAt } from "~/time/calendar";
import { formatDayWithYear, formatDuration } from "~/time/format";
import { ENTRY_FIELDS } from "~/time/manual.server";
import { hasClients, hasWorkCodes, WorkModel } from "~/workspace/work-model";

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
 * reason where it does not. Where only a project's team tracks to it
 * (TS-115c), a row is skipped unless its person is on its project's team on
 * its day; a project the import adds has nobody on its team, and takes none.
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
		.where(among(users.id, unique));
	return new Map(rows.map((row) => [row.id, row.name]));
}

// ── Reading a file ───────────────────────────────────────────────────────────

/** A row that will be imported. */
export interface TimeRow {
	line: number;
	userId: string;
	person: string;
	day: Day;
	/** The client: as it is named here when it is found, else as the file names it. */
	client: string | null;
	/** The client's code (TS-115a): its own when found, else the file's for one the import adds. */
	clientCode: string | null;
	/** The project, by the name it has or is to have: found by code first, then by name (TS-115a). */
	project: string;
	/** The project's code: its own when found, else the file's for one the import adds. */
	projectCode: string | null;
	/** The project's work package, found by its code within the project (TS-115b); null for none. */
	workPackageId: string | null;
	workPackageCode: string | null;
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
	/** Clients and projects: the names to add, with their codes, and their clients for projects. */
	records: {
		line: number;
		name: string;
		code: string | null;
		client: string | null;
		clientCode: string | null;
	}[];
	skipped: Skipped[];
	/** The people the file names who are not members, each with their rows. */
	unmatched: { person: string; lines: number[] }[];
	/** What importing would add, each named with its code (`codedName`). */
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
			among(
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

/** What an import reads of the organisation each time. */
interface ImportOrganisation {
	zone: string;
	lockedThrough: Day | null;
	/** Whether it has clients: not under Internal work (TS-115a). */
	clients: boolean;
	/** Whether a project with no client is a work code, billing nothing: under Both. */
	workCodes: boolean;
	/** The organisation's code rules: `codeNeededFor` reads them for a project the import adds. */
	codeRules: CodeRules;
}

async function organisationOf(organisationId: string): Promise<ImportOrganisation> {
	const [[found], codeRules] = await Promise.all([
		drizzle(env.DB)
			.select({
				timeZone: organisations.timeZone,
				lockedThrough: organisations.lockedThrough,
				workModel: organisations.workModel,
			})
			.from(organisations)
			.where(eq(organisations.id, organisationId))
			.limit(1),
		projectCodeRules(organisationId),
	]);
	const model = WorkModel.safeParse(found?.workModel);
	return {
		zone: found?.timeZone ?? "UTC",
		lockedThrough: (found?.lockedThrough ?? null) as Day | null,
		clients: hasClients(model.success ? model.data : "client_projects"),
		workCodes: hasWorkCodes(model.success ? model.data : "client_projects"),
		codeRules,
	};
}

/**
 * Why a project the import adds without a code is skipped, or null: where
 * every one of its kind has a code and no pattern numbers it. A project with
 * no client is a work code under Both, with the work codes' rule.
 */
function codeNeededFor(organisation: ImportOrganisation, clientless: boolean): string | null {
	const rule = codeRuleFor(organisation.codeRules, clientless);
	if (!rule.required || rule.pattern !== null) return null;
	const { workCode } = organisation.codeRules;
	return organisation.workCodes && clientless
		? `No ${workCode} code: every ${workCode} here needs one.`
		: CODE_NEEDED;
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
	const organisation = await organisationOf(scope.organisationId);
	const cell = (row: CsvRow, field: string) => {
		// Under Internal work there are no clients (TS-115a): a file's are not read.
		if (!organisation.clients && (field === "client" || field === "client_code")) return "";
		const column = mapping[field];
		return column === undefined ? "" : (row.cells[column] ?? "").trim();
	};
	if (kind === "time") await previewTime(scope, organisation, body, cell, preview);
	else await previewRecords(scope, organisation, kind, body, cell, preview);
	return preview;
}

type Cell = (row: CsvRow, field: string) => string;

/** A client or project as an import finds it: one here, or one the import is to add. */
interface Coded {
	name: string;
	nameKey: string;
	code: string | null;
	codeKey: string | null;
}

/**
 * Finds clients or projects by what a row names (TS-115a): by the code in its
 * code column, then by its name column read as a code, then by name. What the
 * import is to add is added to it, so two rows naming one new project, one by
 * its code and one by its name, add it once.
 */
interface Finder {
	find(typedName: string, code: string | null): Coded | null;
	/** Adds `name` with `code`, as the import is to. */
	add(name: string, code: string | null): Coded;
}

function finderOf(existing: readonly Coded[]): Finder {
	const byCode = new Map<string, Coded>();
	const byName = new Map<string, Coded>();
	const add = (found: Coded) => {
		if (found.codeKey !== null) byCode.set(found.codeKey, found);
		byName.set(found.nameKey, found);
	};
	for (const each of existing) add(each);
	return {
		find: (typedName, code) =>
			(code === null ? undefined : byCode.get(codeKey(code))) ??
			(typedName
				? (byCode.get(codeKey(typedName)) ?? byName.get(nameKey(typedName)))
				: undefined) ??
			null,
		add(name, code) {
			const added = {
				name,
				nameKey: nameKey(name),
				code,
				codeKey: code === null ? null : codeKey(code),
			};
			add(added);
			return added;
		},
	};
}

const CODE_CELL_PROBLEM =
	"The code is not 1 to 24 letters, digits, dots, slashes, hyphens or underscores.";
const CODE_NEEDED = "No project code: every project here needs one.";

/**
 * A row's client, found or to be added, or why the row is skipped. A client
 * named in no cell is null.
 */
function clientOf(
	clients: Finder,
	row: CsvRow,
	cell: Cell,
): { client: Coded | null } | { reason: string } {
	const code = typedCode(cell(row, "client_code"));
	if (code === false) return { reason: CODE_CELL_PROBLEM };
	const typed = cell(row, "client");
	const found = clients.find(typed, code);
	if (found) return { client: found };
	const name = recordName(typed);
	return { client: name === null ? null : clients.add(name, code) };
}

async function previewRecords(
	scope: OrganisationScope,
	organisation: ImportOrganisation,
	kind: "clients" | "projects",
	body: CsvRow[],
	cell: Cell,
	preview: Preview,
) {
	const [clients, projects] = await Promise.all([scope.clients.select(), scope.projects.select()]);
	const clientFinder = finderOf(clients);
	const finder = kind === "clients" ? clientFinder : finderOf(projects);
	const knownClients = new Set(clients.map((c) => c.nameKey));
	const newClients = new Map<string, string>();
	for (const row of body) {
		if (kind === "clients" && !organisation.clients) {
			preview.skipped.push({ line: row.line, reason: "This organisation has no clients." });
			continue;
		}
		const code = typedCode(cell(row, kind === "clients" ? "client_code" : "project_code"));
		if (code === false) {
			preview.skipped.push({ line: row.line, reason: CODE_CELL_PROBLEM });
			continue;
		}
		const typed = cell(row, kind === "clients" ? "client" : "project");
		if (finder.find(typed, code)) {
			preview.skipped.push({
				line: row.line,
				reason: kind === "clients" ? "Already a client." : "Already a project.",
			});
			continue;
		}
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
		const client = kind === "projects" ? clientOf(clientFinder, row, cell) : { client: null };
		if ("reason" in client) {
			preview.skipped.push({ line: row.line, reason: client.reason });
			continue;
		}
		const needed =
			kind === "projects" && code === null && codeNeededFor(organisation, client.client === null);
		if (needed) {
			preview.skipped.push({ line: row.line, reason: needed });
			continue;
		}
		finder.add(name, code);
		const found = client.client;
		if (found !== null && !knownClients.has(found.nameKey))
			newClients.set(found.nameKey, codedName(found.code, found.name));
		preview.records.push({
			line: row.line,
			name,
			code,
			client: found?.name ?? null,
			clientCode: found?.code ?? null,
		});
	}
	const named = preview.records.map((r) => codedName(r.code, r.name));
	preview.creates.clients = kind === "clients" ? named : [...newClients.values()];
	preview.creates.projects = kind === "projects" ? named : [];
}

/** Why a row is skipped where only a project's team tracks to it and its person is not on it that day (TS-115c). */
export const NOT_ON_TEAM = "This person is not on the project's team on that day.";

/** Why a row on a project the import adds is skipped where only a project's team tracks to it. */
export const NEW_PROJECT_NO_TEAM =
	"Only a project's team tracks time to it, and a project the import adds has nobody on its team.";

async function previewTime(
	scope: OrganisationScope,
	organisation: ImportOrganisation,
	body: CsvRow[],
	cell: Cell,
	preview: Preview,
) {
	const { zone: organisationZone, lockedThrough } = organisation;
	const [members, projects, tasks, clients] = await Promise.all([
		membersOf(scope, organisationZone),
		scope.projects.select(),
		scope.tasks.select(),
		scope.clients.select(),
	]);
	const projectIdOf = new Map(projects.map((p) => [p.nameKey, p.id]));
	// A row's work package is found by its code within its project (TS-115b),
	// and its person must be on its project's team on its day where tracking
	// is by assignment (TS-115c).
	const projectIds = projects.map((p) => p.id);
	const [packages, team] = await Promise.all([
		packageRules(scope, projectIds),
		teamRules(scope, projectIds),
	]);
	const byEmail = new Map(members.map((m) => [m.email, m]));
	const byName = new Map<string, Member[]>();
	for (const member of members) {
		const key = personKey(member.name);
		byName.set(key, [...(byName.get(key) ?? []), member]);
	}
	// A row's project is found by its code first, then by name (TS-115a).
	const projectFinder = finderOf(projects);
	const existingProjects = new Set(projects.map((p) => p.nameKey));
	const clientFinder = finderOf(clients);
	const unmatched = new Map<string, number[]>();
	const memberOf = new Map<string, Member>();
	const candidates: TimeRow[] = [];
	const now = Date.now();

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
		// Time is tracked for days that have come, where the person is (TR-13).
		if (day > dayOf(now, member.zone)) {
			preview.skipped.push({ line: row.line, reason: "That day has not come yet." });
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
		const projectCode = typedCode(cell(row, "project_code"));
		if (projectCode === false) {
			preview.skipped.push({ line: row.line, reason: CODE_CELL_PROBLEM });
			continue;
		}
		const typedProject = cell(row, "project");
		const found = projectFinder.find(typedProject, projectCode);
		const project = found?.name ?? recordName(typedProject);
		if (project === null) {
			preview.skipped.push({ line: row.line, reason: "No project, or its name is too long." });
			continue;
		}
		// The client matters only to a project the import adds; each row that
		// names it carries it, as the first may be skipped.
		const client =
			found && existingProjects.has(found.nameKey)
				? { client: null }
				: clientOf(clientFinder, row, cell);
		if ("reason" in client) {
			preview.skipped.push({ line: row.line, reason: client.reason });
			continue;
		}
		const needed =
			!found && projectCode === null && codeNeededFor(organisation, client.client === null);
		if (needed) {
			preview.skipped.push({ line: row.line, reason: needed });
			continue;
		}
		const workPackage = packageOfRow(
			packages,
			found ? (projectIdOf.get(found.nameKey) ?? null) : null,
			cell(row, "work_package_code"),
		);
		if ("reason" in workPackage) {
			preview.skipped.push({ line: row.line, reason: workPackage.reason });
			continue;
		}
		if (team.tracking === "assigned") {
			const projectId = found ? (projectIdOf.get(found.nameKey) ?? null) : null;
			if (projectId === null) {
				preview.skipped.push({ line: row.line, reason: NEW_PROJECT_NO_TEAM });
				continue;
			}
			if (!team.admits(member.userId, projectId, day)) {
				preview.skipped.push({ line: row.line, reason: NOT_ON_TEAM });
				continue;
			}
		}
		if (!found) projectFinder.add(project, projectCode);
		const notes = cell(row, "notes");
		memberOf.set(member.userId, member);
		candidates.push({
			line: row.line,
			userId: member.userId,
			person: member.name,
			day,
			client: client.client?.name ?? null,
			clientCode: client.client?.code ?? null,
			project,
			projectCode: found ? found.code : projectCode,
			workPackageId: workPackage.id,
			workPackageCode: workPackage.code,
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
	const projectKey = new Map(projects.map((p) => [p.id, p.nameKey]));
	const taskKey = new Map(tasks.map((t) => [t.id, t.nameKey]));
	const present = new Map<string, number>();
	const locked = new Set<string>();
	const calendars = new Map<string, RulesCalendar>();
	const tracked = new Map<string, KindsMs>();
	const trackedOf = (userId: string) => (day: Day) =>
		tracked.get(`${userId}|${day}`) ?? { regularMs: 0, overtimeMs: 0 };
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
		// A row imported before and cut at its day's limit (decision 54) is
		// its regular entry and the overtime that follows it: already here.
		for (const overtime of entries) {
			if (!overtime.overtime || overtime.endedAt === null) continue;
			const regular = entries.find(
				(e) =>
					!e.overtime &&
					e.endedAt?.getTime() === overtime.startedAt.getTime() &&
					e.spentOn === overtime.spentOn &&
					e.projectId === overtime.projectId &&
					e.taskId === overtime.taskId &&
					e.description === overtime.description,
			);
			if (!regular) continue;
			const key = duplicateKey(
				userId,
				overtime.spentOn,
				projectKey.get(overtime.projectId) ?? "",
				overtime.taskId ? (taskKey.get(overtime.taskId) ?? "") : "",
				Math.round((overtime.endedAt.getTime() - regular.startedAt.getTime()) / 60_000),
				overtime.description ?? "",
			);
			present.set(key, (present.get(key) ?? 0) + 1);
		}
		for (const day of new Set(days)) {
			const period = periods.find((p) => p.startsOn <= day && day <= p.endsOn);
			const status = PeriodStatus.safeParse(period?.status);
			if (
				lockOf({
					day,
					lockedThrough: lockReachOf(
						lockedThrough,
						memberOf.get(userId)?.zone ?? organisationZone,
						now,
					),
					periodStatus: status.success ? status.data : null,
					invoiced: false,
				})
			) {
				locked.add(`${userId}|${day}`);
			}
		}
	}

	const knownClients = new Set(clients.map((c) => c.nameKey));
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
		const taken = calendar ? rowsOfLimit(calendar, row, trackedOf(row.userId)) : [row];
		if (!Array.isArray(taken)) {
			preview.skipped.push({ line: row.line, reason: taken.reason });
			continue;
		}
		for (const part of taken) {
			const ms = part.minutes * 60_000;
			const slot = `${row.userId}|${row.day}`;
			const sum = trackedOf(row.userId)(row.day);
			tracked.set(
				slot,
				part.overtime
					? { ...sum, overtimeMs: sum.overtimeMs + ms }
					: { ...sum, regularMs: sum.regularMs + ms },
			);
			preview.rows.push(part);
		}
		if (!existingProjects.has(nameKey(row.project))) {
			newProjects.set(nameKey(row.project), codedName(row.projectCode, row.project));
			if (row.client && !knownClients.has(nameKey(row.client))) {
				newClients.set(nameKey(row.client), codedName(row.clientCode, row.client));
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

/**
 * A row's work package (TS-115b): the open one of its project whose code the
 * row gives, ignoring case. A row with no code is taken only where its project
 * has no open work package; a project the import adds has none. A code no
 * work package of the project has, or a closed one's, skips the row.
 */
function packageOfRow(
	packages: PackageRules,
	projectId: string | null,
	typed: string,
): { id: string | null; code: string | null } | { reason: string } {
	if (typed === "") {
		return projectId !== null && packages.required(projectId)
			? { reason: "No work package code: this project's time goes to one of its work packages." }
			: { id: null, code: null };
	}
	const found = projectId === null ? null : packages.byCode(projectId, typed);
	if (!found) return { reason: `This project has no work package with the code ${typed}.` };
	if (packages.open(found.projectId, found.id) === null) {
		return { reason: `Work package ${found.code} is closed, so it takes no new time.` };
	}
	return { id: found.id, code: found.code };
}

/**
 * A row as its day's limits take it (TS-095): regular while it fits in the
 * day's expected hours, and past them cut as a timer is cut (`splitAtLimit`,
 * decision 54): regular up to the limit, the rest overtime, where the day
 * takes overtime and its caps take the rest. Else the reason it is skipped;
 * whole-day leave names the person (TR-18d).
 */
function rowsOfLimit(
	calendar: RulesCalendar,
	row: TimeRow,
	tracked: (day: Day) => KindsMs,
): TimeRow[] | { reason: string } {
	const limit = dayLimit(calendar, row.day);
	if (limit.closed) {
		const name = row.person.split(" ")[0] || row.person;
		return { reason: closedReason(limit.closed, row.day, name) };
	}
	const ms = row.minutes * 60_000;
	const ofDay = tracked(row.day);
	const cut = splitAtLimit(
		{ startedAt: 0, endedAt: ms },
		limit.regularMinutes * 60_000 - ofDay.regularMs,
		!limit.noOvertime,
	);
	const regular = cut.overtimeFrom === null ? 0 : Math.floor(cut.overtimeFrom / 60_000);
	if (regular === 0) {
		const kind = kindOfNewTime(calendar, row.day, ms, tracked);
		return kind.ok ? [{ ...row, overtime: kind.overtime }] : { reason: kind.message };
	}
	const rest = row.minutes - regular;
	const afterRegular = (day: Day) =>
		day === row.day ? { ...ofDay, regularMs: ofDay.regularMs + regular * 60_000 } : tracked(day);
	const kind = kindOfNewTime(calendar, row.day, rest * 60_000, afterRegular);
	if (!kind.ok) return { reason: kind.message };
	return [
		{ ...row, minutes: regular, overtime: false },
		{ ...row, minutes: rest, overtime: kind.overtime },
	];
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

/**
 * The clients, projects, tasks and project tasks the preview says to add, each
 * recorded as from an import; clients and projects with their codes (TS-115a).
 * Under Both, a project added with no client is a work code: it bills nothing.
 */
async function recordsToCreate(
	scope: OrganisationScope,
	actorId: string,
	preview: Preview,
): Promise<Known> {
	const [clients, projects, tasks, links, organisation] = await Promise.all([
		scope.clients.select(),
		scope.projects.select(),
		scope.tasks.select(),
		scope.projectTasks.select(),
		organisationOf(scope.organisationId),
	]);
	const clientId = new Map(clients.map((c) => [c.nameKey, c.id]));
	const projectId = new Map(projects.map((p) => [p.nameKey, p.id]));
	const taskId = new Map(tasks.map((t) => [t.nameKey, t.id]));
	const billable = new Map(links.map((l) => [`${l.projectId}|${l.taskId}`, l.billable]));
	const coded = (code: string | null) => ({ code, codeKey: code === null ? null : codeKey(code) });

	const newClients: {
		id: string;
		name: string;
		nameKey: string;
		code: string | null;
		codeKey: string | null;
	}[] = [];
	const ensureClient = (name: string | null, code: string | null) => {
		if (name === null) return null;
		const key = nameKey(name);
		const known = clientId.get(key);
		if (known) return known;
		const id = uuidv7();
		clientId.set(key, id);
		newClients.push({ id, name, nameKey: key, ...coded(code) });
		return id;
	};
	const newProjects: {
		id: string;
		name: string;
		nameKey: string;
		clientId: string | null;
		code: string | null;
		codeKey: string | null;
		billingType?: "non_billable";
	}[] = [];
	const addProject = (name: string, code: string | null, client: string | null) => {
		const id = uuidv7();
		projectId.set(nameKey(name), id);
		newProjects.push({
			id,
			name,
			nameKey: nameKey(name),
			clientId: client,
			...coded(code),
			...(organisation.workCodes && client === null ? { billingType: "non_billable" } : {}),
		});
		return id;
	};
	const newTasks: { id: string; name: string; nameKey: string }[] = [];
	const newLinks: { projectId: string; taskId: string; billable: boolean }[] = [];

	if (preview.kind === "clients") {
		for (const row of preview.records) ensureClient(row.name, row.code);
	} else if (preview.kind === "projects") {
		for (const row of preview.records) {
			addProject(row.name, row.code, ensureClient(row.client, row.clientCode));
		}
	} else {
		for (const row of preview.rows) {
			const project =
				projectId.get(nameKey(row.project)) ??
				addProject(row.project, row.projectCode, ensureClient(row.client, row.clientCode));
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
	// A project the file gives no code is numbered by the pattern, as one a
	// person creates is, passing over the codes the file gives. Under Both, a
	// work code is not: its code is typed.
	const uncoded = newProjects.filter(
		(p) =>
			p.code === null && codeRuleFor(organisation.codeRules, p.clientId === null).pattern !== null,
	);
	if (uncoded.length > 0) {
		const fileCodes = new Set(newProjects.flatMap((p) => (p.codeKey === null ? [] : [p.codeKey])));
		const numbered = await nextPatternCodes(scope, uncoded.length, fileCodes);
		for (const [n, project] of uncoded.entries())
			Object.assign(project, coded(numbered[n] ?? null));
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
	const packageIds = [
		...new Set(preview.rows.flatMap((row) => (row.workPackageId ? [row.workPackageId] : []))),
	];
	const packageBillable = new Map(
		(packageIds.length === 0
			? []
			: await scope.workPackages.select((w) => among(w.id, packageIds))
		).map((wp) => [wp.id, wp.billable]),
	);
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
			workPackageId: row.workPackageId,
			description: row.notes,
			startedAt: new Date(startedAt),
			endedAt: new Date(endedAt),
			spentOn: row.day,
			billable:
				taskId !== null &&
				(known.billable.get(`${projectId}|${taskId}`) ?? false) &&
				(row.workPackageId === null || (packageBillable.get(row.workPackageId) ?? true)),
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
	const sources = await scope.invoiceLineSources.select((s) => among(s.timeEntryId, ids));
	const invoiced = new Set(sources.map((source) => source.timeEntryId));
	const members = new Map((await membersOf(scope, organisationZone)).map((m) => [m.userId, m]));
	const people = [...new Set(entries.map((e) => e.userId))];
	const periods = people.length ? await scope.periods.select((p) => among(p.userId, people)) : [];
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
			lockedThrough: lockReachOf(
				lockedThrough,
				members.get(entry.userId)?.zone ?? organisationZone,
				Date.now(),
			),
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
				among(
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
