import { env } from "cloudflare:workers";
import { and, asc, gt, gte, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { data } from "react-router";

import { type OrganisationScope, organisationScope, users } from "~/db";
import { expectedMinutes, leaveHalfDays, leaveMinutes } from "~/leave/days";
import { calendarOf, leaveContext } from "~/leave/leave.server";
import { type Access, type TimeScope, timeScopeOf } from "~/organisations/access";
import { accessOf } from "~/organisations/access.server";
import { type Membership, notFound } from "~/organisations/membership.server";
import { nameOrEmail } from "~/organisations/people";
import { bounds, dayOf, daysFrom } from "~/time/calendar";

import type { Grouping } from "./choices";
import { parseReportQuery, type ReportDays, type ReportQuery, rangeDays } from "./query";
import { type Piece, piecesOf, type ReportEntry } from "./report";

/**
 * A report read from the database (TS-014a, TS-014b). Whose time it holds is
 * `timeScopeOf` (docs/security.md, "Whose time"): a member's own, a manager's
 * and the people of the teams they manage, an owner's, admin's or Finance's everyone's.
 * The people are passed to SQL; nothing is filtered afterwards. Every read goes
 * through the organisation's scope.
 */

/** How many entries one query reads. An export streams page after page, keyed on `id`. */
export const ENTRY_PAGE_SIZE = 200;

/** D1 takes at most 100 bound parameters a statement; a list of ids is read in chunks under that. */
const IDS_A_QUERY = 90;

/** A person a report can be narrowed to. */
export interface Person {
	id: string;
	name: string;
}

/** Everything a report needs to be read, from the address of its page or of its export. */
export interface ReportRequest {
	scope: OrganisationScope;
	query: ReportQuery;
	/** The grouping used: by project when Clients is turned off and the address asks for client. */
	grouping: Grouping;
	days: ReportDays;
	/** The organisation's zone, which the days are counted in. */
	zone: string;
	/** Whose entries the report reads. */
	people: TimeScope;
	/** Whether the viewer may see everyone's time: an owner, an admin or Finance. */
	seesEveryone: boolean;
	/** The people the viewer may narrow the report to, themselves included, by name. */
	choices: Person[];
	showClients: boolean;
	now: number;
}

/**
 * Reads the report the address asks for. An address that asks for no report
 * that can be made is answered 400; one that names a person the viewer may not
 * see, or who is not a member, 404, as a stranger's address is.
 */
export async function reportRequest(
	membership: Membership,
	url: URL,
	now: number,
): Promise<ReportRequest> {
	const query = parseReportQuery(url.searchParams);
	if (!query) throw data("Bad Request", { status: 400 });

	const { organisation } = membership;
	const scope = organisationScope(env.DB, organisation.id);
	const access = await accessOf(membership);
	const whose = timeScopeOf(access);
	const choices = await peopleToChoose(scope, access);
	if (query.person !== undefined && !choices.some(({ id }) => id === query.person)) {
		throw notFound();
	}

	const zone = organisation.timeZone;
	const showClients = organisation.clientsEnabled;
	return {
		scope,
		query,
		grouping: query.group === "client" && !showClients ? "project" : query.group,
		days: rangeDays(query, dayOf(now, zone), organisation.weekStartsOn),
		zone,
		people: query.person === undefined ? whose : { everyone: false, people: [query.person] },
		seesEveryone: whose.everyone,
		choices,
		showClients,
		now,
	};
}

/** `column` is one of `people`, as one bound parameter however many they are. */
function amongPeople(column: SQLiteColumn, people: readonly string[]): SQL {
	return sql`${column} in (select value from json_each(${JSON.stringify(people)}))`;
}

/**
 * The members of the organisation whose time `access` may see, by name: every
 * member for an owner or admin, the person and the people of the teams they
 * manage for a manager, the person alone for anybody else.
 */
export async function peopleToChoose(scope: OrganisationScope, access: Access): Promise<Person[]> {
	const whose = timeScopeOf(access);
	const members = await scope.memberships.select(
		whose.everyone ? undefined : (m) => amongPeople(m.userId, whose.people),
	);
	const names = await namesOf(members.map((m) => m.userId));
	return members
		.map(({ userId }) => ({ id: userId, name: names.get(userId) ?? "" }))
		.sort((a, b) => a.name.localeCompare(b.name, "en") || (a.id < b.id ? -1 : 1));
}

/** How each of these people is named: their name, or their address when they have given none. */
async function namesOf(ids: readonly string[]): Promise<Map<string, string>> {
	const names = new Map<string, string>();
	const db = drizzle(env.DB);
	for (let at = 0; at < ids.length; at += IDS_A_QUERY) {
		const rows = await db
			.select({ id: users.id, name: users.name, email: users.email })
			.from(users)
			.where(inArray(users.id, ids.slice(at, at + IDS_A_QUERY)));
		for (const row of rows) names.set(row.id, nameOrEmail(row));
	}
	return names;
}

/**
 * The entries of `request` that have time in its days, page by page in the
 * order of their ids: an entry that starts before the last day ends and ends
 * after the first begins, or is still running. Each page is one query of at
 * most `pageSize` entries after the last id of the one before.
 */
export async function* entryPages(
	request: Pick<ReportRequest, "scope" | "days" | "zone" | "people">,
	pageSize = ENTRY_PAGE_SIZE,
): AsyncGenerator<ReportEntry[]> {
	const { scope, people } = request;
	const { from, to } = bounds(request.days.first, request.days.last, request.zone);
	const [projects, clients] = await Promise.all([scope.projects.select(), scope.clients.select()]);
	const projectsById = new Map(projects.map((p) => [p.id, p]));
	const clientNames = new Map(clients.map((c) => [c.id, c.name]));
	const names = new Map<string, string>();

	let after: string | undefined;
	for (;;) {
		const rows = await scope.timeEntries.select(
			(e) =>
				and(
					after === undefined ? undefined : gt(e.id, after),
					lt(e.startedAt, new Date(to)),
					or(isNull(e.endedAt), gt(e.endedAt, new Date(from)), gte(e.startedAt, new Date(from))),
					people.everyone ? undefined : amongPeople(e.userId, people.people),
				),
			{ orderBy: (e) => [asc(e.id)], limit: pageSize },
		);
		const unnamed = [...new Set(rows.map((r) => r.userId))].filter((id) => !names.has(id));
		for (const [id, name] of await namesOf(unnamed)) names.set(id, name);

		yield rows.map((row) => {
			const project = projectsById.get(row.projectId);
			const clientId = project?.clientId ?? null;
			return {
				id: row.id,
				userId: row.userId,
				person: names.get(row.userId) ?? "",
				projectId: row.projectId,
				project: project?.name ?? "",
				clientId,
				client: clientId === null ? null : (clientNames.get(clientId) ?? null),
				description: row.description,
				startedAt: row.startedAt.getTime(),
				endedAt: row.endedAt?.getTime() ?? null,
			};
		});
		const last = rows.at(-1);
		if (rows.length < pageSize || !last) return;
		after = last.id;
	}
}

/** Every piece of the report, in the order of the entries' ids. */
export async function piecesOfReport(request: ReportRequest): Promise<Piece[]> {
	const pieces: Piece[] = [];
	for await (const page of entryPages(request)) {
		for (const entry of page)
			pieces.push(...piecesOf(entry, request.days, request.zone, request.now));
	}
	return pieces;
}

/** One person's line in a report: the time they worked, the time expected of them, and their leave (TS-061). */
export interface PersonLine {
	id: string;
	name: string;
	/** Seconds of tracked time in the range. Leave is never in it. */
	worked: number;
	/** Minutes expected over the range: the working week, less public holidays and approved leave. */
	expectedMinutes: number;
	/** Minutes of approved leave in the range, and the half days they make. */
	leaveMinutes: number;
	leaveHalfDays: number;
}

/**
 * Each person the report holds, with what they worked, what was expected of
 * them and their leave over its days. Worked time comes from `pieces`; leave
 * is read beside it and never added to it.
 */
export async function peopleOfReport(
	request: ReportRequest,
	pieces: readonly Piece[],
): Promise<PersonLine[]> {
	const { people, choices, days, scope } = request;
	const listed = people.everyone ? choices : choices.filter((c) => people.people.includes(c.id));
	if (listed.length === 0) return [];
	const context = await leaveContext(
		scope,
		listed.map((p) => p.id),
		days.first,
		days.last,
	);
	const range = daysFrom(days.first, days.last);
	const worked = new Map<string, number>();
	for (const piece of pieces) {
		worked.set(piece.entry.userId, (worked.get(piece.entry.userId) ?? 0) + piece.seconds);
	}
	return listed.map((person) => {
		const calendar = calendarOf(context, person.id);
		return {
			id: person.id,
			name: person.name,
			worked: worked.get(person.id) ?? 0,
			expectedMinutes: expectedMinutes(calendar, range),
			leaveMinutes: leaveMinutes(calendar, range),
			leaveHalfDays: leaveHalfDays(calendar, range),
		};
	});
}
