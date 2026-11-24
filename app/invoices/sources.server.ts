import { env } from "cloudflare:workers";
import { and, eq, gte, isNotNull, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { among, type OrganisationScope, users } from "~/db";
import { daysOver } from "~/leave/rules.server";
import { codedName } from "~/lib/codes";
import { shownName } from "~/organisations/people";
import { pricingOf } from "~/projects/money.server";
import { workPackageLabel } from "~/projects/work-packages";
import { hourlyPrice, MULTIPLIER_ONE, wholeMinutes } from "~/rates/price";
import { addDays, type Day, dayOf } from "~/time/calendar";
import { formatDay } from "~/time/format";

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
 * so they agree. Time on a day over its limit for its person is left out of
 * all of them until the day is corrected (TR-09): once invoiced, an entry can
 * no longer change.
 */

/** A project as the invoice form offers it, named by its code and name, code first (TS-115a). */
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
	/** A sentence for each person with time left out because its day is over its limit, by name. */
	leftOut: string[];
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
				among(l.projectId, fixedIds),
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
				name: codedName(p.code, p.name),
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
 * each entry on its stored day (decision 39), at the rate in force that day
 * (`hourlyPrice`), overtime at the project's multiplier. Time on a day over
 * its person's limit is left out, and `leftOut` says whose and which days.
 */
export async function uninvoicedTime(
	scope: OrganisationScope,
	organisation: { timeZone: string; currency: string },
	projectIds: readonly string[],
	days: { first: Day; last: Day } | null,
	now: number,
): Promise<{ entries: PreviewEntry[]; leftOut: string[] }> {
	const none = { entries: [], leftOut: [] };
	if (projectIds.length === 0) return none;
	const [found, pricing, tasks, projects, packages] = await Promise.all([
		scope.timeEntries.select((t) =>
			and(
				among(t.projectId, projectIds),
				eq(t.billable, true),
				isNotNull(t.endedAt),
				days ? gte(t.spentOn, days.first) : undefined,
				days ? lte(t.spentOn, days.last) : lt(t.startedAt, new Date(now)),
				sql`not ${scope.invoiceLineSources.exists((s) => eq(s.timeEntryId, t.id))}`,
			),
		),
		pricingOf(scope, organisation.currency),
		scope.tasks.select(),
		scope.projects.select((p) => among(p.id, projectIds)),
		scope.workPackages.select((w) => among(w.projectId, projectIds)),
	]);
	if (found.length === 0) return none;

	const over = await daysOverOf(scope, found, now);
	const entries = found.filter((entry) => !over.get(entry.userId)?.has(entry.spentOn));
	const people = await drizzle(env.DB)
		.select({ id: users.id, name: users.name, email: users.email })
		.from(users)
		.where(
			among(
				users.id,
				found.map((e) => e.userId),
			),
		);
	const personById = new Map(people.map((p) => [p.id, p]));
	const taskName = new Map(tasks.map((t) => [t.id, t.name]));
	// A line made from time names the project by its code and name (TS-115a).
	const projectName = new Map(projects.map((p) => [p.id, codedName(p.code, p.name)]));
	// And its work package by its code and name (TS-115b).
	const packageName = new Map(packages.map((wp) => [wp.id, workPackageLabel(wp)]));

	const items = entries.map((entry) => {
		const person = personById.get(entry.userId);
		const day = entry.spentOn;
		const minutes = wholeMinutes(
			((entry.endedAt?.getTime() ?? entry.startedAt.getTime()) - entry.startedAt.getTime()) / 1000,
		);
		const project = pricing.projects.get(entry.projectId);
		const price = project
			? hourlyPrice(project, pricing.rates, {
					userId: entry.userId,
					taskId: entry.taskId,
					day,
					overtime: entry.overtime,
				})
			: null;
		return {
			id: entry.id,
			projectId: entry.projectId,
			projectName: projectName.get(entry.projectId) ?? "",
			workPackageId: entry.workPackageId,
			workPackageName:
				entry.workPackageId === null ? null : (packageName.get(entry.workPackageId) ?? null),
			taskId: entry.taskId,
			taskName: entry.taskId ? (taskName.get(entry.taskId) ?? null) : null,
			userId: entry.userId,
			personName: person?.name ?? "",
			description: entry.description,
			day,
			minutes,
			overtime: entry.overtime,
			overtimeApart:
				entry.overtime && (project?.overtimeRateMilli ?? MULTIPLIER_ONE) !== MULTIPLIER_ONE,
			rateMinor: price ?? 0,
			minuteMinor: price === null ? 0 : minutes * price,
			priced: price !== null,
			approved: false,
			startedAt: entry.startedAt.getTime(),
		};
	});

	// Approved periods of these people that hold any of these days.
	const dayList = items.map((item) => item.day).sort();
	const approved = await scope.periods.select((p) =>
		and(
			among(p.userId, personById.keys()),
			eq(p.status, "approved"),
			lte(p.startsOn, dayList.at(-1) ?? ""),
			gte(p.endsOn, dayList[0] ?? ""),
		),
	);
	const leftOut = [...over].flatMap(([userId, days]) => {
		const left = found.filter((e) => e.userId === userId && days.has(e.spentOn));
		if (left.length === 0) return [];
		const person = personById.get(userId);
		const name = person?.name.trim().split(/\s+/u)[0] || shownName({ email: person?.email ?? "" });
		const said = leftOutSentence(name, left.length, [...new Set(left.map((e) => e.spentOn))]);
		return [{ name, said }];
	});
	return {
		entries: items
			.map(({ startedAt: _startedAt, ...item }) => ({
				...item,
				approved: approved.some(
					(p) => p.userId === item.userId && p.startsOn <= item.day && item.day <= p.endsOn,
				),
			}))
			.sort((a, b) =>
				a.day < b.day ? -1 : a.day > b.day ? 1 : a.projectName.localeCompare(b.projectName),
			),
		leftOut: leftOut.sort((a, b) => a.name.localeCompare(b.name, "en")).map(({ said }) => said),
	};
}

/**
 * The days over their limit (`daysOver`) of each person with time in
 * `entries`, looked at once a person, over the span of their entries' days.
 */
async function daysOverOf(
	scope: OrganisationScope,
	entries: readonly { userId: string; spentOn: Day }[],
	now: number,
): Promise<Map<string, Set<Day>>> {
	const spans = new Map<string, { first: Day; last: Day }>();
	for (const { userId, spentOn } of entries) {
		const span = spans.get(userId);
		if (!span) spans.set(userId, { first: spentOn, last: spentOn });
		else if (spentOn < span.first) span.first = spentOn;
		else if (spentOn > span.last) span.last = spentOn;
	}
	const found = await Promise.all(
		[...spans].map(async ([userId, { first, last }]) => {
			const over = await daysOver(scope, userId, first, last, now);
			return [userId, new Set(over.map((rule) => rule.day))] as const;
		}),
	);
	return new Map(found);
}

/**
 * What the preview says of `count` entries of `name`'s on `days` over their
 * limit: "1 entry of Grace's is on a day over its limit (Tue 10). It is left
 * out until the day is corrected."
 */
function leftOutSentence(name: string, count: number, days: readonly Day[]): string {
	const listed = [...days]
		.sort()
		.map((day) => formatDay(day, "short"))
		.join(", ");
	if (count === 1) {
		return `1 entry of ${name}'s is on a day over its limit (${listed}). It is left out until the day is corrected.`;
	}
	return days.length === 1
		? `${count} entries of ${name}'s are on a day over its limit (${listed}). They are left out until the day is corrected.`
		: `${count} entries of ${name}'s are on days over their limit (${listed}). They are left out until the days are corrected.`;
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
				among(x.projectId, projectIds),
				eq(x.billable, true),
				days ? gte(x.spentOn, days.first) : undefined,
				lte(x.spentOn, days ? days.last : today),
				sql`not ${scope.invoiceLineSources.exists((s) => eq(s.expenseId, x.id))}`,
			),
		),
		scope.expenseCategories.select(),
		scope.projects.select((p) => among(p.id, projectIds)),
	]);
	const categoryName = new Map(categories.map((c) => [c.id, c.name]));
	const projectName = new Map(projects.map((p) => [p.id, codedName(p.code, p.name)]));
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
	const [time, expenses] = includeTime
		? await Promise.all([
				uninvoicedTime(scope, organisation, hourly, request.days, now),
				uninvoicedExpenses(scope, all, request.days, today),
			])
		: [{ entries: [], leftOut: [] }, []];
	const { entries, leftOut } = time;
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
		leftOut,
	};
}

/** The last day of a range ending today: `days` days, both ends included. */
export function lastDays(today: Day, days: number): { first: Day; last: Day } {
	return { first: addDays(today, 1 - days), last: today };
}
