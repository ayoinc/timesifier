import * as z from "zod";

import { PersonName } from "~/auth/person-name";
import { headerKey, parseCsv } from "~/import/csv";
import { nameKey } from "~/lib/names";
import { InvitedRole } from "~/organisations/roles";
import { type Day, Day as DaySchema } from "~/time/calendar";

// Company onboarding (TS-108, docs/decisions.md entry 72): inviting many people
// at once, and importing people from a CSV. This module reads what was typed
// or uploaded and decides each person's outcome against what the organisation
// already has; it holds no server code, so pages import its words too. The
// server reads the organisation (`onboarding.server.ts`) and sends.

/** The most addresses "Invite many" takes at once. */
export const MANY_MAX = 200;

/** The most rows a people import takes. */
export const PEOPLE_MAX_ROWS = 1000;

/** The largest people file, in bytes: a thousand full rows fit with room to spare. */
export const PEOPLE_MAX_BYTES = 256 * 1024;

/** What a people import reads, in the order the page names them. */
export const PEOPLE_FIELDS = [
	"email",
	"name",
	"role",
	"team",
	"manager",
	"schedule",
	"start_date",
] as const;
export type PeopleField = (typeof PEOPLE_FIELDS)[number];

export const PEOPLE_FIELD_LABELS: Record<PeopleField, string> = {
	email: "Email",
	name: "Name",
	role: "Role",
	team: "Team",
	manager: "Manager",
	schedule: "Schedule",
	start_date: "Start date",
};

/** The headings each field is read from, as `headerKey` evens them out. */
const HEADINGS: Record<PeopleField, readonly string[]> = {
	email: ["email", "email address", "e mail", "e mail address", "work email"],
	name: ["name", "full name", "person"],
	role: ["role"],
	team: ["team"],
	manager: ["manager", "manager email", "manager's email", "manager email address"],
	schedule: ["schedule", "work schedule"],
	start_date: ["start date", "starts on", "start", "starting"],
};

/** One row of a people file, each cell trimmed; a column the file lacks reads as empty. */
export interface PersonRow {
	/** The line of the file it starts on. */
	line: number;
	email: string;
	name: string;
	role: string;
	team: string;
	manager: string;
	schedule: string;
	startDate: string;
}

export type PeopleFile =
	| {
			ok: true;
			rows: PersonRow[];
			/** The fields the file has a column for. */
			read: PeopleField[];
			/** Headings of columns that are not read, as the file wrote them. */
			unknown: string[];
	  }
	| { ok: false; problem: string };

const NAMED_COLUMNS = "Email, Name, Role, Team, Manager, Schedule and Start date";

/**
 * Reads a people file: its first line names the columns, in any order and any
 * case; columns it does not know are named and left alone. Only Email is
 * needed. A byte order mark, quoted commas and line breaks in quotes are read
 * as `parseCsv` reads them.
 */
export function readPeopleFile(text: string): PeopleFile {
	const parsed = parseCsv(text);
	if (parsed === null) return { ok: false, problem: "A quoted field in the file is never closed." };
	const [header, ...body] = parsed;
	if (!header || body.length === 0) {
		return {
			ok: false,
			problem: `The file needs a first line naming its columns (${NAMED_COLUMNS}) and at least one person.`,
		};
	}
	if (body.length > PEOPLE_MAX_ROWS) {
		return {
			ok: false,
			problem: `A file can hold at most ${PEOPLE_MAX_ROWS} people. Split it.`,
		};
	}
	const columns = new Map<PeopleField, number>();
	const unknown: string[] = [];
	header.cells.forEach((heading, index) => {
		const key = headerKey(heading);
		const field = PEOPLE_FIELDS.find((each) => HEADINGS[each].includes(key));
		if (field && !columns.has(field)) columns.set(field, index);
		else if (heading.trim() !== "") unknown.push(heading.trim());
	});
	if (!columns.has("email")) {
		return {
			ok: false,
			problem: `The file has no Email column. Its first line names the columns: ${NAMED_COLUMNS}.`,
		};
	}
	const cell = (cells: string[], field: PeopleField) => {
		const index = columns.get(field);
		return index === undefined ? "" : (cells[index] ?? "").trim();
	};
	return {
		ok: true,
		read: PEOPLE_FIELDS.filter((field) => columns.has(field)),
		unknown,
		rows: body.map(({ line, cells }) => ({
			line,
			email: cell(cells, "email"),
			name: cell(cells, "name"),
			role: cell(cells, "role"),
			team: cell(cells, "team"),
			manager: cell(cells, "manager"),
			schedule: cell(cells, "schedule"),
			startDate: cell(cells, "start_date"),
		})),
	};
}

/**
 * The addresses in what was pasted into "Invite many": separated by commas,
 * semicolons, spaces or lines, each perhaps written `Name <address>` as a mail
 * program copies it. Empty pieces are dropped; nothing else is.
 */
export function splitAddresses(text: string): string[] {
	return text
		.split(/[,;\r\n]+/)
		.flatMap((piece) => {
			const bracketed = /<([^<>]*)>/.exec(piece);
			return bracketed ? [bracketed[1] ?? ""] : piece.split(/\s+/);
		})
		.map((address) => address.trim())
		.filter((address) => address !== "");
}

const Email = z.email().max(254);

/** An address as it is invited and compared: valid, in lower case; or null. */
export function readEmail(text: string): string | null {
	const parsed = Email.safeParse(text.trim());
	return parsed.success ? parsed.data.toLowerCase() : null;
}

/** A start date, written `YYYY-MM-DD`; or null. */
export function readStartDate(text: string): Day | null {
	const parsed = DaySchema.safeParse(text.trim());
	return parsed.success ? parsed.data : null;
}

export type Invited = z.output<typeof InvitedRole>;

/** The role in a row: empty is a member; Member, Finance or Admin in any case. */
function readRole(text: string): Invited | "owner" | null {
	const typed = text.trim().toLowerCase();
	if (typed === "") return "member";
	if (typed === "owner") return "owner";
	const parsed = InvitedRole.safeParse(typed === "administrator" ? "admin" : typed);
	return parsed.success ? parsed.data : null;
}

/** What the organisation already has, as the outcomes are decided against it. */
export interface Known {
	/** Members, by address in lower case, to their user id. */
	members: ReadonlyMap<string, string>;
	/** Addresses, in lower case, with an invitation still waiting. */
	invited: ReadonlySet<string>;
	/** Teams by `nameKey`. */
	teams: ReadonlyMap<string, { id: string; name: string }>;
	/** Schedules by `nameKey`. */
	schedules: ReadonlyMap<string, { id: string; name: string; archived: boolean }>;
}

/** What is to happen for one person: the invitation, and what applies when they join. */
export interface PersonPlan {
	email: string;
	name: string | null;
	role: Invited;
	team: { id: string; name: string } | null;
	/** The address of who is to manage `team`, in lower case. */
	manager: string | null;
	/** Whether the manager is someone in the same file rather than a member. */
	managerInFile: boolean;
	schedule: { id: string; name: string } | null;
	startsOn: Day | null;
}

export type Outcome =
	| { line: number; email: string; ok: true; plan: PersonPlan }
	| { line: number; email: string; ok: false; problems: string[] };

/**
 * Each row's outcome: the invitation and what applies when they join, or every
 * reason it cannot be sent. A team and a schedule must already exist. A manager
 * is a member, or a person in the same file whose own row can be sent; a row
 * whose manager's row fails fails too, until nothing changes.
 */
export function decidePeople(rows: readonly PersonRow[], known: Known): Outcome[] {
	const firstLine = new Map<string, number>();
	const decided = rows.map((row) => {
		const problems: string[] = [];
		const email = readEmail(row.email);
		if (row.email === "") problems.push("It has no email address.");
		else if (email === null) problems.push(`“${row.email}” is not an email address.`);
		else {
			const earlier = firstLine.get(email);
			if (earlier !== undefined) problems.push(`The same address is on line ${earlier}.`);
			else firstLine.set(email, row.line);
			if (known.members.has(email)) problems.push("They are already a member.");
			else if (known.invited.has(email)) problems.push("An invitation to them is already waiting.");
		}
		const name = row.name === "" ? null : PersonName.safeParse(row.name).success ? row.name : false;
		if (name === false) problems.push("The name is not one line of up to 100 characters.");
		const role = readRole(row.role);
		if (role === "owner") {
			problems.push(
				"Nobody is invited as an owner. Invite them as an admin, then make them an owner on Members.",
			);
		} else if (role === null) {
			problems.push(`“${row.role}” is not a role. Write Member, Finance or Admin.`);
		}
		const team = row.team === "" ? null : (known.teams.get(nameKey(row.team)) ?? false);
		if (team === false) problems.push(`No team is called “${row.team}”. Make it on Team first.`);
		const scheduleFound = row.schedule === "" ? null : known.schedules.get(nameKey(row.schedule));
		if (scheduleFound === undefined) {
			problems.push(
				`No schedule is called “${row.schedule}”. Make it in Settings, Work schedules, first.`,
			);
		} else if (scheduleFound?.archived) {
			problems.push(`The schedule “${scheduleFound.name}” is archived.`);
		}
		const startsOn = row.startDate === "" ? null : readStartDate(row.startDate);
		if (row.startDate !== "" && startsOn === null) {
			problems.push(`“${row.startDate}” is not a date. Write it as 2026-12-01.`);
		} else if (startsOn !== null && row.schedule === "") {
			problems.push("A start date is the day their schedule starts. Name the schedule too.");
		}
		const manager = row.manager === "" ? null : readEmail(row.manager);
		if (row.manager !== "" && manager === null) {
			problems.push(`The manager “${row.manager}” is not an email address.`);
		} else if (manager !== null && manager === email) {
			problems.push("A person cannot be their own manager.");
		} else if (manager !== null && row.team === "") {
			problems.push("A manager looks after a team. Name the team too.");
		}
		return { row, email, name, role, team, schedule: scheduleFound, startsOn, manager, problems };
	});

	// A manager who is not a member must be someone in this file who can be
	// invited. Each pass can fail a row whose manager failed in the pass before.
	let changed = true;
	while (changed) {
		changed = false;
		for (const each of decided) {
			if (each.problems.length > 0 || each.manager === null) continue;
			const manager = each.manager;
			if (known.members.has(manager)) continue;
			if (decided.some((other) => other.email === manager && other.problems.length === 0)) continue;
			const line = firstLine.get(manager);
			each.problems.push(
				line !== undefined
					? `Their manager ${manager} is on line ${line}, which cannot be sent.`
					: known.invited.has(manager)
						? `Their manager ${manager} is invited but has not joined. Name a member, or someone in this file.`
						: `Nobody in this organisation or this file has the address ${manager}.`,
			);
			changed = true;
		}
	}

	return decided.map(({ row, email, name, role, team, schedule, startsOn, manager, problems }) => {
		if (problems.length > 0 || email === null || role === null || role === "owner") {
			return { line: row.line, email: row.email, ok: false, problems };
		}
		return {
			line: row.line,
			email,
			ok: true,
			plan: {
				email,
				name: typeof name === "string" ? name : null,
				role,
				team: typeof team === "object" ? team : null,
				manager,
				managerInFile: manager !== null && !known.members.has(manager),
				schedule: schedule ? { id: schedule.id, name: schedule.name } : null,
				startsOn,
			},
		};
	});
}

/** Each address of "Invite many", as a row with nothing but the address, the role and the team. */
export function rowsOfAddresses(addresses: readonly string[], role: Invited, team: string) {
	return addresses.map(
		(email, index): PersonRow => ({
			line: index + 1,
			email,
			name: "",
			role,
			team,
			manager: "",
			schedule: "",
			startDate: "",
		}),
	);
}

/** What a person reads when the seats left are fewer than the invitations. */
export function seatsProblem(wanted: number, left: number): string {
	const need = `${wanted} ${wanted === 1 ? "invitation needs a seat" : "invitations need a seat each"}`;
	if (left <= 0) {
		return `${need}, and no seat is left on this organisation's plan. Nothing was sent. Ask Timesifier for more seats, or remove someone first.`;
	}
	return `${need}, and ${left} ${left === 1 ? "seat is" : "seats are"} left on this organisation's plan. Nothing was sent. Send ${left === 1 ? "one" : `at most ${left}`}, or ask Timesifier for more seats.`;
}

/** What a person reads when the invitations would pass their day's cap. */
export function capProblem(wanted: number, left: number, cap: number): string {
	return `You may send ${cap} invitations in any 24 hours, and ${left} of them ${left === 1 ? "is" : "are"} left. Nothing was sent: these are ${wanted}. Send fewer, or the rest tomorrow.`;
}
