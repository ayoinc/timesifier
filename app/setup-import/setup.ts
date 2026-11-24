import type { BillingType } from "~/billing/billable";
import { headerKey, parseCsv } from "~/import/csv";
import { CODE_PROBLEM, codeKey, typedCode } from "~/lib/codes";
import { nameKey, RECORD_NAME_PROBLEM, recordName } from "~/lib/names";
import { parseMoney } from "~/money/typed";
import { readEmail, readStartDate } from "~/onboarding/people";
import { overlaps, type Stretch, type TeamRole } from "~/projects/teams";
import { WORK_PACKAGE_NAME_MAX_LENGTH, type WorkPackageBudgetKind } from "~/projects/work-packages";
import type { Day } from "~/time/calendar";
import { hasClients, hasWorkCodes, type WorkModel } from "~/workspace/work-model";

// The set-up import (TS-115d, docs/decisions.md entry 77): an organisation's
// projects, their work packages and the people on each project's team, from
// one CSV whose `kind` column says what each row is. This module reads the
// file and decides each row's outcome against what the organisation already
// has; it holds no server code, so the page imports its words too. The server
// reads the organisation and writes (`setup-import.server.ts`).

/** The most rows a set-up import takes. */
export const SETUP_MAX_ROWS = 1000;

/** The largest set-up file, in bytes: a thousand full rows fit with room to spare. */
export const SETUP_MAX_BYTES = 256 * 1024;

/** What each row of a set-up file is. */
export const SETUP_KINDS = ["project", "work_package", "assignment"] as const;
export type SetupKind = (typeof SETUP_KINDS)[number];

export const SETUP_KIND_LABELS: Record<SetupKind, string> = {
	project: "Project",
	work_package: "Work package",
	assignment: "Assignment",
};

/** What a set-up import reads, in the order the page names them. */
export const SETUP_FIELDS = [
	"kind",
	"client_code",
	"project_code",
	"code",
	"name",
	"starts",
	"ends",
	"billing",
	"budget",
	"email",
	"role",
] as const;
export type SetupField = (typeof SETUP_FIELDS)[number];

export const SETUP_FIELD_LABELS: Record<SetupField, string> = {
	kind: "Kind",
	client_code: "Client code",
	project_code: "Project code",
	code: "Code",
	name: "Name",
	starts: "Starts",
	ends: "Ends",
	billing: "Billing",
	budget: "Budget",
	email: "Email",
	role: "Role",
};

/** Which kinds read each field: a cell in a column its kind does not read is left alone. */
export const SETUP_FIELD_KINDS: Record<SetupField, readonly SetupKind[]> = {
	kind: SETUP_KINDS,
	client_code: ["project"],
	project_code: SETUP_KINDS,
	code: ["work_package"],
	name: ["project", "work_package"],
	starts: SETUP_KINDS,
	ends: SETUP_KINDS,
	billing: ["project"],
	budget: ["work_package"],
	email: ["assignment"],
	role: ["assignment"],
};

/** The headings each field is read from, as `headerKey` evens them out. */
const HEADINGS: Record<SetupField, readonly string[]> = {
	kind: ["kind", "type", "row kind", "record"],
	client_code: ["client code", "client"],
	project_code: ["project code", "project"],
	code: ["code", "work package code", "wp code", "package code", "work package"],
	name: ["name", "title"],
	starts: ["starts", "starts on", "start", "start date", "from"],
	ends: ["ends", "ends on", "end", "end date", "until", "to"],
	billing: ["billing", "billing type", "bills"],
	budget: ["budget"],
	email: ["email", "email address", "e mail", "e mail address", "person", "work email"],
	role: ["role", "team role"],
};

/** One row of a set-up file, each cell trimmed; a column the file lacks reads as empty. */
export type SetupRow = { line: number } & Record<SetupField, string>;

export type SetupFile =
	| {
			ok: true;
			rows: SetupRow[];
			/** The fields the file has a column for. */
			read: SetupField[];
			/** Headings of columns that are not read, as the file wrote them. */
			unknown: string[];
	  }
	| { ok: false; problem: string };

const NAMED_COLUMNS =
	"Kind, Client code, Project code, Code, Name, Starts, Ends, Billing, Budget, Email and Role";

/**
 * Reads a set-up file: its first line names the columns, in any order and any
 * case; columns it does not know are named and left alone. Kind and Project
 * code are needed. A byte order mark, quoted commas and line breaks in quotes
 * are read as `parseCsv` reads them.
 */
export function readSetupFile(text: string): SetupFile {
	const parsed = parseCsv(text);
	if (parsed === null) return { ok: false, problem: "A quoted field in the file is never closed." };
	const [header, ...body] = parsed;
	if (!header || body.length === 0) {
		return {
			ok: false,
			problem: `The file needs a first line naming its columns (${NAMED_COLUMNS}) and at least one row.`,
		};
	}
	if (body.length > SETUP_MAX_ROWS) {
		return { ok: false, problem: `A file can hold at most ${SETUP_MAX_ROWS} rows. Split it.` };
	}
	const columns = new Map<SetupField, number>();
	const unknown: string[] = [];
	header.cells.forEach((heading, index) => {
		const key = headerKey(heading);
		const field = SETUP_FIELDS.find((each) => HEADINGS[each].includes(key));
		if (field && !columns.has(field)) columns.set(field, index);
		else if (heading.trim() !== "") unknown.push(heading.trim());
	});
	for (const needed of ["kind", "project_code"] as const) {
		if (!columns.has(needed)) {
			return {
				ok: false,
				problem: `The file has no ${SETUP_FIELD_LABELS[needed]} column. Its first line names the columns: ${NAMED_COLUMNS}.`,
			};
		}
	}
	return {
		ok: true,
		read: SETUP_FIELDS.filter((field) => columns.has(field)),
		unknown,
		rows: body.map(({ line, cells }) => {
			const row = { line } as SetupRow;
			for (const field of SETUP_FIELDS) {
				const index = columns.get(field);
				row[field] = index === undefined ? "" : (cells[index] ?? "").trim();
			}
			return row;
		}),
	};
}

/** What the organisation already has, as the rows are decided against it. */
export interface SetupKnown {
	workModel: WorkModel;
	/** What the organisation calls one work code, in a sentence: "work code". */
	workCode: string;
	/** The organisation's currency, which a project takes unless its client has one. */
	currency: string;
	/** The day it is where the organisation is: an assignment with no first day starts on it. */
	today: Day;
	/** Clients by `codeKey`. */
	clients: ReadonlyMap<
		string,
		{ id: string; code: string; archived: boolean; currency: string | null }
	>;
	/** Projects by `codeKey`, each with the currency its money is in. */
	projects: ReadonlyMap<
		string,
		{
			id: string;
			code: string;
			name: string;
			archived: boolean;
			currency: string;
			billable: boolean;
		}
	>;
	/** The `nameKey`s of every project's name: names are unique in an organisation, as codes are. */
	projectNames: ReadonlySet<string>;
	/** The `codeKey`s of each project's work packages, by project id. */
	workPackages: ReadonlyMap<string, ReadonlySet<string>>;
	/** Members, by address in lower case, to their user id. */
	members: ReadonlyMap<string, string>;
	/** Addresses, in lower case, with an invitation still waiting, to that invitation's id. */
	invited: ReadonlyMap<string, string>;
	/**
	 * The stretches already on each team, by `stretchKey`: a member's
	 * `project_members` rows, and an invited person's assignments still waiting.
	 */
	stretches: ReadonlyMap<string, readonly Stretch[]>;
}

/** Who an assignment is for: a member, or a person whose invitation still waits. */
export type Assignee = { userId: string } | { invitationId: string };

/** The key of one person's stretches on one project. */
export function stretchKey(projectId: string, who: Assignee): string {
	return "userId" in who
		? `${projectId}/user/${who.userId}`
		: `${projectId}/invitation/${who.invitationId}`;
}

/** A project a row names: one the organisation has, or one a row of the same file adds. */
export type ProjectRef =
	| { existing: true; id: string; code: string }
	| { existing: false; code: string; line: number };

export interface ProjectPlan {
	code: string;
	name: string;
	client: { id: string; code: string } | null;
	/** Whether it is a work code: no client, billing nothing, under Both. */
	workCode: boolean;
	billing: BillingType;
	startsOn: Day | null;
	endsOn: Day | null;
}

export interface PackagePlan {
	project: ProjectRef;
	code: string;
	name: string;
	startsOn: Day | null;
	endsOn: Day | null;
	budget: { kind: WorkPackageBudgetKind; amount: number | null };
	/** The budget's currency, for its words: the project's. */
	currency: string;
	billable: boolean;
}

export interface AssignmentPlan {
	project: ProjectRef;
	email: string;
	who: Assignee;
	role: TeamRole;
	startsOn: Day;
	endsOn: Day | null;
	/** Whether the first day was left empty and is the day of the import. */
	startsToday: boolean;
}

export type SetupOutcome =
	| { line: number; ok: true; kind: "project"; plan: ProjectPlan }
	| { line: number; ok: true; kind: "work_package"; plan: PackagePlan }
	| { line: number; ok: true; kind: "assignment"; plan: AssignmentPlan }
	| {
			line: number;
			ok: false;
			kind: SetupKind | null;
			/** What the row names, for the list: its code, or its address. */
			label: string;
			problems: string[];
	  };

/** The kind a row says it is, or null. */
export function readKind(text: string, workCode: string): SetupKind | null {
	const typed = headerKey(text);
	if (["project", "projects", headerKey(workCode)].includes(typed)) return "project";
	if (["work package", "work packages", "workpackage", "package", "wp"].includes(typed))
		return "work_package";
	if (["assignment", "assignments", "team", "team member", "member"].includes(typed))
		return "assignment";
	return null;
}

/** A project's billing as typed: empty is null, for the default. */
function readBilling(text: string): BillingType | null | false {
	const typed = headerKey(text);
	if (typed === "") return null;
	if (["hourly", "time and materials", "t&m", "time & materials"].includes(typed)) return "hourly";
	if (["fixed fee", "fixed", "fixed price"].includes(typed)) return "fixed_fee";
	if (["non billable", "nonbillable", "not billable", "none"].includes(typed))
		return "non_billable";
	return false;
}

/** A team role as typed: empty is a member. */
function readRole(text: string): TeamRole | null {
	const typed = headerKey(text);
	if (typed === "" || typed === "member") return "member";
	if (["delivery manager", "dm", "lead"].includes(typed)) return "delivery_manager";
	return null;
}

/**
 * A work package's budget as typed: hours as `120h` or `37.5 hours`; fees in
 * the project's currency as `5000 GBP`, `GBP 5,000` or `£5,000` where the
 * symbol is the currency's own. Empty is none.
 */
function readBudget(
	text: string,
	currency: string,
): { kind: WorkPackageBudgetKind; amount: number | null } | string {
	const typed = text.trim();
	if (typed === "") return { kind: "none", amount: null };
	const hours = /^(\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.(\d{1,2}))?\s*(?:h|hrs?|hours?)$/i.exec(typed);
	if (hours) {
		const [, whole = "", fraction = ""] = hours;
		return {
			kind: "hours",
			amount:
				Number(whole.replaceAll(",", "")) * 60 + Math.round(Number(`0.${fraction || "0"}`) * 60),
		};
	}
	const symbols: Record<string, string> = { GBP: "£", EUR: "€", USD: "$" };
	const symbol = symbols[currency];
	const fees =
		new RegExp(`^${currency}\\s*([\\d.,]+)$`, "i").exec(typed) ??
		new RegExp(`^([\\d.,]+)\\s*${currency}$`, "i").exec(typed) ??
		(symbol ? new RegExp(`^\\${symbol}\\s*([\\d.,]+)$`).exec(typed) : null);
	const amount = fees?.[1] === undefined ? null : parseMoney(fees[1], currency);
	if (amount !== null) return { kind: "fees", amount };
	return `“${typed}” is not a budget. Write hours, such as 120h, or fees in the project's currency, such as 5000 ${currency}.`;
}

/** A day cell: empty is null; otherwise a day or `false`. */
function readDay(text: string): Day | null | false {
	if (text === "") return null;
	return readStartDate(text) ?? false;
}

const notADay = (text: string) => `“${text}” is not a date. Write it as 2026-12-01.`;
const ENDS_BEFORE_START = "It ends before it starts.";

/**
 * Each row's outcome against what the organisation has and the rest of the
 * file: what it will add, or every reason it will not. Rows are matched by
 * code, ignoring case: a work package or an assignment names its project by
 * its code, which is a project the organisation has or a project row of the
 * same file, above or below it. A row whose project row is not imported is
 * not imported either. The order of the file does not matter; the import
 * adds projects first, then work packages, then assignments.
 */
export function decideSetup(rows: readonly SetupRow[], known: SetupKnown): SetupOutcome[] {
	const clients = hasClients(known.workModel);
	const workCodes = hasWorkCodes(known.workModel);
	const kinds = rows.map((row) => readKind(row.kind, known.workCode));

	// Projects first: every other row may name one. `fileProjects` holds the
	// first project row of each code, imported or not.
	const projectLine = new Map<string, number>();
	const nameLine = new Map<string, number>();
	const projectOutcomes = new Map<number, SetupOutcome>();
	const fileProjects = new Map<string, SetupOutcome>();
	rows.forEach((row, index) => {
		if (kinds[index] !== "project") return;
		const problems: string[] = [];
		const code = typedCode(row.project_code);
		const key = code ? codeKey(code) : null;
		if (code === null) problems.push("It has no project code: rows are matched by it.");
		else if (code === false) problems.push(`The project code: ${CODE_PROBLEM}`);
		else if (key !== null) {
			const earlier = projectLine.get(key);
			if (earlier !== undefined) problems.push(`The same project code is on line ${earlier}.`);
			else projectLine.set(key, row.line);
			if (known.projects.has(key)) problems.push(`A project with the code ${code} already exists.`);
		}
		const name = row.name === "" ? null : recordName(row.name);
		if (row.name === "") problems.push("It has no name.");
		else if (name === null) problems.push(`The name: ${RECORD_NAME_PROBLEM}`);
		else {
			const key = nameKey(name);
			const earlier = nameLine.get(key);
			if (earlier !== undefined) problems.push(`The same name is on line ${earlier}.`);
			else nameLine.set(key, row.line);
			if (known.projectNames.has(key)) problems.push(`A project called “${name}” already exists.`);
		}
		let client: ProjectPlan["client"] = null;
		const clientCode = row.client_code;
		if (clientCode !== "") {
			const found = known.clients.get(codeKey(clientCode));
			if (!clients) problems.push("This organisation has no clients. Leave Client code empty.");
			else if (!found)
				problems.push(
					`No client has the code ${clientCode}. Add it, or its code, on Clients first.`,
				);
			else if (found.archived) problems.push(`The client ${found.code} is archived.`);
			else client = { id: found.id, code: found.code };
		}
		const workCode = workCodes && clientCode === "";
		const billing = readBilling(row.billing);
		if (billing === false) {
			problems.push(
				`“${row.billing}” is not a way of billing. Write Hourly, Fixed fee or Non-billable.`,
			);
		} else if (workCode && billing !== null && billing !== "non_billable") {
			problems.push(
				`A project with no client is a ${known.workCode} here, and bills nothing. Leave Billing empty, or name its client.`,
			);
		}
		const startsOn = readDay(row.starts);
		const endsOn = readDay(row.ends);
		if (startsOn === false) problems.push(notADay(row.starts));
		if (endsOn === false) problems.push(notADay(row.ends));
		if (startsOn && endsOn && endsOn < startsOn) problems.push(ENDS_BEFORE_START);
		const outcome: SetupOutcome =
			problems.length > 0 ||
			!code ||
			!name ||
			billing === false ||
			startsOn === false ||
			endsOn === false
				? { line: row.line, ok: false, kind: "project", label: row.project_code, problems }
				: {
						line: row.line,
						ok: true,
						kind: "project",
						plan: {
							code,
							name,
							client,
							workCode,
							billing: workCode ? "non_billable" : (billing ?? "hourly"),
							startsOn,
							endsOn,
						},
					};
		projectOutcomes.set(index, outcome);
		if (key !== null && projectLine.get(key) === row.line) fileProjects.set(key, outcome);
	});

	/** The project `typed` names, its currency and whether it bills; or why there is none. */
	const projectOf = (
		typed: string,
	): { ref: ProjectRef; currency: string; billable: boolean } | { problem: string } => {
		const code = typedCode(typed);
		if (code === null) return { problem: "It has no project code." };
		if (code === false) return { problem: `The project code: ${CODE_PROBLEM}` };
		const key = codeKey(code);
		const existing = known.projects.get(key);
		if (existing) {
			if (existing.archived) return { problem: `The project ${existing.code} is archived.` };
			return {
				ref: { existing: true, id: existing.id, code: existing.code },
				currency: existing.currency,
				billable: existing.billable,
			};
		}
		const inFile = fileProjects.get(key);
		if (inFile?.ok && inFile.kind === "project") {
			const clientCurrency = inFile.plan.client
				? (known.clients.get(codeKey(inFile.plan.client.code))?.currency ?? null)
				: null;
			return {
				ref: { existing: false, code: inFile.plan.code, line: inFile.line },
				currency: clientCurrency ?? known.currency,
				billable: inFile.plan.billing !== "non_billable",
			};
		}
		if (inFile) return { problem: `Its project, on line ${inFile.line}, is not imported.` };
		return { problem: `No project has the code ${code}, here or in this file.` };
	};

	const packageLine = new Map<string, number>();
	const assigned = new Map<string, { line: number; stretch: Stretch }[]>();
	return rows.map((row, index): SetupOutcome => {
		const kind = kinds[index] ?? null;
		if (kind === "project") {
			return projectOutcomes.get(index) as SetupOutcome;
		}
		if (kind === null) {
			return {
				line: row.line,
				ok: false,
				kind: null,
				label: row.project_code,
				problems: [
					row.kind === ""
						? "It has no kind. Write Project, Work package or Assignment."
						: `“${row.kind}” is not a kind. Write Project, Work package or Assignment.`,
				],
			};
		}
		const problems: string[] = [];
		const project = projectOf(row.project_code);
		if ("problem" in project) problems.push(project.problem);
		const startsOn = readDay(row.starts);
		const endsOn = readDay(row.ends);
		if (startsOn === false) problems.push(notADay(row.starts));
		if (endsOn === false) problems.push(notADay(row.ends));

		if (kind === "work_package") {
			const code = typedCode(row.code);
			if (code === null) problems.push("It has no code.");
			else if (code === false) problems.push(`The code: ${CODE_PROBLEM}`);
			else if (!("problem" in project)) {
				const projectKey = project.ref.existing ? project.ref.id : `line:${project.ref.line}`;
				const key = `${projectKey}/${codeKey(code)}`;
				const earlier = packageLine.get(key);
				if (earlier !== undefined)
					problems.push(`The same work package code is on line ${earlier}.`);
				else packageLine.set(key, row.line);
				if (project.ref.existing && known.workPackages.get(project.ref.id)?.has(codeKey(code))) {
					problems.push(`${project.ref.code} already has a work package with the code ${code}.`);
				}
			}
			const name = row.name === "" ? null : recordName(row.name);
			if (row.name === "") problems.push("It has no name.");
			else if (name === null || name.length > WORK_PACKAGE_NAME_MAX_LENGTH) {
				problems.push(`The name: ${RECORD_NAME_PROBLEM}`);
			}
			if (startsOn && endsOn && endsOn < startsOn) problems.push(ENDS_BEFORE_START);
			const budget = "problem" in project ? null : readBudget(row.budget, project.currency);
			if (typeof budget === "string") problems.push(budget);
			if (
				problems.length > 0 ||
				"problem" in project ||
				!code ||
				!name ||
				budget === null ||
				typeof budget === "string" ||
				startsOn === false ||
				endsOn === false
			) {
				return { line: row.line, ok: false, kind, label: row.code || row.project_code, problems };
			}
			return {
				line: row.line,
				ok: true,
				kind,
				plan: {
					project: project.ref,
					code,
					name,
					startsOn,
					endsOn,
					budget,
					currency: project.currency,
					billable: project.billable,
				},
			};
		}

		// An assignment.
		const email = readEmail(row.email);
		let who: Assignee | null = null;
		if (row.email === "") problems.push("It has no email address.");
		else if (email === null) problems.push(`“${row.email}” is not an email address.`);
		else {
			const userId = known.members.get(email);
			const invitationId = known.invited.get(email);
			if (userId) who = { userId };
			else if (invitationId) who = { invitationId };
			else {
				problems.push(
					`Nobody in this organisation or invited to it has the address ${email}. Invite them first.`,
				);
			}
		}
		const role = readRole(row.role);
		if (role === null) {
			problems.push(`“${row.role}” is not a team role. Write Member or Delivery manager.`);
		}
		const first = startsOn === null ? known.today : startsOn;
		if (first && endsOn && endsOn < first) problems.push(ENDS_BEFORE_START);
		if (who && first && endsOn !== false && !("problem" in project)) {
			const stretch: Stretch = { startsOn: first, endsOn };
			const projectKey = project.ref.existing ? project.ref.id : `line:${project.ref.line}`;
			const key = stretchKey(projectKey, who);
			const already = project.ref.existing ? (known.stretches.get(key) ?? []) : [];
			const inFile = assigned.get(key) ?? [];
			const clash = inFile.find((other) => overlaps(other.stretch, stretch));
			if (already.some((other) => overlaps(other, stretch))) {
				problems.push(`${email} is already on ${project.ref.code}'s team on some of those days.`);
			} else if (clash) {
				problems.push(
					`Line ${clash.line} puts ${email} on ${project.ref.code}'s team on some of those days.`,
				);
			} else if (problems.length === 0) {
				assigned.set(key, [...inFile, { line: row.line, stretch }]);
			}
		}
		if (
			problems.length > 0 ||
			"problem" in project ||
			!who ||
			!email ||
			!role ||
			!first ||
			endsOn === false
		) {
			return { line: row.line, ok: false, kind, label: row.email || row.project_code, problems };
		}
		return {
			line: row.line,
			ok: true,
			kind,
			plan: {
				project: project.ref,
				email,
				who,
				role,
				startsOn: first,
				endsOn,
				startsToday: startsOn === null,
			},
		};
	});
}

/** How many rows of each kind a file adds, and how many it skips. */
export interface SetupCounts {
	projects: number;
	workPackages: number;
	/** Every assignment, those waiting for invited people among them. */
	assignments: number;
	/** Assignments of invited people, made when each joins. */
	waiting: number;
	skipped: number;
}

export function countsOf(outcomes: readonly SetupOutcome[]): SetupCounts {
	const of = (kind: SetupKind) => outcomes.filter((o) => o.ok && o.kind === kind).length;
	return {
		projects: of("project"),
		workPackages: of("work_package"),
		assignments: of("assignment"),
		waiting: outcomes.filter((o) => o.ok && o.kind === "assignment" && "invitationId" in o.plan.who)
			.length,
		skipped: outcomes.filter((o) => !o.ok).length,
	};
}

/** "3 projects", "1 project". */
export function counted(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}
