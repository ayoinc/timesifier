import { env } from "cloudflare:workers";
import { and, asc, gt, gte, inArray, lte, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { data } from "react-router";

import { type OrganisationScope, organisationScope, users } from "~/db";
import { expectedMinutes, leaveHalfDays, leaveMinutes } from "~/leave/days";
import { calendarOf, leaveContext, shortNoticeCounts } from "~/leave/leave.server";
import { type Access, type TimeScope, timeScopeOf } from "~/organisations/access";
import { accessOf } from "~/organisations/access.server";
import { type Membership, notFound } from "~/organisations/membership.server";
import { addressLine, nameOrEmail, shownName } from "~/organisations/people";
import { type Day, dayOf, daysFrom } from "~/time/calendar";
import { zoneOfMember } from "~/time/zones.server";

import type { Grouping } from "./choices";
import {
	parseReportQuery,
	type RangeProblem,
	type ReportDays,
	type ReportQuery,
	rangeDays,
} from "./query";
import { type ReportEntry, type Row, rowOf } from "./report";

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

/** A person a report can be narrowed to, by the name lists show them by (`shownName`). */
export interface Person {
	id: string;
	name: string;
	/** Their address, shown under the name when they have given none. */
	address: string | null;
	email: string;
}

/** What a report's page needs whether or not its range makes a report. */
interface ReportChoices {
	scope: OrganisationScope;
	/** What the address asks for, its days as typed. */
	query: ReportQuery;
	/** The grouping used: by project when Clients is turned off and the address asks for client. */
	grouping: Grouping;
	/** The viewer's zone, which the days are counted in (docs/decisions.md entry 26). */
	zone: string;
	/** Whose entries the report reads. */
	people: TimeScope;
	/** Whether the viewer may see everyone's time: an owner, an admin or Finance. */
	seesEveryone: boolean;
	/** The people the viewer may narrow the report to, themselves included, by name. */
	choices: Person[];
	showClients: boolean;
	now: number;
	/** Only the time with this tag, on the entry or on its project (TS-085). */
	tag?: string;
	/** What the viewer may see and do, for the views that read more than time (TS-068, TS-084). */
	access: Access;
	/** Today in the viewer's zone. */
	today: Day;
	/** The day the organisation's weeks start on, for the way back to today's week. */
	weekStartsOn: number;
}

/** Everything a report needs to be read, from the address of its page or of its export. */
export interface ReportRequest extends ReportChoices {
	days: ReportDays;
}

/** A custom range that makes no report: the page shows the form again with `problem` under its field. */
export interface RefusedReport extends ReportChoices {
	problem: RangeProblem;
}

/**
 * Reads the report the address asks for. An address the form did not write
 * is answered 400; one that names a person the viewer may not see, or who is
 * not a member, 404, as a stranger's address is. A custom range that cannot be
 * reported on is a `RefusedReport`, for the page to say why (TS-091, W05).
 */
export async function reportRequest(
	membership: Membership,
	url: URL,
	now: number,
): Promise<ReportRequest | RefusedReport> {
	const parsed = parseReportQuery(url.searchParams);
	if (!parsed) throw data("Bad Request", { status: 400 });
	const { query, problem } = parsed;

	const { organisation } = membership;
	const scope = organisationScope(env.DB, organisation.id);
	const access = await accessOf(membership);
	const whose = timeScopeOf(access);
	const choices = await peopleToChoose(scope, access);
	if (query.person !== undefined && !choices.some(({ id }) => id === query.person)) {
		throw notFound();
	}

	const zone = await zoneOfMember(membership);
	const today = dayOf(now, zone);
	const showClients = organisation.clientsEnabled;
	const report: ReportChoices = {
		scope,
		query,
		grouping: query.group === "client" && !showClients ? "project" : query.group,

		zone,
		people: query.person === undefined ? whose : { everyone: false, people: [query.person] },
		seesEveryone: whose.everyone,
		choices,
		showClients,
		now,
		tag: query.tag,
		access,
		today,
		weekStartsOn: organisation.weekStartsOn,
	};
	if (problem) return { ...report, problem };
	return { ...report, days: rangeDays(query, today, organisation.weekStartsOn) };
}

/** `column` is one of `people`, as one bound parameter however many they are. */
function amongPeople(column: SQLiteColumn, people: readonly string[]): SQL {
	return sql`${column} in (select value from json_each(${JSON.stringify(people)}))`;
}

/**
 * An entry has `tagId` when it has the tag itself or its project has it
 * (TS-085), each read from the organisation's own rows.
 */
function taggedWith(
	organisationId: string,
	entryId: SQLiteColumn,
	projectId: SQLiteColumn,
	tagId: string,
): SQL {
	return sql`(${entryId} in (select time_entry_id from entry_tags where organisation_id = ${organisationId} and tag_id = ${tagId}) or ${projectId} in (select project_id from project_tags where organisation_id = ${organisationId} and tag_id = ${tagId}))`;
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
	const accounts = await accountsOf(members.map((m) => m.userId));
	return members
		.map(({ userId }) => {
			const account = accounts.get(userId) ?? { name: null, email: "" };
			return {
				id: userId,
				name: shownName(account),
				address: addressLine(account),
				email: account.email,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name, "en") || (a.id < b.id ? -1 : 1));
}

/** The name and address of each of these people. */
async function accountsOf(
	ids: readonly string[],
): Promise<Map<string, { name: string | null; email: string }>> {
	const accounts = new Map<string, { name: string | null; email: string }>();
	const db = drizzle(env.DB);
	for (let at = 0; at < ids.length; at += IDS_A_QUERY) {
		const rows = await db
			.select({ id: users.id, name: users.name, email: users.email })
			.from(users)
			.where(inArray(users.id, ids.slice(at, at + IDS_A_QUERY)));
		for (const row of rows) accounts.set(row.id, row);
	}
	return accounts;
}

/**
 * How each of these people is named in an export: their name, or their whole
 * address when they have given none, so a file read by a machine tells
 * everyone apart.
 */
async function namesOf(ids: readonly string[]): Promise<Map<string, string>> {
	const accounts = await accountsOf(ids);
	return new Map([...accounts].map(([id, account]) => [id, nameOrEmail(account)]));
}

/**
 * The entries of `request` whose stored day is in its days, page by page in
 * the order of their ids (docs/decisions.md entries 26 and 39). Each page is one query of at most
 * `pageSize` entries after the last id of the one before.
 */
export async function* entryPages(
	request: Pick<ReportRequest, "scope" | "days" | "people" | "tag">,
	pageSize = ENTRY_PAGE_SIZE,
): AsyncGenerator<ReportEntry[]> {
	const { scope, people, tag } = request;
	const [projects, clients, tasks] = await Promise.all([
		scope.projects.select(),
		scope.clients.select(),
		scope.tasks.select(),
	]);
	const projectsById = new Map(projects.map((p) => [p.id, p]));
	const clientNames = new Map(clients.map((c) => [c.id, c.name]));
	const taskNames = new Map(tasks.map((t) => [t.id, t.name]));
	const names = new Map<string, string>();

	let after: string | undefined;
	for (;;) {
		const rows = await scope.timeEntries.select(
			(e) =>
				and(
					after === undefined ? undefined : gt(e.id, after),
					gte(e.spentOn, request.days.first),
					lte(e.spentOn, request.days.last),
					people.everyone ? undefined : amongPeople(e.userId, people.people),
					tag === undefined ? undefined : taggedWith(scope.organisationId, e.id, e.projectId, tag),
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
				day: row.spentOn,
				startedAt: row.startedAt.getTime(),
				endedAt: row.endedAt?.getTime() ?? null,
				taskId: row.taskId,
				task: row.taskId === null ? null : (taskNames.get(row.taskId) ?? null),
				billable: row.billable,
				overtime: row.overtime,
			};
		});
		const last = rows.at(-1);
		if (rows.length < pageSize || !last) return;
		after = last.id;
	}
}

/** Every row of the report, in the order of the entries' ids. */
export async function rowsOfReport(request: ReportRequest): Promise<Row[]> {
	const rows: Row[] = [];
	for await (const page of entryPages(request)) {
		for (const entry of page) {
			const row = rowOf(entry, request.days, request.now);
			if (row) rows.push(row);
		}
	}
	return rows;
}

/** One person's line in a report: the time they worked, the time expected of them, and their leave (TS-061). */
export interface PersonLine {
	id: string;
	name: string;
	/** Their address, shown under the name when they have given none. */
	address: string | null;
	/** Seconds of tracked time in the range. Leave is never in it. */
	worked: number;
	/** Of `worked`, the seconds of overtime (TS-095). */
	overtime: number;
	/** Minutes expected over the range: the working week, less public holidays and approved leave. */
	expectedMinutes: number;
	/** Minutes of approved leave in the range, and the half days they make. */
	leaveMinutes: number;
	leaveHalfDays: number;
	/** Requests for leave starting in the range that were made at short notice (TS-090). */
	shortNotice: number;
}

/**
 * Each person the report holds, with what they worked, what was expected of
 * them and their leave over its days. Worked time comes from `rows`, each its
 * whole minutes, so it adds up as the report's totals do; leave is read beside
 * it and never added to it.
 */
export async function peopleOfReport(
	request: ReportRequest,
	rows: readonly Row[],
): Promise<PersonLine[]> {
	const { people, choices, days, scope } = request;
	const listed = people.everyone ? choices : choices.filter((c) => people.people.includes(c.id));
	if (listed.length === 0) return [];
	const ids = listed.map((p) => p.id);
	const [context, shortNotice] = await Promise.all([
		leaveContext(scope, ids, days.first, days.last),
		shortNoticeCounts(scope, ids, days.first, days.last),
	]);
	const range = daysFrom(days.first, days.last);
	const worked = new Map<string, number>();
	const overtime = new Map<string, number>();
	for (const row of rows) {
		const { userId } = row.entry;
		worked.set(userId, (worked.get(userId) ?? 0) + row.minutes * 60);
		if (row.entry.overtime) overtime.set(userId, (overtime.get(userId) ?? 0) + row.minutes * 60);
	}
	return listed.map((person) => {
		const calendar = calendarOf(context, person.id);
		return {
			id: person.id,
			name: person.name,
			address: person.address,
			worked: worked.get(person.id) ?? 0,
			overtime: overtime.get(person.id) ?? 0,
			expectedMinutes: expectedMinutes(calendar, range),
			leaveMinutes: leaveMinutes(calendar, range),
			leaveHalfDays: leaveHalfDays(calendar, range),
			shortNotice: shortNotice.get(person.id) ?? 0,
		};
	});
}
