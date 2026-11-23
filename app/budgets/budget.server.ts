import { env } from "cloudflare:workers";
import { and, eq, gte, inArray, lte, or, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { sendEmail } from "~/auth/email.server";
import { compose, type PlatformLook } from "~/auth/email-frame";
import { billableMinuteMinor } from "~/billing/billable";
import { getPlatformBrand } from "~/brand/platform-brand.server";
import { among, latestAmong, type OrganisationScope, users } from "~/db";
import { roundHalfUp } from "~/money/money";
import type { OrganisationMoney, Pricing } from "~/projects/money.server";
import { type PricedProject, priceTime } from "~/rates/price";
import { dayOf } from "~/time/calendar";

import {
	BudgetKind,
	type BudgetPeriod,
	type BudgetStatus,
	budgetPeriod,
	budgetStatus,
	countsTowardHours,
	crossedThreshold,
	isHoursBudget,
	LIFETIME_START,
} from "./budget";

/**
 * Where a project's budget stands now (TS-069, B7), as the project page, the
 * Track time warning, the alerts and Dashboards (TS-086) read it. Spent is
 * counted over the budget's current period, in the organisation's zone: an
 * entry counts in the period of the local day it starts on, a running entry
 * up to now. An hours budget counts minutes, of billable time and, when the
 * organisation says so, non-billable time; a fees budget counts the billable
 * amount of the time (`priceTime`), and, for a total-fees budget that says
 * so, the project's expenses in its currency.
 */

/** A project row, as the budget reads it. */
export interface BudgetedProject {
	id: string;
	name: string;
	billingType: string;
	budgetKind: string;
	budgetAmount: number | null;
	budgetResetsMonthly: boolean;
	budgetAlertPercent: number | null;
	budgetWarnMembers: boolean;
	budgetIncludesExpenses: boolean;
}

/** One line of a per-task or per-person budget: whose or which task's, its amount and where it stands. */
export interface BudgetLineFigures {
	/** The task's id for a per-task budget, the person's for a per-person one. */
	key: string;
	amount: number;
	status: BudgetStatus;
}

/** A project's budget for its current period. Amounts are minutes for hours, minor units of `currency` for fees. */
export interface BudgetFigures {
	kind: Exclude<BudgetKind, "none">;
	hours: boolean;
	currency: string;
	period: BudgetPeriod;
	/** The whole budget: the project's amount, or the sum of its lines; null when a per-line budget has no line. */
	amount: number | null;
	total: BudgetStatus | null;
	lines: BudgetLineFigures[];
}

/** What a budget is counted with: the organisation's zone, today there, the clock, and its money. */
export interface BudgetContext {
	zone: string;
	now: number;
	money: OrganisationMoney;
	pricing: Pricing;
}

/** The budget kind as stored, or `none` for a value the Worker never writes. */
export function budgetKindOf(stored: string): BudgetKind {
	const parsed = BudgetKind.safeParse(stored);
	return parsed.success ? parsed.data : "none";
}

/** The budget of `project` for the period that holds today, or null for a project with none. */
export async function projectBudget(
	scope: OrganisationScope,
	project: BudgetedProject,
	context: BudgetContext,
): Promise<BudgetFigures | null> {
	return (await projectBudgets(scope, [project], context)).get(project.id) ?? null;
}

/** A project with a budget: its kind, how its time is priced, and the period it counts over. */
interface Counted {
	project: BudgetedProject;
	kind: Exclude<BudgetKind, "none">;
	priced: PricedProject;
	period: BudgetPeriod;
}

/**
 * The budgets of many projects at once, by project id, for a list such as
 * Dashboards' "nearest their limit" (TS-086) or the Track time warning. A
 * project with no budget is left out. However many projects and entries,
 * it reads in three statements (TS-113, D5): the time spent, added up in
 * groups; the budget lines; and the expenses of the budgets that count them.
 */
export async function projectBudgets(
	scope: OrganisationScope,
	projects: readonly BudgetedProject[],
	context: BudgetContext,
): Promise<Map<string, BudgetFigures>> {
	const today = dayOf(context.now, context.zone);
	const counted = projects.flatMap((project): Counted[] => {
		const kind = budgetKindOf(project.budgetKind);
		const priced = context.pricing.projects.get(project.id);
		if (kind === "none" || !priced) return [];
		const period = budgetPeriod({ resetsMonthly: project.budgetResetsMonthly, today });
		return [{ project, kind, priced, period }];
	});
	const byLine = counted.filter(({ kind }) => kind !== "total_hours" && kind !== "total_fees");
	const withExpenses = counted.filter(
		({ kind, project }) => kind === "total_fees" && project.budgetIncludesExpenses,
	);
	const [spent, lines, expenses] = await Promise.all([
		timeSpent(scope, counted, context),
		byLine.length === 0
			? []
			: scope.budgetLines.select((l) =>
					among(
						l.projectId,
						byLine.map(({ project }) => project.id),
					),
				),
		expensesSpent(scope, withExpenses),
	]);
	const linesOf = new Map<string, typeof lines>();
	for (const line of lines)
		linesOf.set(line.projectId, [...(linesOf.get(line.projectId) ?? []), line]);

	const byProject = new Map<string, BudgetFigures>();
	for (const each of counted) {
		const { id } = each.project;
		byProject.set(
			id,
			figuresOf(each, spent.get(id) ?? new Map(), linesOf.get(id) ?? [], expenses.get(id) ?? 0),
		);
	}
	return byProject;
}

/**
 * A budget's figures from what its time spent, by line key (see `timeSpent`),
 * its lines, and the expenses it counts in minor units.
 */
function figuresOf(
	{ project, kind, priced, period }: Counted,
	spent: ReadonlyMap<string, number>,
	lines: readonly { taskId: string | null; userId: string | null; amount: number }[],
	expenses: number,
): BudgetFigures {
	const hours = isHoursBudget(kind);
	const settle = (raw: number) => (hours ? Math.floor(raw / 60) : roundHalfUp(raw, 60));
	const { currency } = priced;

	if (kind === "total_hours" || kind === "total_fees") {
		let whole = 0;
		for (const raw of spent.values()) whole += raw;
		const amount = project.budgetAmount ?? 0;
		return {
			kind,
			hours,
			currency,
			period,
			amount,
			total: budgetStatus({ amount, spent: settle(whole) + expenses }),
			lines: [],
		};
	}

	const figures: BudgetLineFigures[] = lines.map((line) => {
		const key = (kind === "person_hours" ? line.userId : line.taskId) ?? "";
		return {
			key,
			amount: line.amount,
			status: budgetStatus({ amount: line.amount, spent: settle(spent.get(key) ?? 0) }),
		};
	});
	if (figures.length === 0) {
		return { kind, hours, currency, period, amount: null, total: null, lines: [] };
	}
	// A line left blank does not count, so the whole is the sum of the lines.
	const amount = figures.reduce((sum, line) => sum + line.amount, 0);
	const rawOfLines = figures.reduce((sum, line) => sum + (spent.get(line.key) ?? 0), 0);
	return {
		kind,
		hours,
		currency,
		period,
		amount,
		total: budgetStatus({ amount, spent: settle(rawOfLines) }),
		lines: figures,
	};
}

/**
 * The rows of the counted projects whose day is in their budget's period:
 * one condition for each period, so a few however many projects. The list
 * of every project comes first, so SQLite reads the rows of those projects
 * alone, by its index, rather than every row of the organisation.
 */
function inPeriods(projectId: SQLWrapper, day: SQLWrapper, counted: readonly Counted[]): SQL {
	const byPeriod = new Map<string, { period: BudgetPeriod; ids: string[] }>();
	for (const { project, period } of counted) {
		const key = `${period.startsOn} ${period.endsOn}`;
		const held = byPeriod.get(key) ?? { period, ids: [] };
		held.ids.push(project.id);
		byPeriod.set(key, held);
	}
	const conditions = [...byPeriod.values()].map(({ period: { startsOn, endsOn }, ids }) =>
		and(
			among(projectId, ids),
			startsOn === LIFETIME_START ? undefined : gte(day, startsOn),
			endsOn === null ? undefined : lte(day, endsOn),
		),
	);
	const every = among(
		projectId,
		counted.map(({ project }) => project.id),
	);
	return and(every, or(...conditions)) ?? every;
}

/**
 * What the time of each counted project has spent, by project and then by
 * line key: the person's id for a per-person budget, otherwise the task's
 * ("" for none). Hours budgets count seconds; fees budgets count minute-minor
 * units (`billableMinuteMinor`).
 *
 * One statement adds the entries up in groups, so the work grows with the
 * groups and not with the entries. Each entry counts as before: a running one
 * up to now, its seconds whole for hours and its minutes whole for fees, each
 * rounded down before it is added. A group is all of a project's entries of
 * one person, one task, billable or not, overtime or not, and for fees within
 * one span of days in which no rate starts. Pricing is minutes times the rate,
 * so a group priced once at the rate in force on its span's first day is the
 * sum of its entries priced one by one. Overtime is kept apart so that a
 * multiplier for it (TS-111f) is one factor on its groups.
 */
async function timeSpent(
	scope: OrganisationScope,
	counted: readonly Counted[],
	{ now, money, pricing }: BudgetContext,
): Promise<Map<string, Map<string, number>>> {
	const spent = new Map<string, Map<string, number>>();
	if (counted.length === 0) return spent;
	const idsOf = (keep: (kind: Counted["kind"]) => boolean) =>
		counted.filter(({ kind }) => keep(kind)).map(({ project }) => project.id);
	const fees = idsOf((kind) => !isHoursBudget(kind));
	const byPerson = idsOf((kind) => kind === "person_hours" || !isHoursBudget(kind));
	const byTask = idsOf((kind) => kind === "task_hours" || !isHoursBudget(kind));
	// The days a rate that could price these projects' time starts on.
	const feeProjects = new Set(fees);
	const rateStarts = pricing.rates
		.filter((rate) => rate.projectId === null || feeProjects.has(rate.projectId))
		.map((rate) => rate.effectiveFrom);

	const groups = await scope.timeEntries.sums(
		(e) => ({
			project: e.projectId,
			person: sql`case when ${among(e.projectId, byPerson)} then ${e.userId} end`,
			task: sql`case when ${among(e.projectId, byTask)} then ${e.taskId} end`,
			billable: e.billable,
			overtime: e.overtime,
			// The first day of the entry's span: the last day a rate starts on, on or before its day.
			from: sql`case when ${among(e.projectId, fees)} then ${latestAmong(e.spentOn, rateStarts)} end`,
		}),
		(e) => {
			const elapsed = sql`(coalesce(${e.endedAt}, cast(${now} as integer)) - ${e.startedAt})`;
			return {
				seconds: sql<number>`max(0, ${elapsed} / 1000)`,
				minutes: sql<number>`max(0, ${elapsed} / 60000)`,
			};
		},
		[["project", "person", "task", "billable", "overtime", "from"]],
		(e) => inPeriods(e.projectId, e.spentOn, counted),
	);

	const countedOf = new Map(counted.map((each) => [each.project.id, each]));
	for (const group of groups) {
		const each = countedOf.get(String(group.project));
		if (!each) continue;
		const userId = group.person === null ? "" : String(group.person);
		const taskId = group.task === null ? null : String(group.task);
		const billable = Number(group.billable) === 1;
		let add: number;
		if (isHoursBudget(each.kind)) {
			const counts = each.priced.billingType !== "non_billable" && billable;
			if (!countsTowardHours(counts, money.budgetCountsNonBillable)) continue;
			add = group.seconds;
		} else {
			// Before the first rate starts no rate is in force: the time adds nothing.
			if (group.from === null) continue;
			const day = String(group.from);
			add = billableMinuteMinor([
				priceTime(each.priced, pricing.rates, {
					userId,
					taskId,
					billable,
					overtime: Number(group.overtime) === 1,
					day,
					minutes: group.minutes,
				}),
			]);
		}
		const key = each.kind === "person_hours" ? userId : (taskId ?? "");
		const byKey = spent.get(each.project.id) ?? new Map<string, number>();
		byKey.set(key, (byKey.get(key) ?? 0) + add);
		spent.set(each.project.id, byKey);
	}
	return spent;
}

/**
 * The expenses of each counted project in its currency over its period,
 * billable or not, in minor units, by project id: one statement for all.
 */
async function expensesSpent(
	scope: OrganisationScope,
	counted: readonly Counted[],
): Promise<Map<string, number>> {
	const spent = new Map<string, number>();
	if (counted.length === 0) return spent;
	const totals = await scope.expenses.sums(
		(x) => ({ project: x.projectId, currency: x.currency }),
		(x) => ({ minor: sql<number>`${x.amountMinor}` }),
		[["project", "currency"]],
		(x) => inPeriods(x.projectId, x.spentOn, counted),
	);
	const currencyOf = new Map(counted.map(({ project, priced }) => [project.id, priced.currency]));
	for (const total of totals) {
		const id = String(total.project);
		if (total.currency === currencyOf.get(id)) spent.set(id, total.minor);
	}
	return spent;
}

/** Whether a budget's whole is over. */
export function isOver(figures: BudgetFigures | null): boolean {
	return figures?.total?.over ?? false;
}

/** Whether a failed insert broke the alert's unique index: the alert has gone out already. */
function isAlertClash(error: unknown): boolean {
	for (let at: unknown = error; at instanceof Error; at = at.cause) {
		if (/UNIQUE constraint failed: budget_alerts\./.test(at.message)) return true;
	}
	return false;
}

/** Where the alert's link goes, and the organisation's name for its words. */
export interface AlertPlace {
	organisationName: string;
	/** The project's page, on the host the change was made on. */
	link: string;
}

/**
 * Tells the people who look after `project` once its budget for the current
 * period reaches the project's alert percentage (B7). The `budget_alerts`
 * row is the record that it was told: its unique index lets one write in a
 * period through, so two changes crossing at once, or crossing again after
 * dropping back, send nothing more. Owners and admins are told of every
 * budget; for an hours budget, so are the managers of the teams of the
 * people who tracked time to the project. A fees budget is money, which a
 * manager never sees. Each is sent one email. Returns whether an alert went out.
 */
export async function alertIfCrossed(
	scope: OrganisationScope,
	project: BudgetedProject,
	figures: BudgetFigures | null,
	place: AlertPlace,
	now: number,
): Promise<boolean> {
	const threshold = project.budgetAlertPercent;
	if (!figures?.total || figures.amount === null || threshold === null || threshold <= 0) {
		return false;
	}
	const reached = crossedThreshold(
		{ amount: figures.amount, spent: 0 },
		{ amount: figures.amount, spent: figures.total.spent },
		threshold,
	);
	if (!reached) return false;
	try {
		await scope.budgetAlerts.insert({
			projectId: project.id,
			periodStartsOn: figures.period.startsOn,
			thresholdPercent: threshold,
			sentAt: new Date(now),
		});
	} catch (error) {
		if (isAlertClash(error)) return false;
		throw error;
	}
	const recipients = await alertRecipients(scope, project.id, figures.hours);
	const message = budgetAlertEmail(
		{
			projectName: project.name,
			organisationName: place.organisationName,
			percent: figures.total.percent,
			threshold,
			link: place.link,
		},
		await getPlatformBrand(env),
	);
	for (const to of recipients) await sendEmail({ to, ...message });
	return true;
}

/** The addresses an alert goes to: owners and admins, and for hours the managers of those who tracked time to it. */
async function alertRecipients(
	scope: OrganisationScope,
	projectId: string,
	hours: boolean,
): Promise<string[]> {
	const administrators = await scope.memberships.select((m) => inArray(m.role, ["owner", "admin"]));
	const ids = new Set(administrators.map((m) => m.userId));
	if (hours) {
		const tracked = await scope.timeEntries.sum(
			() => sql<number>`1`,
			(e) => e.userId,
			(e) => eq(e.projectId, projectId),
		);
		const people = tracked.map(({ key }) => key);
		if (people.length > 0) {
			const places = await scope.teamMembers.select((t) => among(t.userId, people));
			const teamIds = [...new Set(places.map((t) => t.teamId))];
			if (teamIds.length > 0) {
				const managers = await scope.teamMembers.select((t) =>
					and(among(t.teamId, teamIds), eq(t.isManager, true)),
				);
				for (const manager of managers) ids.add(manager.userId);
			}
		}
	}
	if (ids.size === 0) return [];
	const rows = await drizzle(env.DB)
		.select({ email: users.email })
		.from(users)
		.where(among(users.id, ids));
	return rows.map((row) => row.email).sort();
}

/** The message an alert sends. Its subject and heading hold nothing anybody typed. */
export function budgetAlertEmail(
	alert: {
		projectName: string;
		organisationName: string;
		percent: number | null;
		threshold: number;
		link: string;
	},
	platform: PlatformLook,
) {
	const used =
		alert.percent === null
			? "has spent past its budget of nothing"
			: `has used ${alert.percent}% of its budget`;
	return compose(
		{
			subject: "A project has reached its budget alert on Timesifier",
			heading: "Budget alert",
			parts: [
				`The project “${alert.projectName}” in “${alert.organisationName}” ${used}, past the alert at ${alert.threshold}%.`,
				{ action: "Open the project", link: alert.link },
				"You are told once for each budget period. Tracking time to the project is not stopped.",
			],
			reason:
				"You got this email because you are an owner or admin of this organisation on Timesifier, or manage a team with someone in it who tracked time to this project.",
		},
		platform,
	);
}
