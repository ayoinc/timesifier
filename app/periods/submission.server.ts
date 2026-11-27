import { and, eq, gte, isNull, lte, or } from "drizzle-orm";

import { changes, recordStatement } from "~/activity/activity.server";
import { APPROVED_ALONE, weekStatusOf } from "~/approvals/parts";
import { planParts } from "~/approvals/parts.server";
import { type OrganisationScope, uuidv7 } from "~/db";
import { someoneElseDecides } from "~/leave/leave.server";
import type { DayRule } from "~/leave/rules";
import { daysOver } from "~/leave/rules.server";
import { weeksSubmitted } from "~/notifications/notify.server";
import { notificationStatements } from "~/notifications/words";

import {
	type PeriodDays,
	PeriodStatus,
	periodBounds,
	periodContaining,
	periodOfWeek,
	statusAfter,
} from "./periods";

/**
 * A person submitting their own period, and withdrawing it before anybody has
 * decided it (TS-046). The status, the event that records the step and its
 * row in the activity log are written in one batch, so a period never changes
 * without its record. Who may approve, return or reopen it is TS-047's; how a
 * week is held in parts, each decided apart, is TS-117's (`planParts`).
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

/**
 * The writes that approve the period `id` of `userId` as the system, at
 * `at`, in the batch that submits it: nobody but its person may approve it
 * (D5, decision 47), as `someoneElseDecides` says, or every part of it is
 * approved already (TS-117).
 */
export function approvedAlone(scope: OrganisationScope, id: string, userId: string, at: Date) {
	return [
		scope.periods.statements.update(
			{ status: "approved", decidedBy: null, decidedAt: at, comment: APPROVED_ALONE },
			(p) => and(eq(p.id, id), eq(p.status, "submitted")),
		),
		scope.periodEvents.statements.insert({
			periodId: id,
			action: "approved",
			actorId: null,
			comment: APPROVED_ALONE,
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

/** A week being submitted, by its person or by the system at the lock date (TR-01). */
export interface Submitting {
	userId: string;
	period: PeriodDays;
	/** Its row, when the period is on record. */
	row: { id: string; status: PeriodStatus } | null;
	/** Who submits it: its person, or null for the system. */
	actorId: string | null;
	now: number;
	/** For the system: why it submitted the week, told to its person. */
	why?: string | null;
}

/**
 * The writes that submit a week, for one batch: the period, its parts
 * (TS-117, `planParts`), the step and its row in the activity log, the
 * system's approval of what nobody else may decide (D5, decision 47), and the
 * notifications to those it waits for and, when the system submitted it, to
 * its person (TS-049). `alone`: the whole week is approved as it is submitted.
 */
export async function submissionStatements(scope: OrganisationScope, submitting: Submitting) {
	const { userId, period, row, actorId, now } = submitting;
	const at = new Date(now);
	const id = row?.id ?? uuidv7();
	const lineAlone = !(await someoneElseDecides(scope, userId));
	const plan = await planParts(scope, {
		periodId: id,
		known: row !== null,
		week: { userId, startsOn: period.startsOn, endsOn: period.endsOn },
		lineAlone,
		at,
	});
	const alone = plan.held ? weekStatusOf(plan.parts) === "approved" : lineAlone;
	const bySystem = actorId === null;
	const write = row
		? scope.periods.statements.update(
				{ status: "submitted", submittedAt: at, decidedBy: null, decidedAt: null, comment: null },
				(p) => and(eq(p.id, id), eq(p.status, row.status)),
			)
		: scope.periods.statements.insert({
				id,
				userId,
				startsOn: period.startsOn,
				endsOn: period.endsOn,
				status: "submitted",
				submittedAt: at,
			});
	const told = await weeksSubmitted(
		scope,
		[
			{
				userId,
				startsOn: period.startsOn,
				endsOn: period.endsOn,
				bySystem,
				alone,
				parts: plan.held ? plan.waiting : null,
			},
		],
		now,
		submitting.why ?? null,
	);
	const statements = [
		write,
		...plan.statements,
		scope.periodEvents.statements.insert({
			periodId: id,
			action: "submitted",
			actorId,
			comment: null,
		}),
		recordStatement(
			scope,
			actorId,
			"period.submitted",
			{ type: "period", id, ownerId: userId },
			changes({ status: row?.status ?? null }, { status: "submitted" }, ["status"]),
			bySystem ? "system" : "web",
		),
		...(alone ? approvedAlone(scope, id, userId, at) : []),
		...notificationStatements(scope, told),
	] as const;
	return { id, alone, statements };
}

/**
 * Submits the period of `userId` that starts on `startsOn`. Refused for a
 * week that has not begun, while a timer of theirs runs in it, while a day of
 * it holds more time than the day takes (TS-090: `over` names those days),
 * and when the period is already submitted or approved. A person nobody else
 * may approve for has the week approved by the system as it is submitted
 * (D5, decision 47): `alone` says so. A week with time on a client project
 * that has a delivery manager is submitted in parts (TS-117); submitted again
 * after a return, the parts returned wait again and those approved stay so.
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

	const { alone, statements } = await submissionStatements(scope, {
		userId,
		period,
		row,
		actorId: userId,
		now,
	});
	await scope.batch(statements);
	return { ok: true as const, period, alone };
}

/**
 * Withdraws the submitted, undecided period of `userId` that starts on
 * `startsOn`. A week held in parts is withdrawn only while no part of it has
 * been approved (TS-117): an approved part is locked.
 */
export async function withdrawPeriod(
	scope: OrganisationScope,
	{ userId, startsOn, weekStartsOn }: Pick<Step, "userId" | "startsOn" | "weekStartsOn">,
) {
	const { row } = await current(scope, userId, startsOn, weekStartsOn);
	if (!row || statusAfter(row.status, "withdrawn") === null) {
		return { ok: false as const, reason: "not-from-here" as NotMoved };
	}
	const approvedPart = await scope.periodParts.select(
		(p) => and(eq(p.periodId, row.id), eq(p.status, "approved")),
		{ limit: 1 },
	);
	if (approvedPart.length > 0) return { ok: false as const, reason: "not-from-here" as NotMoved };
	await scope.batch([
		scope.periods.statements.update({ status: "withdrawn" }, (p) =>
			and(eq(p.id, row.id), eq(p.status, "submitted")),
		),
		scope.periodParts.statements.delete((p) => eq(p.periodId, row.id)),
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
	// A part still waiting in a week returned for another part counts too (TS-117).
	const waiting = (
		await scope.periods.select((p) =>
			or(
				eq(p.status, "submitted"),
				scope.periodParts.exists((part) =>
					and(eq(part.periodId, p.id), eq(part.status, "submitted")),
				),
			),
		)
	).length;
	if (waiting === 0) return null;
	return waiting === 1
		? "1 week is waiting for a decision. Approve or return it before weeks start on another day."
		: `${waiting} weeks are waiting for a decision. Approve or return them before weeks start on another day.`;
}
