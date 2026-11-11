import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { organisationScope } from "~/db";
import { memberships, organisations, users } from "~/db/schema";
import { freshDatabase } from "./database";

// The tables of the business features (TS-064). They need migration 0008. A
// representative set is tested here: a project's task, an expense, what an
// invoice line bills, and a rate. Each row belongs to one organisation, a
// reference from one row to another stays inside that organisation, and the
// rules the database holds by itself hold.

let database: D1Database;

beforeEach(async () => {
	database = await freshDatabase();
});

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-11T09:00:00Z");

/**
 * Two organisations, Acme and Globex, with Ada a member of Acme and Bola of
 * Globex. Each has a client, a project, a task on that project, an expense
 * category, an expense, an entry, and a draft invoice with one line billing
 * the entry.
 */
async function seed() {
	const db = drizzle(database);
	const [acme, globex] = await db
		.insert(organisations)
		.values([
			{ name: "Acme", slug: "acme" },
			{ name: "Globex", slug: "globex" },
		])
		.returning();
	const [ada, bola] = await db
		.insert(users)
		.values([
			{ name: "Ada", email: "ada@example.com" },
			{ name: "Bola", email: "bola@example.com" },
		])
		.returning();
	if (!acme || !globex || !ada || !bola) throw new Error("seed failed");
	await db.insert(memberships).values([
		{ organisationId: acme.id, userId: ada.id, role: "owner" },
		{ organisationId: globex.id, userId: bola.id, role: "owner" },
	]);

	async function contents(organisationId: string, person: string, name: string) {
		const scope = organisationScope(database, organisationId);
		const key = name.toLowerCase();
		const [client] = await scope.clients.insert({ name, nameKey: key });
		const [project] = await scope.projects.insert({
			name: `${name} site`,
			nameKey: `${key} site`,
			clientId: client?.id ?? null,
		});
		const [task] = await scope.tasks.insert({ name: "Design", nameKey: "design" });
		const [category] = await scope.expenseCategories.insert({ name: "Travel", nameKey: "travel" });
		if (!client || !project || !task || !category) throw new Error("seed failed");
		const [projectTask] = await scope.projectTasks.insert({
			projectId: project.id,
			taskId: task.id,
			billable: true,
		});
		const [entry] = await scope.timeEntries.insert({
			userId: person,
			projectId: project.id,
			taskId: task.id,
			billable: true,
			description: null,
			startedAt: new Date(T0),
			endedAt: new Date(T0 + HOUR),
		});
		const [expense] = await scope.expenses.insert({
			userId: person,
			projectId: project.id,
			categoryId: category.id,
			spentOn: "2026-11-11",
			amountMinor: 1250,
			currency: "GBP",
			billable: true,
		});
		const [invoice] = await scope.invoices.insert({
			number: "1",
			clientId: client.id,
			currency: "GBP",
			issuedOn: "2026-11-30",
			dueOn: "2026-12-30",
		});
		if (!projectTask || !entry || !expense || !invoice) throw new Error("seed failed");
		const [line] = await scope.invoiceLines.insert({
			invoiceId: invoice.id,
			position: 0,
			kind: "time",
			description: "Design",
			projectId: project.id,
			quantityMilli: 1000,
			unitPriceMinor: 9000,
			amountMinor: 9000,
		});
		if (!line) throw new Error("seed failed");
		await scope.invoiceLineSources.insert({ lineId: line.id, timeEntryId: entry.id });
		await scope.rates.insert({
			kind: "billable",
			projectId: project.id,
			amountMinor: 9000,
			currency: "GBP",
			effectiveFrom: "2026-01-01",
		});
		return { client, project, task, category, projectTask, entry, expense, invoice, line };
	}

	return {
		acme: { ...acme, ...(await contents(acme.id, ada.id, "Apex")) },
		globex: { ...globex, ...(await contents(globex.id, bola.id, "Gamma")) },
		ada,
		bola,
	};
}

/** The message of the error a promise rejects with, or null when it resolves. */
async function refusal(promise: Promise<unknown>): Promise<string | null> {
	try {
		await promise;
		return null;
	} catch (error) {
		// Drizzle wraps D1's error, which names the constraint, as its cause.
		if (error instanceof Error && error.cause instanceof Error) return error.cause.message;
		return String(error);
	}
}

describe("each table of the business features", () => {
	it.each([
		"tasks",
		"projectTasks",
		"expenseCategories",
		"expenses",
		"invoices",
		"invoiceLines",
		"invoiceLineSources",
		"rates",
	] as const)("%s: the scope of one organisation holds none of another's rows", async (name) => {
		const { acme, globex } = await seed();

		const ofAcme = await organisationScope(database, acme.id)[name].select();
		const ofGlobex = await organisationScope(database, globex.id)[name].select();

		expect(ofAcme.length).toBeGreaterThan(0);
		expect(ofAcme.every((row) => row.organisationId === acme.id)).toBe(true);
		expect(ofGlobex.every((row) => row.organisationId === globex.id)).toBe(true);
		const ids = new Set(ofAcme.map((row) => row.id));
		expect(ofGlobex.some((row) => ids.has(row.id))).toBe(false);
	});
});

describe("a reference from one row to another", () => {
	it("cannot put another organisation's task on a project", async () => {
		const { acme, globex } = await seed();
		const scope = organisationScope(database, acme.id);

		expect(
			await refusal(
				scope.projectTasks.insert({
					projectId: acme.project.id,
					taskId: globex.task.id,
					billable: true,
				}),
			),
		).toContain("FOREIGN KEY");
		expect(
			await refusal(
				scope.projectTasks.insert({
					projectId: globex.project.id,
					taskId: acme.task.id,
					billable: true,
				}),
			),
		).toContain("FOREIGN KEY");
	});

	it("cannot record an expense on another organisation's project or category", async () => {
		const { acme, globex, ada } = await seed();
		const expense = (projectId: string, categoryId: string) =>
			organisationScope(database, acme.id).expenses.insert({
				userId: ada.id,
				projectId,
				categoryId,
				spentOn: "2026-11-12",
				amountMinor: 500,
				currency: "GBP",
			});

		expect(await refusal(expense(globex.project.id, acme.category.id))).toContain("FOREIGN KEY");
		expect(await refusal(expense(acme.project.id, globex.category.id))).toContain("FOREIGN KEY");
	});

	it("cannot bill another organisation's entry or expense on an invoice line", async () => {
		const { acme, globex } = await seed();
		const scope = organisationScope(database, acme.id);

		expect(
			await refusal(
				scope.invoiceLineSources.insert({ lineId: acme.line.id, timeEntryId: globex.entry.id }),
			),
		).toContain("FOREIGN KEY");
		expect(
			await refusal(
				scope.invoiceLineSources.insert({ lineId: acme.line.id, expenseId: globex.expense.id }),
			),
		).toContain("FOREIGN KEY");
		expect(
			await refusal(
				scope.invoiceLineSources.insert({ lineId: globex.line.id, expenseId: acme.expense.id }),
			),
		).toContain("FOREIGN KEY");
	});

	it("cannot give a rate to another organisation's project or task", async () => {
		const { acme, globex } = await seed();
		const rate = (ids: { projectId?: string; taskId?: string }) =>
			organisationScope(database, acme.id).rates.insert({
				kind: "billable",
				...ids,
				amountMinor: 8000,
				currency: "GBP",
				effectiveFrom: "2026-06-01",
			});

		expect(await refusal(rate({ projectId: globex.project.id }))).toContain("FOREIGN KEY");
		expect(await refusal(rate({ taskId: globex.task.id }))).toContain("FOREIGN KEY");
	});
});

describe("the rules the database holds", () => {
	it("an invoice number is unique in its organisation, and another organisation has its own", async () => {
		const { acme, globex } = await seed();
		const invoice = (organisationId: string, clientId: string, number: string) =>
			organisationScope(database, organisationId).invoices.insert({
				number,
				clientId,
				currency: "GBP",
				issuedOn: "2026-12-01",
				dueOn: "2026-12-31",
			});

		// Both organisations already have invoice "1".
		expect(await refusal(invoice(acme.id, acme.client.id, "1"))).toContain("UNIQUE");
		expect(await refusal(invoice(acme.id, acme.client.id, "2"))).toBeNull();
		expect(await refusal(invoice(globex.id, globex.client.id, "2"))).toBeNull();
	});

	it("an entry or an expense is on one invoice line at most", async () => {
		const { acme } = await seed();
		const scope = organisationScope(database, acme.id);
		const [second] = await scope.invoiceLines.insert({
			invoiceId: acme.invoice.id,
			position: 1,
			kind: "manual",
			description: "Again",
			quantityMilli: 1000,
			unitPriceMinor: 0,
			amountMinor: 0,
		});
		if (!second) throw new Error("no line");

		expect(
			await refusal(
				scope.invoiceLineSources.insert({ lineId: second.id, timeEntryId: acme.entry.id }),
			),
		).toContain("UNIQUE");
		expect(
			await refusal(
				scope.invoiceLineSources.insert({ lineId: second.id, expenseId: acme.expense.id }),
			),
		).toBeNull();
		expect(
			await refusal(
				scope.invoiceLineSources.insert({ lineId: acme.line.id, expenseId: acme.expense.id }),
			),
		).toContain("UNIQUE");
	});

	it("a source names exactly one of an entry and an expense", async () => {
		const { acme } = await seed();
		const scope = organisationScope(database, acme.id);
		await scope.invoiceLineSources.delete((s) => eq(s.lineId, acme.line.id));

		expect(await refusal(scope.invoiceLineSources.insert({ lineId: acme.line.id }))).toContain(
			"CHECK",
		);
		expect(
			await refusal(
				scope.invoiceLineSources.insert({
					lineId: acme.line.id,
					timeEntryId: acme.entry.id,
					expenseId: acme.expense.id,
				}),
			),
		).toContain("CHECK");
	});

	it("deleting an invoice line releases what it billed", async () => {
		const { acme } = await seed();
		const scope = organisationScope(database, acme.id);

		await scope.invoiceLines.delete((l) => eq(l.id, acme.line.id));

		expect(await scope.invoiceLineSources.select()).toEqual([]);
		// The entry stays, and can be billed again.
		expect(await scope.timeEntries.select((e) => eq(e.id, acme.entry.id))).toHaveLength(1);
		const [line] = await scope.invoiceLines.insert({
			invoiceId: acme.invoice.id,
			position: 0,
			kind: "time",
			description: "Design",
			quantityMilli: 1000,
			unitPriceMinor: 9000,
			amountMinor: 9000,
		});
		if (!line) throw new Error("no line");
		expect(
			await refusal(
				scope.invoiceLineSources.insert({ lineId: line.id, timeEntryId: acme.entry.id }),
			),
		).toBeNull();
	});

	it("an invoiced entry cannot be deleted", async () => {
		const { acme } = await seed();

		expect(
			await refusal(
				organisationScope(database, acme.id).timeEntries.delete((e) => eq(e.id, acme.entry.id)),
			),
		).toContain("FOREIGN KEY");
	});

	it("a rate is for a person or a task, never both, and one per level and date", async () => {
		const { acme, ada } = await seed();
		const rate = (ids: { userId?: string; projectId?: string; taskId?: string }) =>
			organisationScope(database, acme.id).rates.insert({
				kind: "billable",
				...ids,
				amountMinor: 8000,
				currency: "GBP",
				effectiveFrom: "2026-06-01",
			});

		expect(await refusal(rate({ userId: ada.id, taskId: acme.task.id }))).toContain("CHECK");
		expect(
			await refusal(rate({ userId: ada.id, projectId: acme.project.id, taskId: acme.task.id })),
		).toContain("CHECK");
		expect(await refusal(rate({ userId: ada.id, projectId: acme.project.id }))).toBeNull();
		expect(await refusal(rate({ projectId: acme.project.id, taskId: acme.task.id }))).toBeNull();

		// The organisation's default: no ids at all. A second one from the same day is refused.
		expect(await refusal(rate({}))).toBeNull();
		expect(await refusal(rate({}))).toContain("UNIQUE");
		expect(await refusal(rate({ userId: ada.id, projectId: acme.project.id }))).toContain("UNIQUE");
	});

	it("money is never negative where it cannot be, and a currency is an ISO code", async () => {
		const { acme, ada } = await seed();
		const scope = organisationScope(database, acme.id);
		const expense = (amountMinor: number, currency: string) =>
			scope.expenses.insert({
				userId: ada.id,
				projectId: acme.project.id,
				categoryId: acme.category.id,
				spentOn: "2026-11-12",
				amountMinor,
				currency,
			});

		expect(await refusal(expense(-1, "GBP"))).toContain("CHECK");
		expect(await refusal(expense(100, "gbp"))).toContain("CHECK");
		expect(await refusal(expense(100, "POUND"))).toContain("CHECK");
		expect(await refusal(expense(0, "EUR"))).toBeNull();
		expect(
			await refusal(
				scope.rates.insert({
					kind: "cost",
					userId: ada.id,
					amountMinor: -100,
					currency: "GBP",
					effectiveFrom: "2026-06-01",
				}),
			),
		).toContain("CHECK");
		const payment = (amountMinor: number) =>
			scope.payments.insert({
				invoiceId: acme.invoice.id,
				kind: "payment",
				amountMinor,
				paidOn: "2026-12-05",
				method: "bank_transfer",
				recordedBy: ada.id,
			});
		expect(await refusal(payment(0))).toContain("CHECK");
		expect(await refusal(payment(-500))).toContain("CHECK");
		expect(await refusal(payment(500))).toBeNull();
	});
});
