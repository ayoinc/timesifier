import { and, asc, desc, eq, gte, isNull, lte } from "drizzle-orm";

import { changes, recordStatement } from "~/activity/activity.server";
import { type OrganisationScope, uuidv7 } from "~/db";
import { organisationMoney, pricingOf } from "~/projects/money.server";
import type { RateRow } from "~/rates/rates";
import type { Day } from "~/time/calendar";

import {
	costRateFor,
	type ProfitLine,
	type ProfitProject,
	type ProfitTotals,
	profitability,
} from "./profitability";
import type { ReportDays } from "./query";
import type { Row } from "./report";
import { type ReportRequest, rowsOfReport } from "./reports.server";

/**
 * Profitability (TS-071) read from the database: the projects as pricing
 * reads them (`pricingOf`), their fees and dates, every rate, and the
 * expenses of the range; and the cost rates each person is given, which
 * owners, admins and Finance set. Who may read any of it is the page's
 * check: `maySeeRates`, never a manager.
 */

/** Every cost rate of the organisation, as `resolveRate` reads it. */
export async function costRatesOf(scope: OrganisationScope): Promise<RateRow[]> {
	const rows = await scope.rates.select((r) => eq(r.kind, "cost"));
	return rows.map((r) => ({
		kind: "cost",
		userId: r.userId,
		projectId: r.projectId,
		taskId: r.taskId,
		amountMinor: r.amountMinor,
		currency: r.currency,
		effectiveFrom: r.effectiveFrom,
	}));
}

/** The projects as profitability reads them, by id, with the billable rates. */
async function profitProjects(
	scope: OrganisationScope,
	currency: string,
): Promise<{ projects: Map<string, ProfitProject>; billableRates: RateRow[] }> {
	const [pricing, rows, clients] = await Promise.all([
		pricingOf(scope, currency),
		scope.projects.select(),
		scope.clients.select(),
	]);
	const clientNames = new Map(clients.map((c) => [c.id, c.name]));
	const projects = new Map<string, ProfitProject>();
	for (const row of rows) {
		const priced = pricing.projects.get(row.id);
		if (!priced) continue;
		projects.set(row.id, {
			...priced,
			name: row.name,
			client: row.clientId ? (clientNames.get(row.clientId) ?? null) : null,
			feeMinor: row.feeMinor,
			startsOn: row.startsOn,
			endsOn: row.endsOn,
		});
	}
	return { projects, billableRates: pricing.rates };
}

export interface ProfitabilityReport {
	currency: string;
	lines: ProfitLine[];
	totals: ProfitTotals;
	/** The people whose time in the range has no cost rate, by name, with the seconds of it. */
	missingCost: { id: string; name: string; seconds: number }[];
}

/**
 * The Profitability report of `request`'s range: every project's revenue,
 * cost and profit, and the totals in the organisation's currency. `pieces`
 * are the report's, read once by a page that shows more than this.
 */
export async function profitabilityReport(
	request: ReportRequest,
	pieces?: readonly Row[],
): Promise<ProfitabilityReport> {
	const { scope, days } = request;
	const { currency } = await organisationMoney(scope.organisationId);
	const [{ projects, billableRates }, costRates, expenses, read] = await Promise.all([
		profitProjects(scope, currency),
		costRatesOf(scope),
		expensesOf(scope, days, request.people),
		pieces ?? rowsOfReport(request),
	]);
	const { lines, totals } = profitability({
		projects,
		billableRates,
		costRates,
		currency,
		range: days,
		rows: read,
		expenses,
	});
	const missing = new Map<string, number>();
	for (const piece of read) {
		const { userId, projectId } = piece.entry;
		if (costRateFor(costRates, currency, { userId, projectId, day: piece.day }) === null) {
			missing.set(userId, (missing.get(userId) ?? 0) + piece.minutes * 60);
		}
	}
	const names = new Map(request.choices.map((p) => [p.id, p.name]));
	return {
		currency,
		lines,
		totals,
		missingCost: [...missing]
			.map(([id, seconds]) => ({ id, name: names.get(id) ?? "", seconds }))
			.sort((a, b) => a.name.localeCompare(b.name, "en")),
	};
}

/** The expenses spent in `days` by the people of the report. */
async function expensesOf(
	scope: OrganisationScope,
	days: ReportDays,
	people: ReportRequest["people"],
) {
	const rows = await scope.expenses.select((x) =>
		and(gte(x.spentOn, days.first), lte(x.spentOn, days.last)),
	);
	return rows
		.filter((x) => people.everyone || people.people.includes(x.userId))
		.map((x) => ({
			projectId: x.projectId,
			amountMinor: x.amountMinor,
			currency: x.currency,
			billable: x.billable,
		}));
}

/** One person's cost rates, latest first. */
export interface PersonCostRates {
	id: string;
	name: string;
	address: string | null;
	/** The rate in force today, or null for none. */
	current: { amountMinor: number; effectiveFrom: Day } | null;
	/** Every rate they have been given, the latest first. */
	rates: { id: string; amountMinor: number; effectiveFrom: Day }[];
}

/** Each person among `people`, with their cost rates in the organisation's currency. */
export async function personCostRates(
	scope: OrganisationScope,
	people: readonly { id: string; name: string; address: string | null }[],
	currency: string,
	today: Day,
): Promise<PersonCostRates[]> {
	const rows = await scope.rates.select(
		(r) => and(eq(r.kind, "cost"), eq(r.currency, currency), isNull(r.projectId), isNull(r.taskId)),
		{ orderBy: (r) => [desc(r.effectiveFrom), asc(r.id)] },
	);
	return people.map((person) => {
		const theirs = rows
			.filter((r) => r.userId === person.id)
			.map((r) => ({ id: r.id, amountMinor: r.amountMinor, effectiveFrom: r.effectiveFrom }));
		const current = theirs.find((r) => r.effectiveFrom <= today) ?? null;
		return {
			...person,
			current: current && {
				amountMinor: current.amountMinor,
				effectiveFrom: current.effectiveFrom,
			},
			rates: theirs,
		};
	});
}

/**
 * Gives `userId` a cost rate of `amountMinor` an hour in `currency` from the
 * local day `effectiveFrom`. A rate already given from that day is changed;
 * earlier and later rates stay, so work before the date keeps its cost.
 */
export async function setCostRate(
	scope: OrganisationScope,
	actor: string,
	rate: { userId: string; amountMinor: number; currency: string; effectiveFrom: Day },
): Promise<void> {
	const [held] = await scope.rates.select(
		(r) =>
			and(
				eq(r.kind, "cost"),
				eq(r.userId, rate.userId),
				eq(r.effectiveFrom, rate.effectiveFrom),
				isNull(r.projectId),
				isNull(r.taskId),
			),
		{ limit: 1 },
	);
	const fields = ["amountMinor", "currency", "effectiveFrom"] as const;
	if (held) {
		if (held.amountMinor === rate.amountMinor && held.currency === rate.currency) return;
		await scope.batch([
			scope.rates.statements.update(
				{ amountMinor: rate.amountMinor, currency: rate.currency },
				(r) => eq(r.id, held.id),
			),
			recordStatement(
				scope,
				actor,
				"rate.updated",
				// The organisation's, not the person's: a manager reads their people's records and never sees money.
				{ type: "rate", id: held.id },
				changes(held, rate, fields),
			),
		]);
		return;
	}
	const id = uuidv7();
	await scope.batch([
		scope.rates.statements.insert({
			id,
			kind: "cost",
			userId: rate.userId,
			amountMinor: rate.amountMinor,
			currency: rate.currency,
			effectiveFrom: rate.effectiveFrom,
		}),
		recordStatement(
			scope,
			actor,
			"rate.created",
			{ type: "rate", id },
			changes(null, { ...rate, kind: "cost" }, ["kind", "userId", ...fields]),
		),
	]);
}

/** Sets a project's first and last day; false when the organisation has no such project. */
export async function setProjectDates(
	scope: OrganisationScope,
	actor: string,
	projectId: string,
	dates: { startsOn: Day; endsOn: Day },
): Promise<boolean> {
	const [project] = await scope.projects.select((p) => eq(p.id, projectId), { limit: 1 });
	if (!project) return false;
	const summary = changes(project, dates, ["startsOn", "endsOn"]);
	if (!summary.before && !summary.after) return true;
	await scope.batch([
		scope.projects.statements.update(dates, (p) => eq(p.id, projectId)),
		recordStatement(scope, actor, "project.updated", { type: "project", id: projectId }, summary),
	]);
	return true;
}
