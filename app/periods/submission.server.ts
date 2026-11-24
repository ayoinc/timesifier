import { and, eq, gte, isNull, lte } from "drizzle-orm";

import { changes, recordStatement } from "~/activity/activity.server";
import { type OrganisationScope, uuidv7 } from "~/db";
import { someoneElseDecides } from "~/leave/leave.server";
import type { DayRule } from "~/leave/rules";
import { daysOver } from "~/leave/rules.server";
import { weeksSubmitted } from "~/notifications/notify.server";
import { notificationStatements } from "~/notifications/words";
import { PeriodStatus, periodBounds, periodContaining, periodOfWeek, statusAfter } from "./periods";

/**
 * A person submitting their own period, and withdrawing it before anybody has
 * decided it (TS-046). The status, the event that records the step and its
 * row in the activity log are written in one batch, so a period never changes
 * without its record. Who may approve, return or reopen it is TS-047's.
 */

/** Why a submission or a withdrawal was not made. */
export type NotMoved = "not-yet" | "running" | "not-from-here" | "over";

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

/**
 * The period of `userId` for the week that starts on `startsOn` as the
 * organisation now draws it, found among their periods on record by range
 * (`periodOfWeek`, TR-12), with its row when it has one.
 */
async function current(
	scope: OrganisationScope,
	userId: string,
	startsOn: string,
	weekStartsOn: number,
) {
	const week = periodContaining(startsOn, weekStartsOn);
	const rows = await scope.periods.select((p) =>
		and(eq(p.userId, userId), lte(p.startsOn, week.endsOn), gte(p.endsOn, week.startsOn)),
	);
	const { period, row } = periodOfWeek(rows, week);
	return { period, row: row ? { ...row, status: PeriodStatus.parse(row.status) } : null };
}

/** What a week approved as it is submitted says, because nobody else may approve it (D5, decision 47). */
export const WEEK_APPROVED_ALONE = "Approved automatically: nobody else can approve it";

/**
 * The writes that approve the period `id` of `userId` as the system, at
 * `at`, in the batch that submits it: nobody but its person may approve it
 * (D5, decision 47), as `someoneElseDecides` says.
 */
export function approvedAlone(scope: OrganisationScope, id: string, userId: string, at: Date) {
	return [
		scope.periods.statements.update(
			{ status: "approved", decidedBy: null, decidedAt: at, comment: WEEK_APPROVED_ALONE },
			(p) => and(eq(p.id, id), eq(p.status, "submitted")),
		),
		scope.periodEvents.statements.insert({
			periodId: id,
			action: "approved",
			actorId: null,
			comment: WEEK_APPROVED_ALONE,
		}),
		recordStatement(
			scope,
			null,
			"period.approved",
			{ type: "period", id, ownerId: userId },
			changes({ status: "submitted" }, { status: "approved" }, ["status"]),
			"system",
		),
	] as const;
}

/**
 * Submits the period of `userId` that starts on `startsOn`. Refused for a
 * week that has not begun, while a timer of theirs runs in it, while a day of
 * it holds more time than the day takes (TS-090: `over` names those days),
 * and when the period is already submitted or approved. A person nobody else
 * may approve for has the week approved by the system as it is submitted
 * (D5, decision 47): `alone` says so.
 */
export async function submitPeriod(scope: OrganisationScope, step: Step) {
	const { userId, startsOn, zone, weekStartsOn, now } = step;
	const { period, row } = await current(scope, userId, startsOn, weekStartsOn);
	if (periodBounds(period, zone).from > now) {
		return { ok: false as const, reason: "not-yet" as NotMoved };
	}

	const running = await scope.timeEntries.select(
		(e) => and(eq(e.userId, userId), isNull(e.endedAt)),
		{
			limit: 1,
		},
	);
	const runningOn = running[0]?.spentOn;
	if (runningOn !== undefined && period.startsOn <= runningOn && runningOn <= period.endsOn) {
		return { ok: false as const, reason: "running" as NotMoved };
	}

	const status = row?.status ?? null;
	if (statusAfter(status, "submitted") === null) {
		return { ok: false as const, reason: "not-from-here" as NotMoved };
	}

	const over: DayRule[] = await daysOver(scope, userId, period.startsOn, period.endsOn, now);
	if (over.length > 0) return { ok: false as const, reason: "over" as NotMoved, over };

	const at = new Date(now);
	const id = row?.id ?? uuidv7();
	const alone = !(await someoneElseDecides(scope, userId));
	const approval = alone ? approvedAlone(scope, id, userId, at) : [];
	const event = scope.periodEvents.statements.insert({
		periodId: id,
		action: "submitted",
		actorId: userId,
		comment: null,
	});
	const recorded = recordStatement(
		scope,
		userId,
		"period.submitted",
		{ type: "period", id, ownerId: userId },
		changes({ status }, { status: "submitted" }, ["status"]),
	);
	// Its deciders are told it waits for them (TS-049), in the same batch.
	const told = notificationStatements(
		scope,
		await weeksSubmitted(
			scope,
			[{ userId, startsOn: period.startsOn, endsOn: period.endsOn, bySystem: false, alone }],
			now,
		),
	);
	if (row) {
		await scope.batch([
			scope.periods.statements.update(
				{ status: "submitted", submittedAt: at, decidedBy: null, decidedAt: null, comment: null },
				(p) => and(eq(p.id, id), eq(p.status, row.status)),
			),
			event,
			recorded,
			...approval,
			...told,
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
			recorded,
			...approval,
			...told,
		]);
	}
	return { ok: true as const, period, alone };
}

/** Withdraws the submitted, undecided period of `userId` that starts on `startsOn`. */
export async function withdrawPeriod(
	scope: OrganisationScope,
	{ userId, startsOn, weekStartsOn }: Pick<Step, "userId" | "startsOn" | "weekStartsOn">,
) {
	const { row } = await current(scope, userId, startsOn, weekStartsOn);
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
		recordStatement(
			scope,
			userId,
			"period.withdrawn",
			{ type: "period", id: row.id, ownerId: userId },
			changes({ status: row.status }, { status: "withdrawn" }, ["status"]),
		),
	]);
	return { ok: true as const };
}

/**
 * Why the day weeks start on cannot change now, or null when it can (TR-12):
 * while any week of the organisation is submitted and undecided, it would be
 * stranded under weeks drawn another way. Once it may change, a new week
 * begins after every period on record (`periodOfWeek`), so none overlaps.
 */
export async function weekStartRefusal(scope: OrganisationScope): Promise<string | null> {
	const waiting = (await scope.periods.select((p) => eq(p.status, "submitted"))).length;
	if (waiting === 0) return null;
	return waiting === 1
		? "1 week is waiting for a decision. Approve or return it before weeks start on another day."
		: `${waiting} weeks are waiting for a decision. Approve or return them before weeks start on another day.`;
}
