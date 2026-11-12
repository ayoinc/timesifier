import { and, asc, eq, isNotNull, isNull, or, type SQL } from "drizzle-orm";

import { changes, recordStatement } from "~/activity/activity.server";
import { type OrganisationScope, uuidv7 } from "~/db";
import type { Day } from "~/time/calendar";

import { type RateLevel, type RateRow, rateLevel } from "./rates";

/**
 * Setting billable rates (TS-067, B5). A rate is never changed in place
 * once it is in force: a new amount is a new row from its own effective day,
 * so an entry keeps the rate of its own local day and a change never prices
 * earlier work again. A row from a day that has not come yet may be changed,
 * since nothing has been priced by it. Owners, admins and
 * Finance set rates (`mayManageRates`); the route checks that.
 */

/** Which rate is set: the ids it applies to. A person and a task at once is no rate. */
export interface RateTarget {
	userId: string | null;
	projectId: string | null;
	taskId: string | null;
}

/** A rate as a page lists it. */
export interface RateView extends RateRow {
	id: string;
	level: RateLevel;
}

const isNullOr = (column: Parameters<typeof eq>[0], value: string | null): SQL =>
	value === null ? isNull(column) : eq(column, value);

/** Every billable rate that can price `projectId`: its own, and the people's and tasks' defaults. */
export async function ratesForProject(
	scope: OrganisationScope,
	projectId: string,
): Promise<RateView[]> {
	const rows = await scope.rates.select(
		(r) =>
			and(
				eq(r.kind, "billable"),
				or(
					eq(r.projectId, projectId),
					and(isNull(r.projectId), or(isNotNull(r.userId), isNotNull(r.taskId))),
				),
			),
		{ orderBy: (r) => [asc(r.effectiveFrom)] },
	);
	return rows.map(toView);
}

/** The organisation's default billable rates: each person's and each task's, every effective day. */
export async function defaultRates(scope: OrganisationScope): Promise<RateView[]> {
	const rows = await scope.rates.select((r) => and(eq(r.kind, "billable"), isNull(r.projectId)), {
		orderBy: (r) => [asc(r.effectiveFrom)],
	});
	return rows.map(toView).filter((row) => row.level === "person" || row.level === "task");
}

function toView(row: {
	id: string;
	userId: string | null;
	projectId: string | null;
	taskId: string | null;
	amountMinor: number;
	currency: string;
	effectiveFrom: string;
}): RateView {
	const rate: RateRow = {
		kind: "billable",
		userId: row.userId,
		projectId: row.projectId,
		taskId: row.taskId,
		amountMinor: row.amountMinor,
		currency: row.currency,
		effectiveFrom: row.effectiveFrom,
	};
	return { ...rate, id: row.id, level: rateLevel(rate) };
}

/** Why a rate was not set. */
export type NotRated = "not-found" | "in-force";

/**
 * Sets the billable rate of `target` to `amountMinor` of `currency` from
 * `effectiveFrom` on. A rate already set for that day is replaced when the
 * day has not come yet (`today` is the organisation's); one in force is
 * refused, and a later day is asked for instead. The ids must be checked
 * by the caller to be this organisation's.
 */
export async function setRate(
	scope: OrganisationScope,
	actor: string,
	target: RateTarget,
	rate: { amountMinor: number; currency: string; effectiveFrom: Day },
	today: Day,
): Promise<{ ok: true } | { ok: false; reason: NotRated }> {
	if (target.userId !== null && target.taskId !== null) return { ok: false, reason: "not-found" };
	const [same] = await scope.rates.select(
		(r) =>
			and(
				eq(r.kind, "billable"),
				isNullOr(r.userId, target.userId),
				isNullOr(r.projectId, target.projectId),
				isNullOr(r.taskId, target.taskId),
				eq(r.effectiveFrom, rate.effectiveFrom),
			),
		{ limit: 1 },
	);
	if (same) {
		if (same.effectiveFrom <= today && same.amountMinor !== rate.amountMinor) {
			return { ok: false, reason: "in-force" };
		}
		if (same.amountMinor === rate.amountMinor && same.currency === rate.currency) {
			return { ok: true };
		}
		const changed = { amountMinor: rate.amountMinor, currency: rate.currency };
		await scope.batch([
			scope.rates.statements.update(changed, (r) => eq(r.id, same.id)),
			recordStatement(
				scope,
				actor,
				"rate.updated",
				{ type: "rate", id: same.id },
				changes(same, changed, ["amountMinor", "currency"]),
			),
		]);
		return { ok: true };
	}
	const id = uuidv7();
	const row = { id, kind: "billable", ...target, ...rate };
	await scope.batch([
		scope.rates.statements.insert(row),
		recordStatement(
			scope,
			actor,
			"rate.created",
			{ type: "rate", id },
			changes(null, row, [
				"userId",
				"projectId",
				"taskId",
				"amountMinor",
				"currency",
				"effectiveFrom",
			]),
		),
	]);
	return { ok: true };
}
