import { env } from "cloudflare:workers";
import { and, desc, eq, gte, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { data } from "react-router";

import {
	among,
	notAmong,
	type OrganisationScope,
	organisationScope,
	organisations,
	users,
} from "~/db";
import { maySeeRates } from "~/organisations/access";
import { type Membership, notFound } from "~/organisations/membership.server";
import { nameOrEmail } from "~/organisations/people";
import type { RateRow } from "~/rates/rates";
import {
	parseReportQuery,
	type RangeProblem,
	type ReportDays,
	type ReportQuery,
	rangeDays,
} from "~/reports/query";
import { dayOf } from "~/time/calendar";

import {
	type Contractor,
	type ContractorLine,
	type ContractorTime,
	contractorLines,
} from "./contractors";

/**
 * The Contractors report read from the database (TS-079). It is money, so it
 * is seen by owners, admins and Finance alone (`maySeeRates`); anybody else,
 * a manager included, gets the organisation's 404 (docs/security.md, "Rates
 * and money"). Every read of the organisation's rows goes through its scope.
 *
 * Who is a contractor: a member whose membership is marked so, and a person who
 * is no longer a member but tracked time in the range, if the last record of
 * their leaving (`membership.removed`) says they were one then. A person's
 * entries stay when their membership goes, so their time is still there.
 */

/** Throws the organisation's 404 unless the person sees money. The report's routes run it before anything else. */
export function requireSeesCost(membership: Membership): void {
	if (!maySeeRates(membership.role)) throw notFound();
}

/** A report as the page and its export show it. */
export interface ContractorReport {
	query: ReportQuery;
	days: ReportDays;
	lines: ContractorLine[];
	/** Whether anybody is a contractor now, or left as one with time in the range. */
	hasContractors: boolean;
	/** The organisation's currency, in which a cost of nothing is written. */
	currency: string;
}

/** A custom range that makes no report: the page shows its form again with `problem` under its field. */
export interface RefusedContractorReport {
	query: ReportQuery;
	problem: RangeProblem;
}

/**
 * Reads the report the address asks for, with the range of Reports
 * (`app/reports/query.ts`): an address the form did not write is answered 400,
 * and a custom range that makes no report is a `RefusedContractorReport`.
 */
export async function contractorReport(
	membership: Membership,
	url: URL,
	now: number,
): Promise<ContractorReport | RefusedContractorReport> {
	const parsed = parseReportQuery(url.searchParams);
	if (!parsed) throw data("Bad Request", { status: 400 });
	const { query, problem } = parsed;
	if (problem) return { query, problem };

	const { organisation } = membership;
	const scope = organisationScope(env.DB, organisation.id);
	const days = rangeDays(query, dayOf(now, organisation.timeZone), organisation.weekStartsOn);
	const [members, [held]] = await Promise.all([
		scope.memberships.select(),
		drizzle(env.DB)
			.select({ currency: organisations.currency })
			.from(organisations)
			.where(eq(organisations.id, organisation.id)),
	]);
	// The organisation was read for the membership on this request; gone since, it is the 404.
	if (!held) throw notFound();
	const memberIds = members.map(({ userId }) => userId);
	const contractorsNow = members.filter((m) => m.isContractor).map(({ userId }) => userId);

	const [time, rates] = await Promise.all([
		timeOn(scope, days, contractorsNow, memberIds, now),
		scope.rates.select((r) => eq(r.kind, "cost")),
	]);

	const stillMembers = new Set(memberIds);
	const departed = await leftAsContractors(scope, [
		...new Set(time.map(({ userId }) => userId).filter((userId) => !stillMembers.has(userId))),
	]);
	const left = new Set(departed);
	const contractors = await peopleOf([...contractorsNow, ...departed], left);
	const costRates: RateRow[] = rates.map((r) => ({
		kind: "cost",
		userId: r.userId,
		projectId: r.projectId,
		taskId: r.taskId,
		amountMinor: r.amountMinor,
		currency: r.currency,
		effectiveFrom: r.effectiveFrom,
	}));

	return {
		query,
		days,
		// The time of people who left as employees is read, and listed by nobody.
		lines: contractorLines(contractors, time, costRates, days),
		hasContractors: contractors.length > 0,
		currency: held.currency,
	};
}

/**
 * The time on `days` of `contractors`, and of everybody who is not one of
 * `members`, added up in SQL in one statement (TS-113, D7): one line for each
 * person, project, task, stored day and whether overtime, so that each line is
 * priced at one rate. An entry is read by the day stored with it, in its
 * person's zone (TS-111), through the index on `(organisation_id, spent_on)`.
 */
async function timeOn(
	scope: OrganisationScope,
	days: ReportDays,
	contractors: readonly string[],
	members: readonly string[],
	now: number,
): Promise<ContractorTime[]> {
	const lines = await scope.timeEntries.sums(
		(e) => ({
			userId: e.userId,
			projectId: e.projectId,
			taskId: e.taskId,
			day: e.spentOn,
			overtime: e.overtime,
		}),
		// Whole seconds from the second the start is in to the second the end is
		// in, a running entry's to now; the stored instants are whole milliseconds.
		(e) => ({
			seconds: sql<number>`max(0, coalesce(${e.endedAt}, cast(${now} as integer)) / 1000 - ${e.startedAt} / 1000)`,
		}),
		[["userId", "projectId", "taskId", "day", "overtime"]],
		(e) =>
			and(
				gte(e.spentOn, days.first),
				lte(e.spentOn, days.last),
				or(among(e.userId, contractors), notAmong(e.userId, members)),
			),
	);
	return lines.map((line) => ({
		userId: String(line.userId),
		projectId: String(line.projectId),
		taskId: line.taskId === null ? null : String(line.taskId),
		day: String(line.day),
		overtime: Boolean(line.overtime),
		seconds: line.seconds,
	}));
}

/**
 * Those of `people`, who are no longer members, who were contractors when they
 * left: the latest record of their leaving says so. A person whose leaving was
 * never recorded, or was recorded before the flag was (TS-079), is not one.
 */
async function leftAsContractors(
	scope: OrganisationScope,
	people: readonly string[],
): Promise<string[]> {
	if (people.length === 0) return [];
	const records = await scope.activityRecords.select(
		(r) => and(eq(r.action, "membership.removed"), among(r.ownerId, people)),
		{ orderBy: (r) => [desc(r.createdAt), desc(r.id)] },
	);
	const latest = new Map<string, boolean>();
	for (const { ownerId, summary } of records) {
		if (ownerId === null || latest.has(ownerId)) continue;
		latest.set(ownerId, summary.before?.isContractor === true);
	}
	return people.filter((id) => latest.get(id) === true);
}

/** Each of `ids` by name (their address when they have given none). */
async function peopleOf(ids: readonly string[], left: ReadonlySet<string>): Promise<Contractor[]> {
	const rows = await drizzle(env.DB)
		.select({ id: users.id, name: users.name, email: users.email })
		.from(users)
		.where(among(users.id, ids));
	return rows.map((row) => ({
		id: row.id,
		name: nameOrEmail(row),
		left: left.has(row.id),
	}));
}
