import { env } from "cloudflare:workers";
import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { type OrganisationScope, users } from "~/db";
import { pricingOf } from "~/projects/money.server";
import { rateFor, wholeMinutes } from "~/rates/price";
import { addDays, bounds, type Day, dayOf } from "~/time/calendar";
import { zoneOf } from "~/time/zones";

import {
	type DraftLine,
	type ExpenseItem,
	expenseLines,
	fixedLine,
	type Grouping,
	type TimeItem,
	timeLines,
} from "./lines";

/**
 * What can be put on an invoice for a client (TS-073): the billable time and
 * expenses of its projects that are on no invoice yet, priced, and each
 * fixed-fee project's fee still to invoice. The preview, the draft it saves,
 * the Uninvoiced view and a recurring invoice of uninvoiced time all read it,
 * so they agree.
 */

/** A project as the invoice form offers it. */
export interface OfferedProject {
	id: string;
	name: string;
	clientId: string | null;
	currency: string;
	billingType: "hourly" | "fixed_fee" | "non_billable";
	/** A fixed-fee project's fee still to invoice: its fee less what non-void invoices hold of it. */
	feeLeftMinor: number | null;
}

/** A time entry as the preview shows it. */
export interface PreviewEntry extends TimeItem {
	/** Whether its day is in an approved period of its person (TS-046). Unapproved time is flagged, not hidden. */
	approved: boolean;
	/** Whether a rate prices it. Time without one is shown and left off the invoice. */
	priced: boolean;
}

/** What the preview holds for one request. */
export interface Sources {
	projects: OfferedProject[];
	entries: PreviewEntry[];
	expenses: (ExpenseItem & { currency: string })[];
	/** Each chosen fixed-fee project with the part of its fee being invoiced. */
	fixed: { project: OfferedProject; amountMinor: number }[];
	/** The one currency of everything chosen, or null when nothing is. */
	currency: string | null;
	/** Why it cannot be one invoice, or null. */
	problem: string | null;
	lines: DraftLine[];
}

/** What a person asked to invoice. */
export interface SourceRequest {
	clientId: string;
	/** The range, both days included, in the organisation's zone. Null takes everything up to now. */
	days: { first: Day; last: Day } | null;
	/** The chosen projects; empty takes every one of the client's. */
	projectIds: readonly string[];
	grouping: Grouping;
	/** A fixed-fee project's part of its fee to invoice, by project; a project missing takes what is left. */
	fixedMinor: ReadonlyMap<string, number>;
	/** Whether time and expenses are included, or only fixed fees. */
	includeTime?: boolean;
}

/** The organisation's projects billable to `clientId`, with the currency each bills in. */
export async function billableProjectsOf(
	scope: OrganisationScope,
	clientId: string | null,
	organisationCurrency: string,
): Promise<OfferedProject[]> {
	const pricing = await pricingOf(scope, organisationCurrency);
	const rows = await scope.projects.select((p) =>
		and(
			clientId === null ? isNotNull(p.clientId) : eq(p.clientId, clientId),
			isNull(p.archivedAt),
			ne(p.billingType, "non_billable"),
		),
	);
	const fixedIds = rows.filter((p) => p.billingType === "fixed_fee").map((p) => p.id);
	const invoicedFees = new Map<string, number>();
	if (fixedIds.length > 0) {
		const lines = await scope.invoiceLines.select((l) =>
			and(
				eq(l.kind, "fixed"),
				inArray(l.projectId, fixedIds),
				scope.invoices.exists((i) => and(eq(i.id, l.invoiceId), ne(i.status, "void"))),
			),
		);
		for (const line of lines) {
			if (line.projectId === null) continue;
			invoicedFees.set(line.projectId, (invoicedFees.get(line.projectId) ?? 0) + line.amountMinor);
		}
	}
	return rows
		.map((p) => {
			const priced = pricing.projects.get(p.id);
			const billingType = priced?.billingType ?? "hourly";
			return {
				id: p.id,
				name: p.name,
				clientId: p.clientId,
				currency: priced?.currency ?? organisationCurrency,
				billingType,
				feeLeftMinor:
					billingType === "fixed_fee"
						? Math.max(0, (p.feeMinor ?? 0) - (invoicedFees.get(p.id) ?? 0))
						: null,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The billable, uninvoiced, finished time of `projectIds` in `days`, priced:
 * each entry on the local day it starts in its person's zone, at the rate in
 * force that day (`rateFor`).
 */
export async function uninvoicedTime(
	scope: OrganisationScope,
	organisation: { timeZone: string; currency: string },
	projectIds: readonly string[],
	days: { first: Day; last: Day } | null,
	now: number,
): Promise<PreviewEntry[]> {
	if (projectIds.length === 0) return [];
	const range = days ? bounds(days.first, days.last, organisation.timeZone) : null;
	const [entries, pricing, tasks, projects] = await Promise.all([
		scope.timeEntries.select((t) =>
			and(
				inArray(t.projectId, [...projectIds]),
				eq(t.billable, true),
				isNotNull(t.endedAt),
				range ? gte(t.startedAt, new Date(range.from)) : undefined,
				lt(t.startedAt, new Date(range ? range.to : now)),
				sql`not ${scope.invoiceLineSources.exists((s) => eq(s.timeEntryId, t.id))}`,
			),
		),
		pricingOf(scope, organisation.currency),
		scope.tasks.select(),
		scope.projects.select((p) => inArray(p.id, [...projectIds])),
	]);
	if (entries.length === 0) return [];

	const people = await drizzle(env.DB)
		.select({ id: users.id, name: users.name, timeZone: users.timeZone })
		.from(users)
		.where(inArray(users.id, [...new Set(entries.map((e) => e.userId))]));
	const personById = new Map(people.map((p) => [p.id, p]));
	const taskName = new Map(tasks.map((t) => [t.id, t.name]));
	const projectName = new Map(projects.map((p) => [p.id, p.name]));

	const items = entries.map((entry) => {
		const person = personById.get(entry.userId);
		const zone = zoneOf({ timeZone: person?.timeZone ?? null }, organisation);
		const day = dayOf(entry.startedAt, zone);
		const minutes = wholeMinutes(
			((entry.endedAt?.getTime() ?? entry.startedAt.getTime()) - entry.startedAt.getTime()) / 1000,
		);
		const project = pricing.projects.get(entry.projectId);
		const rate = project
			? rateFor(project, pricing.rates, { userId: entry.userId, taskId: entry.taskId, day })
			: null;
		return {
			id: entry.id,
			projectId: entry.projectId,
			projectName: projectName.get(entry.projectId) ?? "",
			taskId: entry.taskId,
			taskName: entry.taskId ? (taskName.get(entry.taskId) ?? null) : null,
			userId: entry.userId,
			personName: person?.name ?? "",
			description: entry.description,
			day,
			minutes,
			rateMinor: rate?.amountMinor ?? 0,
			minuteMinor: rate ? minutes * rate.amountMinor : 0,
			priced: rate !== null,
			approved: false,
			startedAt: entry.startedAt.getTime(),
		};
	});

	// Approved periods of these people that hold any of these days.
	const dayList = items.map((item) => item.day).sort();
	const approved = await scope.periods.select((p) =>
		and(
			inArray(p.userId, [...personById.keys()]),
			eq(p.status, "approved"),
			lte(p.startsOn, dayList.at(-1) ?? ""),
			gte(p.endsOn, dayList[0] ?? ""),
		),
	);
	return items
		.map(({ startedAt: _startedAt, ...item }) => ({
			...item,
			approved: approved.some(
				(p) => p.userId === item.userId && p.startsOn <= item.day && item.day <= p.endsOn,
			),
		}))
		.sort((a, b) =>
			a.day < b.day ? -1 : a.day > b.day ? 1 : a.projectName.localeCompare(b.projectName),
		);
}

/** The billable, uninvoiced expenses of `projectIds` spent in `days`. */
export async function uninvoicedExpenses(
	scope: OrganisationScope,
	projectIds: readonly string[],
	days: { first: Day; last: Day } | null,
	today: Day,
): Promise<(ExpenseItem & { currency: string })[]> {
	if (projectIds.length === 0) return [];
	const [rows, categories, projects] = await Promise.all([
		scope.expenses.select((x) =>
			and(
				inArray(x.projectId, [...projectIds]),
				eq(x.billable, true),
				days ? gte(x.spentOn, days.first) : undefined,
				lte(x.spentOn, days ? days.last : today),
				sql`not ${scope.invoiceLineSources.exists((s) => eq(s.expenseId, x.id))}`,
			),
		),
		scope.expenseCategories.select(),
		scope.projects.select((p) => inArray(p.id, [...projectIds])),
	]);
	const categoryName = new Map(categories.map((c) => [c.id, c.name]));
	const projectName = new Map(projects.map((p) => [p.id, p.name]));
	return rows
		.map((x) => ({
			id: x.id,
			projectId: x.projectId,
			projectName: projectName.get(x.projectId) ?? "",
			categoryName: categoryName.get(x.categoryId) ?? "",
			notes: x.notes,
			spentOn: x.spentOn,
			amountMinor: x.amountMinor,
			quantityMilli: x.quantityMilli,
			unitPriceMinor: x.unitPriceMinor,
			currency: x.currency,
		}))
		.sort((a, b) => (a.spentOn < b.spentOn ? -1 : a.spentOn > b.spentOn ? 1 : 0));
}

/** The sentence for a request whose projects bill in more than one currency. */
export function mixedCurrencies(currencies: readonly string[]): string {
	return `These bill in ${currencies.join(" and ")}. An invoice has one currency: choose projects that bill in one.`;
}

/**
 * Everything the request would put on an invoice, and the lines it makes.
 * Time without a rate is shown and left off. Projects, time or expenses in
 * more than one currency are refused: an invoice has one.
 */
export async function sourcesFor(
	scope: OrganisationScope,
	organisation: { timeZone: string; currency: string },
	request: SourceRequest,
	now: number,
): Promise<Sources> {
	const projects = await billableProjectsOf(scope, request.clientId, organisation.currency);
	const chosen = projects.filter(
		(p) => request.projectIds.length === 0 || request.projectIds.includes(p.id),
	);
	const today = dayOf(now, organisation.timeZone);
	const includeTime = request.includeTime ?? true;
	const hourly = chosen.filter((p) => p.billingType === "hourly").map((p) => p.id);
	const all = chosen.map((p) => p.id);
	const [entries, expenses] = includeTime
		? await Promise.all([
				uninvoicedTime(scope, organisation, hourly, request.days, now),
				uninvoicedExpenses(scope, all, request.days, today),
			])
		: [[], []];
	const fixed = chosen
		.filter((p) => p.billingType === "fixed_fee" && (p.feeLeftMinor ?? 0) > 0)
		.map((project) => ({
			project,
			amountMinor: Math.min(
				request.fixedMinor.get(project.id) ?? project.feeLeftMinor ?? 0,
				project.feeLeftMinor ?? 0,
			),
		}))
		.filter(({ amountMinor }) => amountMinor > 0);

	const priced = entries.filter((e) => e.priced && e.minuteMinor > 0);
	const projectCurrency = new Map(projects.map((p) => [p.id, p.currency]));
	const currencies = [
		...new Set([
			...priced.map((e) => projectCurrency.get(e.projectId) ?? organisation.currency),
			...expenses.map((x) => x.currency),
			...expenses.map((x) => projectCurrency.get(x.projectId) ?? organisation.currency),
			...fixed.map(({ project }) => project.currency),
		]),
	].sort();
	const lines = [
		...timeLines(priced, request.grouping),
		...expenseLines(expenses),
		...fixed.map(({ project, amountMinor }) => fixedLine(project, amountMinor)),
	];
	return {
		projects,
		entries,
		expenses,
		fixed,
		currency: currencies.length === 1 ? (currencies[0] ?? null) : null,
		problem: currencies.length > 1 ? mixedCurrencies(currencies) : null,
		lines,
	};
}

/** The last day of a range ending today: `days` days, both ends included. */
export function lastDays(today: Day, days: number): { first: Day; last: Day } {
	return { first: addDays(today, 1 - days), last: today };
}
