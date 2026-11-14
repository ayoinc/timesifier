import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";

import { changes, recordStatement, recordStatementWhen } from "~/activity/activity.server";
import { among, type OrganisationScope, uuidv7 } from "~/db";
import { isNameClash, nameKey, RECORD_NAME_PROBLEM, recordName } from "~/lib/names";
import type { Day } from "~/time/calendar";

import { type DatedPrice, parseAmount, UNIT_NAME_MAX_LENGTH } from "./expenses";

/**
 * The organisation's expense categories (TS-070, B9), kept by its owners and
 * admins in Workspace settings. A category is archived, never deleted: its
 * expenses keep it. A unit-priced one, such as mileage, has a unit and a
 * price per unit in the organisation's currency, set from a day on, so a new
 * price applies to the expenses dated from it and not to those before.
 */

export const CATEGORY_NAME_TAKEN = "A category with this name already exists.";

/** A category as the pages show it, with its prices, earliest first. */
export interface Category {
	id: string;
	name: string;
	/** The unit of a unit-priced category, such as "mile"; null otherwise. */
	unitName: string | null;
	prices: DatedPrice[];
	archived: boolean;
}

/** Every category of the organisation, by name, with its prices. */
export async function listCategories(scope: OrganisationScope): Promise<Category[]> {
	const [categories, prices] = await Promise.all([
		scope.expenseCategories.select(undefined, { orderBy: (c) => [asc(c.nameKey)] }),
		scope.expenseCategoryPrices.select(undefined, { orderBy: (p) => [asc(p.effectiveFrom)] }),
	]);
	return categories.map((c) => ({
		id: c.id,
		name: c.name,
		unitName: c.unitName,
		prices: prices
			.filter((p) => p.categoryId === c.id)
			.map(({ effectiveFrom, unitPriceMinor }) => ({ effectiveFrom, unitPriceMinor })),
		archived: c.archivedAt !== null,
	}));
}

/** The categories with these ids, with their prices. */
export async function categoriesById(
	scope: OrganisationScope,
	ids: readonly string[],
): Promise<Map<string, Category>> {
	if (ids.length === 0) return new Map();
	const [categories, prices] = await Promise.all([
		scope.expenseCategories.select((c) => among(c.id, ids)),
		scope.expenseCategoryPrices.select((p) => among(p.categoryId, ids)),
	]);
	return new Map(
		categories.map((c) => [
			c.id,
			{
				id: c.id,
				name: c.name,
				unitName: c.unitName,
				prices: prices.filter((p) => p.categoryId === c.id),
				archived: c.archivedAt !== null,
			},
		]),
	);
}

export type CategoryResult = { ok: true } | { ok: false; problem: string } | null;

/** A unit and its price from a day, for a unit-priced category. */
export interface UnitPrice {
	unitName: string;
	unitPriceMinor: number;
	from: Day;
}

/** What a category's record compares. */
const CATEGORY_FIELDS = ["name", "unitName", "unitPriceMinor", "effectiveFrom"] as const;

/** Adds a category: plain, or unit-priced from `unit.from` on. */
export async function createCategory(
	scope: OrganisationScope,
	actor: string,
	name: string,
	unit: UnitPrice | null,
): Promise<CategoryResult> {
	const id = uuidv7();
	try {
		await scope.batch([
			recordStatement(
				scope,
				actor,
				"expense_category.created",
				{ type: "expense_category", id },
				changes(
					null,
					{
						name,
						unitName: unit?.unitName,
						unitPriceMinor: unit?.unitPriceMinor,
						effectiveFrom: unit?.from,
					},
					CATEGORY_FIELDS,
				),
			),
			scope.expenseCategories.statements.insert({
				id,
				name,
				nameKey: nameKey(name),
				unitName: unit?.unitName ?? null,
				unitPriceMinor: unit?.unitPriceMinor ?? null,
			}),
			...(unit
				? [
						scope.expenseCategoryPrices.statements.insert({
							categoryId: id,
							effectiveFrom: unit.from,
							unitPriceMinor: unit.unitPriceMinor,
						}),
					]
				: []),
		]);
	} catch (error) {
		if (isNameClash(error)) return { ok: false, problem: CATEGORY_NAME_TAKEN };
		throw error;
	}
	return { ok: true };
}

/**
 * Renames category `id` and, for a unit-priced one, sets its unit and the
 * price from `unit.from` on. A price already set from that very day is
 * replaced. Whether a category is unit-priced is chosen when it is added.
 * Null when there is no such category.
 */
export async function changeCategory(
	scope: OrganisationScope,
	actor: string,
	id: string,
	name: string,
	unit: UnitPrice | null,
): Promise<CategoryResult> {
	const [category] = await scope.expenseCategories.select((c) => eq(c.id, id), { limit: 1 });
	if (!category) return null;
	const unitPriced = category.unitName !== null;
	if (unitPriced !== (unit !== null)) {
		return {
			ok: false,
			problem: unitPriced
				? "Give the unit and its price."
				: "A category without a unit price keeps none. Add a new category for one.",
		};
	}
	// The price compared is the one set from that very day, which this replaces.
	const [price] = unit
		? await scope.expenseCategoryPrices.select(
				(p) => and(eq(p.categoryId, id), eq(p.effectiveFrom, unit.from)),
				{ limit: 1 },
			)
		: [];
	const summary = changes(
		{ name: category.name, unitName: category.unitName, ...price },
		{
			name,
			unitName: unit?.unitName ?? null,
			...(unit && { effectiveFrom: unit.from, unitPriceMinor: unit.unitPriceMinor }),
		},
		CATEGORY_FIELDS,
	);
	// Nothing differs: nothing to change, nothing to record.
	if (!summary.before && !summary.after) return { ok: true };
	try {
		await scope.batch([
			recordStatement(
				scope,
				actor,
				"expense_category.updated",
				{ type: "expense_category", id },
				summary,
			),
			scope.expenseCategories.statements.update(
				{
					name,
					nameKey: nameKey(name),
					...(unit ? { unitName: unit.unitName, unitPriceMinor: unit.unitPriceMinor } : {}),
				},
				(c) => eq(c.id, id),
			),
			...(unit
				? [
						scope.expenseCategoryPrices.statements.delete((p) =>
							and(eq(p.categoryId, id), eq(p.effectiveFrom, unit.from)),
						),
						scope.expenseCategoryPrices.statements.insert({
							id: uuidv7(),
							categoryId: id,
							effectiveFrom: unit.from,
							unitPriceMinor: unit.unitPriceMinor,
						}),
					]
				: []),
		]);
	} catch (error) {
		if (isNameClash(error)) return { ok: false, problem: CATEGORY_NAME_TAKEN };
		throw error;
	}
	return { ok: true };
}

/** Archives or restores category `id`. Null when there is no such category. */
export async function setCategoryArchived(
	scope: OrganisationScope,
	actor: string,
	id: string,
	archived: boolean,
): Promise<CategoryResult> {
	const [category] = await scope.expenseCategories.select((c) => eq(c.id, id), { limit: 1 });
	if (!category) return null;
	// Only one that is not so already changes, and only that is recorded.
	const stillOtherwise = scope.expenseCategories.exists((c) =>
		and(eq(c.id, id), archived ? isNull(c.archivedAt) : isNotNull(c.archivedAt)),
	);
	await scope.batch([
		recordStatementWhen(
			scope,
			stillOtherwise,
			actor,
			archived ? "expense_category.archived" : "expense_category.restored",
			{ type: "expense_category", id },
		),
		scope.expenseCategories.statements.update({ archivedAt: archived ? new Date() : null }, (c) =>
			and(eq(c.id, id), archived ? isNull(c.archivedAt) : isNotNull(c.archivedAt)),
		),
	]);
	return { ok: true };
}

/** A change to the categories, as Workspace settings' form sends it. */
export type CategoryIntent =
	| { intent: "add-category"; name: string; unitName?: string; unitPrice?: string; from?: Day }
	| {
			intent: "change-category";
			categoryId: string;
			name: string;
			unitName?: string;
			unitPrice?: string;
			from?: Day;
	  }
	| { intent: "archive-category"; categoryId: string }
	| { intent: "restore-category"; categoryId: string };

/** What a change to the categories did: the sentence to say, or why it was refused and with which status. */
export type CategoryOutcome =
	| { ok: true; said: string }
	| { ok: false; problem: string; status: number };

/**
 * Makes the change `input` asks for. A unit and a price come together or not
 * at all; the price is in `currency` and is from `input.from`, else `today`.
 */
export async function keepCategory(
	scope: OrganisationScope,
	actor: string,
	input: CategoryIntent,
	currency: string,
	today: Day,
): Promise<CategoryOutcome> {
	const missing = { ok: false as const, problem: "That category is no longer there.", status: 404 };
	if (input.intent === "archive-category" || input.intent === "restore-category") {
		const archived = input.intent === "archive-category";
		const result = await setCategoryArchived(scope, actor, input.categoryId, archived);
		return result === null
			? missing
			: { ok: true, said: archived ? "Category archived." : "Category restored." };
	}

	const name = recordName(input.name);
	if (name === null) return { ok: false, problem: RECORD_NAME_PROBLEM, status: 400 };
	const unitName = input.unitName?.trim() ?? "";
	const priceText = input.unitPrice?.trim() ?? "";
	let unit: UnitPrice | null = null;
	if (unitName !== "" || priceText !== "") {
		const unitPriceMinor = parseAmount(priceText, currency);
		if (unitName === "" || unitName.length > UNIT_NAME_MAX_LENGTH || unitPriceMinor === null) {
			return {
				ok: false,
				problem: `Give both the unit, up to ${UNIT_NAME_MAX_LENGTH} characters, and its price in ${currency}, such as 0.45.`,
				status: 400,
			};
		}
		unit = { unitName, unitPriceMinor, from: input.from ?? today };
	}

	const result =
		input.intent === "add-category"
			? await createCategory(scope, actor, name, unit)
			: await changeCategory(scope, actor, input.categoryId, name, unit);
	if (result === null) return missing;
	if (!result.ok) return { ok: false, problem: result.problem, status: 409 };
	return { ok: true, said: input.intent === "add-category" ? `${name} added.` : `${name} saved.` };
}
