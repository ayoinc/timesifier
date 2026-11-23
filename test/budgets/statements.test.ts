import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { projectBudgets } from "~/budgets/budget.server";
import { organisationMoney, pricingOf } from "~/projects/money.server";
import { trackChoices } from "~/tasks/track.server";
import { dayOf } from "~/time/calendar";

import { freshDatabase } from "../db/database";
import { type Company, membershipOf, NOW, seedCompany } from "../reports/company";

// The Timesheet warns of the projects over budget (TS-069), and a budget's
// spend is added up in SQL (TS-113, D5): the warned budgets of every project
// are worked out in a fixed number of statements, none of which reads the
// entries themselves, however many projects and entries there are.

let company: Company;

beforeAll(async () => {
	await freshDatabase();
	company = await seedCompany();
	const { scope, projects, tasks, people } = company;
	await scope.budgetLines.insert([
		{ projectId: projects.build, taskId: tasks.design, amount: 60_000 },
		{ projectId: projects.build, taskId: tasks.code, amount: 90_000 },
	]);
	await scope.budgetLines.insert([
		{ projectId: projects.site, userId: people.linus, amount: 2_000 },
		{ projectId: projects.site, userId: people.hedy, amount: 50 },
	]);
	const budgets = {
		site: { budgetKind: "person_hours", budgetAmount: null },
		build: { budgetKind: "task_fees", budgetAmount: null },
		fixed: { budgetKind: "total_fees", budgetAmount: 1_000_000, budgetIncludesExpenses: true },
		internal: { budgetKind: "total_hours", budgetAmount: 600, budgetResetsMonthly: true },
	} as const;
	for (const [key, budget] of Object.entries(budgets)) {
		await scope.projects.update({ ...budget, budgetWarnMembers: true }, (p) =>
			eq(p.id, projects[key as keyof typeof budgets]),
		);
	}
}, 60_000);

afterEach(() => {
	vi.restoreAllMocks();
});

/** The statements one Timesheet load makes, and the projects it warns of. */
async function timesheetLoad() {
	const prepare = vi.spyOn(env.DB, "prepare");
	const { overBudget } = await trackChoices(company.scope, membershipOf(company, "hedy"), [], NOW);
	const statements = prepare.mock.calls.map(([text]) => String(text));
	prepare.mockRestore();
	return { statements, overBudget };
}

/** Adds `count` warned projects of `kind` at £100 an hour, each with `entries` hours of Hedy's in October. */
async function moreProjects(kind: string, count: number, entries: number) {
	const { scope, people } = company;
	for (let n = 0; n < count; n++) {
		const name = `${kind} ${n}`;
		const [project] = await scope.projects.insert({
			name,
			nameKey: name,
			budgetKind: kind,
			budgetAmount: 60,
			budgetWarnMembers: true,
		});
		if (!project) throw new Error("seed failed");
		await scope.rates.insert({
			kind: "billable",
			projectId: project.id,
			amountMinor: 100_00,
			currency: "GBP",
			effectiveFrom: "2026-01-01",
		});
		for (let at = 0; at < entries; at++) {
			const started = Date.parse("2026-10-01T08:00:00Z") + at * 3_600_000;
			await scope.timeEntries.insert({
				userId: people.hedy,
				projectId: project.id,
				startedAt: new Date(started),
				endedAt: new Date(started + 3_600_000),
				spentOn: dayOf(started, "Europe/London"),
				billable: true,
			});
		}
	}
}

describe("the Timesheet's budget warning", () => {
	it("works out the warned budgets in a fixed number of statements, whatever the number of projects and entries", async () => {
		const before = await timesheetLoad();
		const { projects } = company;
		expect(new Set(before.overBudget)).toEqual(
			new Set([projects.site, projects.build, projects.internal]),
		);

		await moreProjects("total_hours", 6, 12);
		await moreProjects("total_fees", 6, 12);
		const after = await timesheetLoad();
		expect(after.overBudget).toHaveLength(before.overBudget.length + 12);
		expect(after.statements).toHaveLength(before.statements.length);
		// No statement reads all the entries: the budgets' one adds them up, and
		// the other reads the person's latest few for their recent projects.
		const ofEntries = after.statements.filter(
			(text) => /from "time_entries"/.test(text) && !/ limit \?$/.test(text),
		);
		expect(ofEntries).toHaveLength(1);
		expect(ofEntries[0]).toMatch(/sum\(/i);
	});

	it("works out the budgets of many projects in three statements: spend, lines and expenses", async () => {
		const { scope, organisationId } = company;
		const money = await organisationMoney(organisationId);
		const pricing = await pricingOf(scope, money.currency);
		const projects = await scope.projects.select();
		const prepare = vi.spyOn(env.DB, "prepare");
		const figures = await projectBudgets(scope, projects, {
			zone: "Europe/London",
			now: NOW,
			money,
			pricing,
		});
		expect(figures.size).toBeGreaterThanOrEqual(4);
		expect(prepare).toHaveBeenCalledTimes(3);
	});
});
