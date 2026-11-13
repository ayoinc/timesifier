import { env } from "cloudflare:workers";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { billableMinuteMinor } from "~/billing/billable";
import { type BudgetFigures, projectBudget } from "~/budgets/budget.server";
import { type OrganisationScope, users } from "~/db";
import { formatMoney, roundHalfUp } from "~/money/money";
import { maySeeRates, type TimeScope } from "~/organisations/access";
import type { Membership } from "~/organisations/membership.server";
import { nameOrEmail } from "~/organisations/people";
import { priceTime, wholeMinutes } from "~/rates/price";
import { type RateView, ratesForProject } from "~/rates/rates.server";
import { hoursAndMinutes } from "~/reports/format";
import { profitabilityReport } from "~/reports/profitability.server";
import { parseReportQuery, reportSearch } from "~/reports/query";
import { reportRequest } from "~/reports/reports.server";
import { percentLabel } from "~/reports/utilisation";
import { viewFrame } from "~/reports/view.server";
import { reportViewPath } from "~/reports/views";
import { DEFAULT_LOCALE } from "~/shell/locale";
import { tagOptions, tagsOfProject } from "~/tags/tags.server";
import { activeTasks, tasksOfProjects } from "~/tasks/tasks.server";
import { type Day, dayOf } from "~/time/calendar";

import { organisationMoney, pricedProject, pricingOf } from "./money.server";

/**
 * A project's own page (harvest-taste.md item 11; TS-066, TS-067, TS-069,
 * TS-085): what it has come to, its tasks, its people and its settings. The
 * hours are those of the people whose time the viewer may see
 * (`timeScopeOf`); amounts, rates and a budget in fees are read only for
 * those who see rates (`maySeeRates`), and are left out of the data
 * altogether for anybody else. A budget in hours is shown to managers as
 * well; a member is not shown the budget, only warned when it is over.
 */

/** The most entries without a rate the page lists. */
const MISSING_SHOWN = 50;

/** `column` is one of `people`, as one bound parameter however many they are. */
function amongPeople(column: Parameters<typeof eq>[0], people: readonly string[]) {
	return sql`${column} in (select value from json_each(${JSON.stringify(people)}))`;
}

/** How each of these people is named. */
export async function namesOf(ids: readonly string[]): Promise<Map<string, string>> {
	const names = new Map<string, string>();
	for (let at = 0; at < ids.length; at += 90) {
		const rows = await drizzle(env.DB)
			.select({ id: users.id, name: users.name, email: users.email })
			.from(users)
			.where(inArray(users.id, ids.slice(at, at + 90)));
		for (const row of rows) names.set(row.id, nameOrEmail(row));
	}
	return names;
}

/** A rate as the page shows it: in force today, and any from a later day. */
export interface RateFigures {
	current: { id: string; amount: string; amountMinor: number; from: Day } | null;
	later: { id: string; amount: string; from: Day }[];
}

/** The rate of each target, by key, from rows of one level. */
function ratesByKey(
	rows: readonly RateView[],
	keyOf: (row: RateView) => string,
	today: Day,
	locale: string,
): Map<string, RateFigures> {
	const byKey = new Map<string, RateFigures>();
	for (const row of rows) {
		const key = keyOf(row);
		const figures = byKey.get(key) ?? { current: null, later: [] };
		const amount = formatMoney(row.amountMinor, row.currency, locale);
		if (row.effectiveFrom > today) {
			figures.later.push({ id: row.id, amount, from: row.effectiveFrom });
		} else if (figures.current === null || figures.current.from < row.effectiveFrom) {
			figures.current = {
				id: row.id,
				amount,
				amountMinor: row.amountMinor,
				from: row.effectiveFrom,
			};
		}
		byKey.set(key, figures);
	}
	return byKey;
}

/** Everything the project's page shows the viewer, or null for no project of this organisation by that id. */
export async function projectPage(
	scope: OrganisationScope,
	membership: Membership,
	projectId: string,
	whose: TimeScope,
	now: number,
	locale: string,
) {
	const [project] = await scope.projects.select((p) => eq(p.id, projectId), { limit: 1 });
	if (!project) return null;
	const { organisation } = membership;
	const seesRates = maySeeRates(membership.role);
	const zone = organisation.timeZone;
	const today = dayOf(now, zone);
	const money = await organisationMoney(organisation.id);
	const [client] = project.clientId
		? await scope.clients.select((c) => eq(c.id, project.clientId ?? ""), { limit: 1 })
		: [];
	const priced = pricedProject(project, client?.currency ?? null, money.currency);

	const [entries, taskLists, allTasks, tagIds, tags, members, pricing, alerts] = await Promise.all([
		scope.timeEntries.select((e) =>
			and(
				eq(e.projectId, projectId),
				whose.everyone ? undefined : amongPeople(e.userId, whose.people),
			),
		),
		tasksOfProjects(scope, [projectId]),
		activeTasks(scope),
		tagsOfProject(scope, projectId),
		tagOptions(scope),
		scope.memberships.select(),
		pricingOf(scope, money.currency),
		scope.budgetAlerts.select((a) => eq(a.projectId, projectId), {
			orderBy: (a) => [desc(a.sentAt)],
			limit: 1,
		}),
	]);
	const tasks = taskLists.get(projectId) ?? [];
	const taskNames = new Map(allTasks.map((t) => [t.id, t.name]));
	for (const task of tasks) taskNames.set(task.taskId, task.name);

	let seconds = 0;
	let billableSeconds = 0;
	let amountExact = 0;
	const byTask = new Map<string, number>();
	const byPerson = new Map<string, number>();
	const missing: {
		id: string;
		userId: string;
		taskId: string | null;
		day: Day;
		seconds: number;
	}[] = [];
	for (const entry of entries) {
		const end = entry.endedAt?.getTime() ?? now;
		const length = Math.max(0, Math.floor((end - entry.startedAt.getTime()) / 1000));
		seconds += length;
		if (entry.billable && priced.billingType !== "non_billable") billableSeconds += length;
		const taskKey = entry.taskId ?? "";
		byTask.set(taskKey, (byTask.get(taskKey) ?? 0) + length);
		byPerson.set(entry.userId, (byPerson.get(entry.userId) ?? 0) + length);
		if (!seesRates) continue;
		const day = entry.spentOn;
		const amount = priceTime(priced, pricing.rates, {
			userId: entry.userId,
			taskId: entry.taskId,
			billable: entry.billable,
			day,
			minutes: wholeMinutes(length),
		});
		if (amount.kind === "missing-rate") {
			missing.push({
				id: entry.id,
				userId: entry.userId,
				taskId: entry.taskId,
				day,
				seconds: length,
			});
		}
		amountExact += billableMinuteMinor([amount]);
	}

	const budget = await projectBudget(scope, project, {
		zone,
		now,
		money,
		pricing,
	});
	// A budget is shown to those who oversee the work: in hours to a manager
	// too, in fees only to those who see rates. A member is only warned (TS-069).
	const seesBudget = seesRates || membership.managesTeams;
	const shownBudget: BudgetFigures | null =
		budget && seesBudget && (budget.hours || seesRates) ? budget : null;

	const memberIds = members.map((m) => m.userId);
	const names = await namesOf([...new Set([...memberIds, ...byPerson.keys()])]);
	const nameOf = (id: string) => names.get(id) ?? "Former member";
	const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "en");

	const rates = seesRates ? await ratesForProject(scope, projectId) : [];
	const onProject = (level: RateView["level"]) => rates.filter((r) => r.level === level);
	const projectRate = ratesByKey(onProject("project"), () => "", today, locale).get("") ?? null;
	const personOnProject = ratesByKey(
		onProject("project-person"),
		(r) => r.userId ?? "",
		today,
		locale,
	);
	const personDefault = ratesByKey(onProject("person"), (r) => r.userId ?? "", today, locale);
	const taskOnProject = ratesByKey(onProject("project-task"), (r) => r.taskId ?? "", today, locale);
	const taskDefault = ratesByKey(onProject("task"), (r) => r.taskId ?? "", today, locale);

	const money$ = (minor: number) => formatMoney(minor, priced.currency, locale);
	return {
		project: {
			id: project.id,
			name: project.name,
			archived: project.archivedAt !== null,
			client: client ? { id: client.id, name: client.name } : null,
			billingType: priced.billingType,
			rateMode: priced.rateMode,
			currency: priced.currency,
			/** The project's own currency, null when it takes its client's or the organisation's. */
			ownCurrency: project.currency,
			fee: seesRates && project.feeMinor !== null ? money$(project.feeMinor) : null,
			feeMinor: seesRates ? project.feeMinor : null,
			budgetKind: project.budgetKind,
			budgetAmount: shownBudget ? project.budgetAmount : null,
			budgetResetsMonthly: project.budgetResetsMonthly,
			budgetAlertPercent: project.budgetAlertPercent,
			budgetWarnMembers: project.budgetWarnMembers,
			budgetIncludesExpenses: project.budgetIncludesExpenses,
		},
		organisationCurrency: money.currency,
		clientCurrency: client?.currency ?? null,
		today,
		seesRates,
		hours: {
			total: hoursAndMinutes(seconds),
			billable: hoursAndMinutes(billableSeconds),
			nonBillable: hoursAndMinutes(seconds - billableSeconds),
		},
		amount: seesRates ? money$(roundHalfUp(amountExact, 60)) : null,
		missingRates: seesRates
			? {
					count: missing.length,
					entries: missing
						.sort((a, b) => (a.day < b.day ? 1 : -1))
						.slice(0, MISSING_SHOWN)
						.map((m) => ({
							id: m.id,
							day: m.day,
							person: nameOf(m.userId),
							task: m.taskId ? (taskNames.get(m.taskId) ?? "") : null,
							duration: hoursAndMinutes(m.seconds),
						})),
				}
			: null,
		budget: shownBudget && {
			kind: shownBudget.kind,
			hours: shownBudget.hours,
			period: shownBudget.period,
			whole: shownBudget.total && {
				amount: shownBudget.amount ?? 0,
				spent: shownBudget.total.spent,
				remaining: shownBudget.total.remaining,
				percent: shownBudget.total.percent,
				over: shownBudget.total.over,
			},
			lines: shownBudget.lines.map((line) => ({
				key: line.key,
				name:
					shownBudget.kind === "person_hours" ? nameOf(line.key) : (taskNames.get(line.key) ?? ""),
				amount: line.amount,
				spent: line.status.spent,
				remaining: line.status.remaining,
				percent: line.status.percent,
				over: line.status.over,
			})),
			currency: shownBudget.currency,
		},
		alertSentOn: alerts[0] ? dayOf(alerts[0].sentAt, zone) : null,
		tasks: tasks
			.map((task) => ({
				id: task.taskId,
				name: task.name,
				billable: task.billable,
				archived: task.archived,
				hours: hoursAndMinutes(byTask.get(task.taskId) ?? 0),
				rate: taskOnProject.get(task.taskId) ?? null,
				defaultRate: taskDefault.get(task.taskId) ?? null,
			}))
			.concat(
				byTask.has("")
					? [
							{
								id: "",
								name: "No task",
								billable: false,
								archived: false,
								hours: hoursAndMinutes(byTask.get("") ?? 0),
								rate: null,
								defaultRate: null,
							},
						]
					: [],
			),
		/** The organisation's active tasks not on this project, which may be added to it. */
		addableTasks: allTasks
			.filter((t) => !tasks.some((on) => on.taskId === t.id))
			.map((t) => ({ id: t.id, name: t.name })),
		people: [...byPerson]
			.map(([id, total]) => ({
				id,
				name: nameOf(id),
				hours: hoursAndMinutes(total),
				rate: personOnProject.get(id) ?? null,
				defaultRate: personDefault.get(id) ?? null,
			}))
			.sort(byName),
		/** Every member, by name: who a per-person budget or a person's rate may be for. */
		members: memberIds.map((id) => ({ id, name: nameOf(id) })).sort(byName),
		projectRate,
		tags,
		tagIds,
	};
}

/** The range the project's profit is shown for when the address names none. */
const PROFIT_RANGE = "this-month";

/**
 * The project's revenue, cost, profit and margin over a range (TS-071 on the
 * project's page), for those who see rates; null for anyone else. It is the
 * Profitability report's row for the project, read by the same function
 * (`profitabilityReport`) over the same range, written as that report writes
 * it, so the two agree. The range is the Reports one in the address
 * (`range`, `from`, `to`), this month when it names none or one that makes no
 * report; the steps beside it lead to the ranges before and after.
 */
export async function projectProfit(
	membership: Membership,
	projectId: string,
	url: URL,
	now: number,
) {
	if (!maySeeRates(membership.role)) return null;
	const asked = new URLSearchParams();
	for (const key of ["range", "from", "to"]) {
		const value = url.searchParams.get(key);
		if (value !== null) asked.set(key, value);
	}
	const parsed = asked.has("range") ? parseReportQuery(asked) : null;
	const search =
		parsed && parsed.problem === null ? asked : new URLSearchParams({ range: PROFIT_RANGE });
	const report = await reportRequest(membership, new URL(`?${search}`, url), now);
	// The address was read above, so the range always makes a report.
	if ("problem" in report) return null;
	const { lines, currency } = await profitabilityReport(report);
	const line = lines.find((l) => l.projectId === projectId) ?? null;
	const frame = viewFrame(report, { grouped: false });
	return {
		range: frame.range,
		steps: frame.steps,
		report: reportViewPath(
			membership.organisation.slug,
			"profitability",
			`?${reportSearch({ range: report.query.range, days: report.days, group: "project" })}`,
		),
		figures: line && {
			revenue:
				line.revenueMinor === null
					? null
					: formatMoney(line.revenueMinor, line.currency, DEFAULT_LOCALE),
			cost: formatMoney(line.costMinor, currency, DEFAULT_LOCALE),
			profit:
				line.profitMinor === null ? "—" : formatMoney(line.profitMinor, currency, DEFAULT_LOCALE),
			margin: percentLabel(line.margin),
			missingFeeOrDates: line.missingFeeOrDates,
			otherCurrency: line.currency !== currency ? line.currency : null,
			missingRate: line.missingRateSeconds > 0 ? hoursAndMinutes(line.missingRateSeconds) : null,
			missingCost: line.missingCostSeconds > 0 ? hoursAndMinutes(line.missingCostSeconds) : null,
		},
	};
}

/**
 * A project of the organisation with the currencies it may bill in: its own,
 * else its client's, else the organisation's. Null for no such project here.
 */
export async function projectCurrencies(scope: OrganisationScope, projectId: string) {
	const [project] = await scope.projects.select((p) => eq(p.id, projectId), { limit: 1 });
	if (!project) return null;
	const money = await organisationMoney(scope.organisationId);
	const [client] = project.clientId
		? await scope.clients.select((c) => eq(c.id, project.clientId ?? ""), { limit: 1 })
		: [];
	const clientCurrency = client?.currency ?? null;
	return {
		project,
		currency: project.currency ?? clientCurrency ?? money.currency,
		clientCurrency,
		organisationCurrency: money.currency,
	};
}
