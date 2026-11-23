import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { projectBudgets } from "~/budgets/budget.server";
import { organisationMoney, pricingOf } from "~/projects/money.server";

import { freshDatabase } from "../db/database";
import { type Company, NOW, namesOf, seedCompany, stable } from "../reports/company";

// A budget's spend added up in SQL (TS-113, D5) is the spend the budget
// counted entry by entry: every kind, over its lifetime and over a month,
// billable time alone and non-billable time too, fees priced at the rate in
// force on each day, a missing rate counting 0, and expenses for a total-fees
// budget that counts them. The snapshot was written by the code before TS-113,
// which read every entry of each budgeted project. Ids are named by what they
// are (`stable`): they are random past their first 48 bits.

let company: Company;
let names: Map<string, string>;

beforeAll(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	await freshDatabase();
	company = await seedCompany();
	const { scope, projects, tasks, people } = company;
	await scope.budgetLines.insert([
		{ projectId: projects.build, taskId: tasks.design, amount: 600 },
		{ projectId: projects.build, taskId: tasks.code, amount: 900 },
	]);
	await scope.budgetLines.insert([
		{ projectId: projects.site, userId: people.linus, amount: 2_000 },
		{ projectId: projects.site, userId: people.mallory, amount: 300 },
		{ projectId: projects.site, userId: people.hedy, amount: 50 },
	]);
	names = await namesOf(company);
}, 60_000);

afterAll(() => {
	vi.useRealTimers();
});

type Kind = "total_hours" | "total_fees" | "task_hours" | "person_hours";

/** Every budgeted project's figures, with each project given `kind` (where it has the lines for it). */
async function spend(kinds: Record<keyof Company["projects"], Kind>, monthly: boolean) {
	const { scope, organisationId } = company;
	for (const [key, kind] of Object.entries(kinds)) {
		await scope.projects.update(
			{
				budgetKind: kind,
				budgetAmount: kind.startsWith("total") ? 12_345 : null,
				budgetResetsMonthly: monthly,
				budgetIncludesExpenses: kind === "total_fees",
				budgetWarnMembers: true,
			},
			(p) => eq(p.id, company.projects[key as keyof Company["projects"]]),
		);
	}
	const money = await organisationMoney(organisationId);
	const pricing = await pricingOf(scope, money.currency);
	const projects = await scope.projects.select();
	const figures = await projectBudgets(scope, projects, {
		zone: "Europe/London",
		now: Date.now(),
		money,
		pricing,
	});
	const byName = new Map(projects.map((p) => [p.id, p.name]));
	return Object.fromEntries([...figures].map(([id, f]) => [byName.get(id), f]));
}

describe("a budget's spend", () => {
	it.each([
		[false, true],
		[false, false],
		[true, true],
		[true, false],
	])("over a month %s, counting non-billable time %s, is what it was", async (monthly, counts) => {
		await env.DB.prepare("update organisations set budget_counts_non_billable = ? where id = ?")
			.bind(counts ? 1 : 0, company.organisationId)
			.run();
		const figures = {
			hours: await spend(
				{
					site: "person_hours",
					build: "task_hours",
					fixed: "total_hours",
					internal: "total_hours",
				},
				monthly,
			),
			fees: await spend(
				{ site: "total_fees", build: "total_fees", fixed: "total_fees", internal: "total_fees" },
				monthly,
			),
		};
		expect(stable(figures, names)).toMatchSnapshot();
	});
});
