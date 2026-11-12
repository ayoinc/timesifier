import { type Day, Day as DaySchema } from "~/time/calendar";

import { headerKey } from "./csv";

/**
 * What an import reads from each column (TS-076). A file's first line names
 * its columns; each field below is taken from the column chosen for it. The
 * Harvest preset chooses by Harvest's own headings, so both its 8-column
 * import file and its "Export all time" (the detailed time report, whose
 * other columns are left alone) are read as they are.
 */

export type ImportKind = "time" | "clients" | "projects";

export const TIME_FIELDS = [
	"date",
	"client",
	"project",
	"task",
	"notes",
	"hours",
	"first_name",
	"last_name",
	"person",
	"email",
] as const;
export type TimeField = (typeof TIME_FIELDS)[number];

export const CLIENT_FIELDS = ["client", "currency"] as const;
export const PROJECT_FIELDS = ["client", "project"] as const;

/** The fields each kind of import reads, in the order the page asks for them. */
export const FIELDS: Record<ImportKind, readonly string[]> = {
	time: TIME_FIELDS,
	clients: CLIENT_FIELDS,
	projects: PROJECT_FIELDS,
};

/** The fields an import cannot do without. Time also needs a person: an email, or a name. */
export const REQUIRED: Record<ImportKind, readonly string[]> = {
	time: ["date", "project", "hours"],
	clients: ["client"],
	projects: ["project"],
};

/** Each field as the page names it. */
export const FIELD_LABELS: Record<string, string> = {
	date: "Date",
	client: "Client",
	project: "Project",
	task: "Task",
	notes: "Notes",
	hours: "Hours",
	first_name: "First name",
	last_name: "Last name",
	person: "Full name",
	email: "Email",
	currency: "Currency",
};

/** Harvest's headings for each field, as `headerKey` evens them out; a few common others too. */
const HARVEST_HEADERS: Record<string, readonly string[]> = {
	date: ["date", "spent date", "day"],
	client: ["client", "client name"],
	project: ["project", "project name"],
	task: ["task", "task name"],
	notes: ["notes", "note", "description"],
	hours: ["hours", "duration"],
	first_name: ["first name", "firstname"],
	last_name: ["last name", "lastname", "surname"],
	person: ["person", "name", "full name", "user"],
	email: ["email", "email address", "e mail"],
	currency: ["currency", "preferred currency"],
};

/** Which column holds each field: the column's index, by the field's name. */
export type Mapping = Record<string, number>;

/** The Harvest preset for `kind`: each field from the first column whose heading Harvest uses for it. */
export function harvestMapping(kind: ImportKind, headers: readonly string[]): Mapping {
	const keys = headers.map(headerKey);
	const mapping: Mapping = {};
	for (const field of FIELDS[kind]) {
		const column = keys.findIndex((key) => HARVEST_HEADERS[field]?.includes(key));
		if (column >= 0) mapping[field] = column;
	}
	return mapping;
}

/** The fields `kind` needs that `mapping` has no column for, by their labels. */
export function missingFields(kind: ImportKind, mapping: Mapping): string[] {
	const missing = REQUIRED[kind].filter((field) => mapping[field] === undefined);
	if (
		kind === "time" &&
		mapping.email === undefined &&
		mapping.person === undefined &&
		mapping.first_name === undefined
	) {
		missing.push("email");
	}
	return missing.map((field) =>
		field === "email" && kind === "time"
			? "a person: Email, Full name, or First and Last name"
			: (FIELD_LABELS[field] ?? field),
	);
}

/** A date as Harvest writes one, `YYYY-MM-DD` or `M/D/YYYY`, as a day; null when it is neither. */
export function readDate(value: string): Day | null {
	const text = value.trim();
	const american = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
	const iso = american
		? `${american[3]}-${american[1]?.padStart(2, "0")}-${american[2]?.padStart(2, "0")}`
		: text.slice(0, 10);
	if (!american && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
	const parsed = DaySchema.safeParse(iso);
	return parsed.success ? parsed.data : null;
}

/** Hours as decimal (`7.5`) or `H:MM`, as whole minutes; null unless above 0 and at most 24 hours. */
export function readMinutes(value: string): number | null {
	const text = value.trim();
	let minutes: number;
	const clock = /^(\d{1,2}):([0-5]\d)$/.exec(text);
	if (clock) minutes = Number(clock[1]) * 60 + Number(clock[2]);
	else if (/^\d+(\.\d+)?$|^\.\d+$/.test(text)) minutes = Math.round(Number(text) * 60);
	else return null;
	return minutes > 0 && minutes <= 24 * 60 ? minutes : null;
}

/** A name as names are compared: lower case, spaces evened out. */
export function personKey(name: string): string {
	return name.trim().toLowerCase().replace(/\s+/g, " ");
}
