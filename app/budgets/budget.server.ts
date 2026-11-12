import { env } from "cloudflare:workers";
import { and, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { sendEmail } from "~/auth/email.server";
import { compose } from "~/auth/email-frame";
import { billableMinuteMinor } from "~/billing/billable";
import { type OrganisationScope, users } from "~/db";
import { roundHalfUp } from "~/money/money";
import type { OrganisationMoney, Pricing } from "~/projects/money.server";
import { priceTime, wholeMinutes } from "~/rates/price";
import { addDays, dayOf, startOfDay } from "~/time/calendar";

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
	const kind = budgetKindOf(project.budgetKind);
	if (kind === "none") return null;
	const { zone, now, money, pricing } = context;
	const priced = pricing.projects.get(project.id);
	if (!priced) return null;
	const period = budgetPeriod({
		resetsMonthly: project.budgetResetsMonthly,
		today: dayOf(now, zone),
	});
	// From the period's first local midnight to the one after its last day.
	const from =
		period.startsOn === LIFETIME_START ? null : new Date(startOfDay(period.startsOn, zone));
	const to = period.endsOn === null ? null : new Date(startOfDay(addDays(period.endsOn, 1), zone));
	const [entries, lines] = await Promise.all([
		scope.timeEntries.select((e) =>
			and(
				eq(e.projectId, project.id),
				from === null ? undefined : gte(e.startedAt, from),
				to === null ? undefined : lt(e.startedAt, to),
			),
		),
		kind === "total_hours" || kind === "total_fees"
			? Promise.resolve([])
			: scope.budgetLines.select((l) => eq(l.projectId, project.id)),
	]);
	const hours = isHoursBudget(kind);
	const keyOf = (entry: { taskId: string | null; userId: string }) =>
		kind === "person_hours" ? entry.userId : (entry.taskId ?? "");

	// Seconds for hours, minute-minor units for fees, by line key ("" for the whole).
	const spent = new Map<string, number>();
	let whole = 0;
	for (const entry of entries) {
		const end = entry.endedAt?.getTime() ?? now;
		const seconds = Math.max(0, Math.floor((end - entry.startedAt.getTime()) / 1000));
		const billable = priced.billingType !== "non_billable" && entry.billable;
		let add: number;
		if (hours) {
			if (!countsTowardHours(billable, money.budgetCountsNonBillable)) continue;
			add = seconds;
		} else {
			add = billableMinuteMinor([
				priceTime(priced, pricing.rates, {
					userId: entry.userId,
					taskId: entry.taskId,
					billable: entry.billable,
					day: dayOf(entry.startedAt, zone),
					minutes: wholeMinutes(seconds),
				}),
			]);
		}
		whole += add;
		const key = keyOf(entry);
		spent.set(key, (spent.get(key) ?? 0) + add);
	}
	const settle = (raw: number) => (hours ? Math.floor(raw / 60) : roundHalfUp(raw, 60));

	if (kind === "total_hours" || kind === "total_fees") {
		let total = settle(whole);
		if (kind === "total_fees" && project.budgetIncludesExpenses) {
			total += await expensesSpent(scope, project.id, priced.currency, period);
		}
		const amount = project.budgetAmount ?? 0;
		return {
			kind,
			hours,
			currency: priced.currency,
			period,
			amount,
			total: budgetStatus({ amount, spent: total }),
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
		return { kind, hours, currency: priced.currency, period, amount: null, total: null, lines: [] };
	}
	// A line left blank does not count, so the whole is the sum of the lines.
	const amount = figures.reduce((sum, line) => sum + line.amount, 0);
	const rawOfLines = figures.reduce((sum, line) => sum + (spent.get(line.key) ?? 0), 0);
	return {
		kind,
		hours,
		currency: priced.currency,
		period,
		amount,
		total: budgetStatus({ amount, spent: settle(rawOfLines) }),
		lines: figures,
	};
}

/** The project's expenses in its currency over `period`, billable or not, in minor units. */
async function expensesSpent(
	scope: OrganisationScope,
	projectId: string,
	currency: string,
	period: BudgetPeriod,
): Promise<number> {
	const rows = await scope.expenses.select((x) =>
		and(
			eq(x.projectId, projectId),
			eq(x.currency, currency),
			gte(x.spentOn, period.startsOn),
			period.endsOn === null ? undefined : lte(x.spentOn, period.endsOn),
		),
	);
	return rows.reduce((sum, row) => sum + row.amountMinor, 0);
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
	const message = budgetAlertEmail({
		projectName: project.name,
		organisationName: place.organisationName,
		percent: figures.total.percent,
		threshold,
		link: place.link,
	});
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
			const places = await scope.teamMembers.select((t) => inArray(t.userId, people.slice(0, 90)));
			const teamIds = [...new Set(places.map((t) => t.teamId))];
			if (teamIds.length > 0) {
				const managers = await scope.teamMembers.select((t) =>
					and(inArray(t.teamId, teamIds.slice(0, 90)), eq(t.isManager, true)),
				);
				for (const manager of managers) ids.add(manager.userId);
			}
		}
	}
	if (ids.size === 0) return [];
	const rows = await drizzle(env.DB)
		.select({ email: users.email })
		.from(users)
		.where(inArray(users.id, [...ids].slice(0, 90)));
	return rows.map((row) => row.email).sort();
}

/** The message an alert sends. Its subject and heading hold nothing anybody typed. */
export function budgetAlertEmail(alert: {
	projectName: string;
	organisationName: string;
	percent: number | null;
	threshold: number;
	link: string;
}) {
	const used =
		alert.percent === null
			? "has spent past its budget of nothing"
			: `has used ${alert.percent}% of its budget`;
	return compose({
		subject: "A project has reached its budget alert on Timesifier",
		heading: "Budget alert",
		parts: [
			`The project “${alert.projectName}” in “${alert.organisationName}” ${used}, past the alert at ${alert.threshold}%.`,
			{ action: "Open the project", link: alert.link },
			"You are told once for each budget period. Tracking time to the project is not stopped.",
		],
		reason:
			"You got this email because you are an owner or admin of this organisation on Timesifier, or manage a team with someone in it who tracked time to this project.",
	});
}

/**
 * The budgets of many projects at once, by project id, for a list such as
 * Dashboards' "nearest their limit" (TS-086). A project with no budget is
 * left out.
 */
export async function projectBudgets(
	scope: OrganisationScope,
	projects: readonly BudgetedProject[],
	context: BudgetContext,
): Promise<Map<string, BudgetFigures>> {
	const figures = await Promise.all(projects.map((p) => projectBudget(scope, p, context)));
	const byProject = new Map<string, BudgetFigures>();
	projects.forEach((project, at) => {
		const each = figures[at];
		if (each) byProject.set(project.id, each);
	});
	return byProject;
}
