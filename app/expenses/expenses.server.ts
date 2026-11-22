import { env } from "cloudflare:workers";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { changes, recordStatement } from "~/activity/activity.server";
import { among, type OrganisationScope, organisations, uuidv7 } from "~/db";
import type { LockReason } from "~/locks/locks";
import { invoicedIds, lockNoticeOf, lockReasonsOn } from "~/locks/locks.server";
import { lineAmount, type Money, totalsByCurrency } from "~/money/money";
import {
	expenseTagStatements,
	TAG_NOT_OFFERED,
	tagsAllowed,
	tagsOfExpenses,
} from "~/tags/tags.server";
import type { Day } from "~/time/calendar";
import { formatDay } from "~/time/format";

import { type Category, categoriesById } from "./categories.server";
import { AMOUNT_MAX_MINOR, parseAmount, parseQuantity, priceOn } from "./expenses";
import {
	type CheckedReceipt,
	checkReceipt,
	deleteReceipt,
	putReceipt,
	receiptKey,
} from "./receipts.server";

/**
 * A person's expenses (TS-070, B9). Only the person adds, changes and deletes
 * their own (`mayChangeExpensesOf`): every write here is limited to
 * `userId`'s rows, so another person's expense is no expense. An expense is
 * locked as a time entry is (app/locks): by its person's submitted or
 * approved period holding its day, by the organisation's lock date, and by
 * being on an invoice. It is submitted, withdrawn, approved and returned with
 * that period: there is no step of its own.
 *
 * Its amount is in minor units of its project's currency: the project's own,
 * else its client's, else the organisation's. A unit-priced category's
 * expense is a quantity at the price in force on its day, worked out again
 * whenever the expense is saved; its price is in the organisation's currency,
 * so it is refused on a project billed in another (there is no conversion).
 */

/** Why a write was refused: the sentence, and the status the action answers with. */
export type Refusal = { ok: false; problem: string; status: number };

const LOCKED: Record<LockReason, string> = {
	"locked-through":
		"That day is on or before the organisation's lock date, so its expenses cannot change.",
	submitted: "That week is submitted, so its expenses cannot change. Withdraw it first.",
	approved: "That week is approved, so its expenses cannot change.",
	invoiced: "That expense is on an invoice, so it cannot change.",
};

const MISSING: Refusal = { ok: false, problem: "That expense is no longer there.", status: 404 };

function refusal(problem: string, status = 400): Refusal {
	return { ok: false, problem, status };
}

/** The refusal of a locked write; for the lock date, it names the date and the owner's or admin's reason. */
async function lockedRefusal(scope: OrganisationScope, lock: LockReason): Promise<Refusal> {
	if (lock !== "locked-through") return refusal(LOCKED[lock], 409);
	const notice = await lockNoticeOf(scope.organisationId);
	if (notice === null) return refusal(LOCKED[lock], 409);
	const why = notice.reason ? ` The reason given: ${notice.reason}` : "";
	return refusal(
		`That day is on or before the lock date, ${formatDay(notice.lockedThrough)}, so its expenses cannot change.${why}`,
		409,
	);
}

/**
 * Why a write touching `days` of `userId`'s, and the expense `id` when it is
 * one already, is refused, or null: invoiced first, then the lock date or
 * period of the days in the order given (app/locks).
 */
async function lockOfWrite(
	scope: OrganisationScope,
	userId: string,
	days: readonly Day[],
	id: string | null,
): Promise<LockReason | null> {
	const [reasons, invoiced] = await Promise.all([
		lockReasonsOn(scope, userId, days),
		id === null ? Promise.resolve(new Set<string>()) : invoicedIds(scope, "expense", [id]),
	]);
	if (id !== null && invoiced.has(id)) return "invoiced";
	const ranked: LockReason[] = ["locked-through", "approved", "submitted"];
	for (const reason of ranked) {
		if (days.some((day) => reasons.get(day) === reason)) return reason;
	}
	return null;
}

/** What a person fills in for an expense, as the form sends it. */
export interface ExpenseInput {
	spentOn: Day;
	projectId: string;
	categoryId: string;
	/** The amount typed, for a category without a unit price. */
	amount: string;
	/** The quantity typed, for a unit-priced category. */
	quantity: string;
	notes: string | null;
	billable: boolean;
	reimbursable: boolean;
	/** The file chosen, or null; an empty file input is no file. */
	receipt: File | null;
	/** Whether to remove the receipt it has, when no new one is given. */
	removeReceipt: boolean;
	/** The expense's tags; left out, they stay as they are (TS-085). */
	tagIds?: readonly string[];
}

/** The organisation's currency. */
export async function termsOf(organisationId: string) {
	const [row] = await drizzle(env.DB)
		.select({ currency: organisations.currency })
		.from(organisations)
		.where(eq(organisations.id, organisationId))
		.limit(1);
	return { currency: row?.currency ?? "GBP" };
}

type ExpenseRow = Awaited<ReturnType<OrganisationScope["expenses"]["select"]>>[number];

/** What an expense holds once the input is checked, apart from who and which. */
interface Resolved {
	values: {
		spentOn: Day;
		projectId: string;
		categoryId: string;
		amountMinor: number;
		currency: string;
		quantityMilli: number | null;
		unitPriceMinor: number | null;
		billable: boolean;
		reimbursable: boolean;
		notes: string | null;
	};
	receipt: CheckedReceipt | null;
}

/**
 * The input checked against the organisation: an active project and category
 * (or the ones the expense already has, which may since have been archived),
 * an amount in the project's currency or a quantity at the category's price on
 * the day, and a receipt that is one.
 */
async function resolve(
	scope: OrganisationScope,
	currency: string,
	input: ExpenseInput,
	before: ExpenseRow | null,
): Promise<Resolved | Refusal> {
	const [[project], categories] = await Promise.all([
		scope.projects.select((p) => eq(p.id, input.projectId), { limit: 1 }),
		categoriesById(scope, [input.categoryId]),
	]);
	if (!project || (project.archivedAt !== null && project.id !== before?.projectId)) {
		return refusal("Choose an active project.");
	}
	const category: Category | undefined = categories.get(input.categoryId);
	if (!category || (category.archived && category.id !== before?.categoryId)) {
		return refusal("Choose an active category.");
	}

	let projectCurrency = project.currency;
	if (projectCurrency === null && project.clientId !== null) {
		const clientId = project.clientId;
		const [client] = await scope.clients.select((c) => eq(c.id, clientId), { limit: 1 });
		projectCurrency = client?.currency ?? null;
	}
	const expenseCurrency = projectCurrency ?? currency;

	let amountMinor: number | null;
	let quantityMilli: number | null = null;
	let unitPriceMinor: number | null = null;
	if (category.unitName !== null) {
		unitPriceMinor = priceOn(category.prices, input.spentOn);
		if (unitPriceMinor === null) return refusal("That category has no price yet.");
		if (expenseCurrency !== currency) {
			return refusal(
				`${category.name} is priced in ${currency}, and ${project.name} is billed in ${expenseCurrency}. Record it as an amount in another category.`,
			);
		}
		quantityMilli = parseQuantity(input.quantity);
		if (quantityMilli === null) return refusal("Enter a quantity, such as 12 or 12.5.");
		amountMinor = lineAmount(quantityMilli, unitPriceMinor);
		if (amountMinor > AMOUNT_MAX_MINOR) return refusal("That quantity is too large.");
	} else {
		amountMinor = parseAmount(input.amount, expenseCurrency);
		if (amountMinor === null) {
			return refusal(`Enter an amount in ${expenseCurrency}, such as 12.50.`);
		}
	}

	const checked = await checkReceipt(input.receipt);
	if (!checked.ok) return refusal(checked.problem);

	return {
		values: {
			spentOn: input.spentOn,
			projectId: project.id,
			categoryId: category.id,
			amountMinor,
			currency: expenseCurrency,
			quantityMilli,
			unitPriceMinor,
			// A non-billable project bills nothing, its expenses included.
			billable: input.billable && project.billingType !== "non_billable",
			reimbursable: input.reimbursable,
			notes: input.notes,
		},
		receipt: checked.receipt,
	};
}

/** The fields the activity log records a change of; `tags` is the tag ids, as for projects. */
const RECORDED = [
	"spentOn",
	"projectId",
	"categoryId",
	"amountMinor",
	"currency",
	"quantityMilli",
	"billable",
	"reimbursable",
	"notes",
	"receiptName",
	"tags",
] as const;

/** Tag ids as the activity summary holds them. */
function tagList(tagIds: readonly string[]): string {
	return [...new Set(tagIds)].sort().join(",");
}

/** Records an expense of `userId`'s. Its id, or why it was refused. */
export async function recordExpense(
	scope: OrganisationScope,
	userId: string,
	input: ExpenseInput,
): Promise<{ ok: true; id: string } | Refusal> {
	const terms = await termsOf(scope.organisationId);
	const resolved = await resolve(scope, terms.currency, input, null);
	if ("ok" in resolved) return resolved;
	const { values, receipt } = resolved;

	const lock = await lockOfWrite(scope, userId, [values.spentOn], null);
	if (lock) return lockedRefusal(scope, lock);
	const tagIds = input.tagIds ?? [];
	if (!(await tagsAllowed(scope, [], tagIds))) return refusal(TAG_NOT_OFFERED);

	const id = uuidv7();
	const row = {
		id,
		userId,
		...values,
		receiptKey: receipt ? receiptKey(scope.organisationId, id) : null,
		receiptName: receipt?.name ?? null,
		receiptType: receipt?.type ?? null,
	};
	// The file first: a row never names a receipt that is not there.
	if (receipt) await putReceipt(scope.organisationId, id, receipt);
	try {
		await scope.batch([
			scope.expenses.statements.insert(row),
			...expenseTagStatements(scope, id, [], tagIds),
			recordStatement(
				scope,
				userId,
				"expense.created",
				{ type: "expense", id, ownerId: userId },
				changes(null, { ...row, tags: tagList(tagIds) }, RECORDED),
			),
		]);
	} catch (error) {
		if (receipt) await deleteReceipt(scope.organisationId, id);
		throw error;
	}
	return { ok: true, id };
}

/** `userId`'s expense `id`, or null. */
async function ownExpense(scope: OrganisationScope, userId: string, id: string) {
	const [row] = await scope.expenses.select((e) => and(eq(e.id, id), eq(e.userId, userId)), {
		limit: 1,
	});
	return row ?? null;
}

/** Changes `userId`'s expense `id`. Refused when it is locked before or after the change. */
export async function changeExpense(
	scope: OrganisationScope,
	userId: string,
	id: string,
	input: ExpenseInput,
): Promise<{ ok: true } | Refusal> {
	const before = await ownExpense(scope, userId, id);
	if (!before) return MISSING;
	const terms = await termsOf(scope.organisationId);
	const resolved = await resolve(scope, terms.currency, input, before);
	if ("ok" in resolved) return resolved;
	const { values, receipt } = resolved;

	const lock = await lockOfWrite(scope, userId, [before.spentOn, values.spentOn], id);
	if (lock) return lockedRefusal(scope, lock);
	const current = (await tagsOfExpenses(scope, [id])).get(id) ?? [];
	const tagIds = input.tagIds ?? current;
	if (!(await tagsAllowed(scope, current, tagIds))) return refusal(TAG_NOT_OFFERED);

	const removes = receipt === null && input.removeReceipt && before.receiptKey !== null;
	const after = {
		...values,
		...(receipt
			? {
					receiptKey: receiptKey(scope.organisationId, id),
					receiptName: receipt.name,
					receiptType: receipt.type,
				}
			: removes
				? { receiptKey: null, receiptName: null, receiptType: null }
				: {}),
	};
	if (receipt) await putReceipt(scope.organisationId, id, receipt);
	await scope.batch([
		scope.expenses.statements.update(after, (e) => and(eq(e.id, id), eq(e.userId, userId))),
		...expenseTagStatements(scope, id, current, tagIds),
		recordStatement(
			scope,
			userId,
			"expense.updated",
			{ type: "expense", id, ownerId: userId },
			changes(
				{ ...before, tags: tagList(current) },
				{ ...before, ...after, tags: tagList(tagIds) },
				RECORDED,
			),
		),
	]);
	if (removes) await deleteReceipt(scope.organisationId, id);
	return { ok: true };
}

/** Deletes `userId`'s expense `id` and its receipt. Refused while it is locked. */
export async function deleteExpense(
	scope: OrganisationScope,
	userId: string,
	id: string,
): Promise<{ ok: true } | Refusal> {
	const before = await ownExpense(scope, userId, id);
	if (!before) return MISSING;
	const lock = await lockOfWrite(scope, userId, [before.spentOn], id);
	if (lock) return lockedRefusal(scope, lock);
	const current = (await tagsOfExpenses(scope, [id])).get(id) ?? [];
	await scope.batch([
		recordStatement(
			scope,
			userId,
			"expense.deleted",
			{ type: "expense", id, ownerId: userId },
			changes({ ...before, tags: tagList(current) }, null, RECORDED),
		),
		...expenseTagStatements(scope, id, current, []),
		scope.expenses.statements.delete((e) => and(eq(e.id, id), eq(e.userId, userId))),
	]);
	if (before.receiptKey !== null) await deleteReceipt(scope.organisationId, id);
	return { ok: true };
}

/** An expense as the Expenses page lists it. */
export interface ExpenseView {
	id: string;
	spentOn: Day;
	projectId: string;
	project: string;
	categoryId: string;
	category: string;
	unitName: string | null;
	amountMinor: number;
	currency: string;
	quantityMilli: number | null;
	unitPriceMinor: number | null;
	billable: boolean;
	reimbursable: boolean;
	notes: string | null;
	receiptName: string | null;
	/** The ids of its tags. */
	tagIds: string[];
	/** Why it cannot change, or null when its person may change it. */
	lock: LockReason | null;
}

/** `userId`'s expenses dated `first` to `last`, by day, each with why it is locked. */
export async function expensesOf(
	scope: OrganisationScope,
	userId: string,
	first: Day,
	last: Day,
): Promise<ExpenseView[]> {
	const rows = await scope.expenses.select(
		(e) => and(eq(e.userId, userId), gte(e.spentOn, first), lte(e.spentOn, last)),
		{ orderBy: (e) => [asc(e.spentOn), asc(e.id)] },
	);
	const projectIds = [...new Set(rows.map((row) => row.projectId))];
	const ids = rows.map((row) => row.id);
	const [reasons, invoiced, tags, projects, categories] = await Promise.all([
		lockReasonsOn(scope, userId, [...new Set(rows.map((row) => row.spentOn))]),
		invoicedIds(scope, "expense", ids),
		tagsOfExpenses(scope, ids),
		projectIds.length === 0
			? Promise.resolve([])
			: scope.projects.select((p) => among(p.id, projectIds)),
		categoriesById(scope, [...new Set(rows.map((row) => row.categoryId))]),
	]);
	const projectNames = new Map(projects.map((p) => [p.id, p.name]));
	return rows.map((row) => {
		const category = categories.get(row.categoryId);
		return {
			id: row.id,
			spentOn: row.spentOn,
			projectId: row.projectId,
			project: projectNames.get(row.projectId) ?? "",
			categoryId: row.categoryId,
			category: category?.name ?? "",
			unitName: row.quantityMilli === null ? null : (category?.unitName ?? null),
			amountMinor: row.amountMinor,
			currency: row.currency,
			quantityMilli: row.quantityMilli,
			unitPriceMinor: row.unitPriceMinor,
			billable: row.billable,
			reimbursable: row.reimbursable,
			notes: row.notes,
			receiptName: row.receiptName,
			tagIds: tags.get(row.id) ?? [],
			lock: invoiced.has(row.id) ? "invoiced" : (reasons.get(row.spentOn) ?? null),
		};
	});
}

/** The expense `id` of this organisation, whoever's it is, for the receipt's route to check. */
export async function findExpense(scope: OrganisationScope, id: string) {
	const [row] = await scope.expenses.select((e) => eq(e.id, id), { limit: 1 });
	return row ?? null;
}

/** What one person's expenses in a period come to: how many, and the totals per currency. */
export interface ExpenseTotals {
	count: number;
	total: Money[];
	billable: Money[];
}

/**
 * The expenses of each of `userIds` dated `first` to `last`, added up per
 * currency, for Approvals: a person with none is not in the map.
 */
export async function expenseTotalsOf(
	scope: OrganisationScope,
	userIds: readonly string[],
	first: Day,
	last: Day,
): Promise<Map<string, ExpenseTotals>> {
	if (userIds.length === 0) return new Map();
	const rows = await scope.expenses.select((e) =>
		and(among(e.userId, userIds), gte(e.spentOn, first), lte(e.spentOn, last)),
	);
	const totals = new Map<string, ExpenseTotals>();
	for (const userId of new Set(rows.map((row) => row.userId))) {
		const own = rows.filter((row) => row.userId === userId);
		const money = (row: ExpenseRow) => ({ amountMinor: row.amountMinor, currency: row.currency });
		totals.set(userId, {
			count: own.length,
			total: totalsByCurrency(own.map(money)),
			billable: totalsByCurrency(own.filter((row) => row.billable).map(money)),
		});
	}
	return totals;
}
