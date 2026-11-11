import { and, eq, isNull } from "drizzle-orm";

import { type OrganisationScope, uuidv7 } from "~/db";
import {
	type PeriodDays,
	PeriodStatus,
	periodBounds,
	periodContaining,
	statusAfter,
} from "./periods";

/**
 * A person submitting their own period, and withdrawing it before anybody has
 * decided it (TS-046). The status and the event that records the step are
 * written in one batch, so a period never changes without its record. Who may
 * approve, return or reopen it is TS-047's.
 */

/** Why a submission or a withdrawal was not made. */
export type NotMoved = "not-yet" | "running" | "not-from-here";

export interface Step {
	userId: string;
	/** The first day of the period. */
	startsOn: string;
	/** The person's zone, which decides the period's bounds. */
	zone: string;
	weekStartsOn: number;
	/** The server's clock. */
	now: number;
}

async function current(scope: OrganisationScope, userId: string, startsOn: string) {
	const [row] = await scope.periods.select(
		(p) => and(eq(p.userId, userId), eq(p.startsOn, startsOn)),
		{ limit: 1 },
	);
	return row ? { ...row, status: PeriodStatus.parse(row.status) } : null;
}

/**
 * Submits the period of `userId` that starts on `startsOn`. Refused for a
 * week that has not begun, while a timer of theirs runs in it, and when the
 * period is already submitted or approved.
 */
export async function submitPeriod(scope: OrganisationScope, step: Step) {
	const { userId, startsOn, zone, weekStartsOn, now } = step;
	const period: PeriodDays = periodContaining(startsOn, weekStartsOn);
	const { from, to } = periodBounds(period, zone);
	if (from > now) return { ok: false as const, reason: "not-yet" as NotMoved };

	const running = await scope.timeEntries.select(
		(e) => and(eq(e.userId, userId), isNull(e.endedAt)),
		{
			limit: 1,
		},
	);
	const startedAt = running[0]?.startedAt.getTime();
	if (startedAt !== undefined && from <= startedAt && startedAt < to) {
		return { ok: false as const, reason: "running" as NotMoved };
	}

	const row = await current(scope, userId, period.startsOn);
	const status = row?.status ?? null;
	if (statusAfter(status, "submitted") === null) {
		return { ok: false as const, reason: "not-from-here" as NotMoved };
	}

	const at = new Date(now);
	const id = row?.id ?? uuidv7();
	const event = scope.periodEvents.statements.insert({
		periodId: id,
		action: "submitted",
		actorId: userId,
		comment: null,
	});
	if (row) {
		await scope.batch([
			scope.periods.statements.update(
				{ status: "submitted", submittedAt: at, decidedBy: null, decidedAt: null, comment: null },
				(p) => and(eq(p.id, id), eq(p.status, row.status)),
			),
			event,
		]);
	} else {
		await scope.batch([
			scope.periods.statements.insert({
				id,
				userId,
				startsOn: period.startsOn,
				endsOn: period.endsOn,
				status: "submitted",
				submittedAt: at,
			}),
			event,
		]);
	}
	return { ok: true as const, period };
}

/** Withdraws the submitted, undecided period of `userId` that starts on `startsOn`. */
export async function withdrawPeriod(
	scope: OrganisationScope,
	{ userId, startsOn }: Pick<Step, "userId" | "startsOn">,
) {
	const row = await current(scope, userId, startsOn);
	if (!row || statusAfter(row.status, "withdrawn") === null) {
		return { ok: false as const, reason: "not-from-here" as NotMoved };
	}
	await scope.batch([
		scope.periods.statements.update({ status: "withdrawn" }, (p) =>
			and(eq(p.id, row.id), eq(p.status, "submitted")),
		),
		scope.periodEvents.statements.insert({
			periodId: row.id,
			action: "withdrawn",
			actorId: userId,
			comment: null,
		}),
	]);
	return { ok: true as const };
}
