import { env } from "cloudflare:workers";
import { and, desc, eq, gte, inArray, lte, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { data } from "react-router";

import { type OrganisationScope, organisationScope, organisations, users } from "~/db";
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
	type ContractorEntry,
	type ContractorLine,
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

/** D1 takes at most 100 bound parameters a statement; a list of ids is read in chunks under that. */
const IDS_A_QUERY = 90;

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

/** `column` is one of `ids`, as one bound parameter however many they are. */
function among(column: SQLiteColumn, ids: readonly string[]): SQL {
	return sql`${column} in (select value from json_each(${JSON.stringify(ids)}))`;
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
	// Each entry's day is stored with it, in its person's zone (TS-111).
	const inDays = (e: { spentOn: SQLiteColumn }) =>
		and(gte(e.spentOn, days.first), lte(e.spentOn, days.last));

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

	const [theirs, othersEntries, rates] = await Promise.all([
		contractorsNow.length === 0
			? Promise.resolve([])
			: scope.timeEntries.select((e) => and(inDays(e), among(e.userId, contractorsNow))),
		// The entries of people who are no longer members.
		scope.timeEntries.select((e) =>
			and(
				inDays(e),
				sql`${e.userId} not in (select value from json_each(${JSON.stringify(memberIds)}))`,
			),
		),
		scope.rates.select((r) => eq(r.kind, "cost")),
	]);

	const departed = await leftAsContractors(scope, [
		...new Set(othersEntries.map(({ userId }) => userId)),
	]);
	const left = new Set(departed);
	const contractors = await peopleOf([...contractorsNow, ...departed], left);
	const entries: ContractorEntry[] = [
		...theirs,
		...othersEntries.filter((e) => left.has(e.userId)),
	].map((e) => ({
		userId: e.userId,
		projectId: e.projectId,
		taskId: e.taskId,
		startedAt: e.startedAt.getTime(),
		endedAt: e.endedAt?.getTime() ?? null,
		day: e.spentOn,
	}));
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
		lines: contractorLines(contractors, entries, costRates, days, now),
		hasContractors: contractors.length > 0,
		currency: held.currency,
	};
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
	const people: Contractor[] = [];
	const db = drizzle(env.DB);
	for (let at = 0; at < ids.length; at += IDS_A_QUERY) {
		const rows = await db
			.select({ id: users.id, name: users.name, email: users.email })
			.from(users)
			.where(inArray(users.id, ids.slice(at, at + IDS_A_QUERY)));
		for (const row of rows) {
			people.push({
				id: row.id,
				name: nameOrEmail(row),
				left: left.has(row.id),
			});
		}
	}
	return people;
}
