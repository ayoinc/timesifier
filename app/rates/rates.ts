import * as z from "zod";

import type { Day } from "~/time/calendar";

/**
 * Hourly rates (TS-064, B5, B6). A rate is a `rates` row: which ids it has set
 * says what it applies to, and `effective_from` says from which local day. A
 * rate change never re-prices earlier work, because an entry is priced at the
 * rate in force on its own local date.
 */

/** A billable rate is what the client is charged; a cost rate is what the person costs. */
export const RateKind = z.enum(["billable", "cost"]);
export type RateKind = z.infer<typeof RateKind>;

/** A rate as `rates` holds it. `amountMinor` is per hour, in `currency`'s minor units. */
export interface RateRow {
	kind: RateKind;
	userId: string | null;
	projectId: string | null;
	taskId: string | null;
	amountMinor: number;
	currency: string;
	effectiveFrom: Day;
}

/**
 * What a rate applies to, by the ids it has set: a task on a project, a task
 * anywhere (its default), a person on a project, a project, a person anywhere
 * (their default), or the organisation's default.
 */
export type RateLevel =
	| "project-task"
	| "task"
	| "project-person"
	| "project"
	| "person"
	| "organisation";

/** The levels from the most particular to the least: the first that has a rate wins. */
export const RATE_PRECEDENCE: readonly RateLevel[] = [
	"project-task",
	"task",
	"project-person",
	"project",
	"person",
	"organisation",
];

/**
 * The level of `row`, from the ids it has set. A rate for a person and a task
 * at once does not exist (the table refuses it), so it is an error here too.
 */
export function rateLevel(row: Pick<RateRow, "userId" | "projectId" | "taskId">): RateLevel {
	const { userId, projectId, taskId } = row;
	if (userId !== null && taskId !== null) {
		throw new RangeError("A rate cannot be for a person and a task at once");
	}
	if (taskId !== null) return projectId !== null ? "project-task" : "task";
	if (userId !== null) return projectId !== null ? "project-person" : "person";
	return projectId !== null ? "project" : "organisation";
}

/** What a rate is wanted for: work of `userId` on `projectId`'s `taskId`, on the local day `on`. */
export interface RateQuery {
	kind: RateKind;
	userId: string | null;
	projectId: string | null;
	taskId: string | null;
	on: Day;
}

/** Whether `row`, at `level`, applies to the work `query` describes. */
function applies(row: RateRow, level: RateLevel, query: RateQuery): boolean {
	switch (level) {
		case "project-task":
			return row.projectId === query.projectId && row.taskId === query.taskId;
		case "task":
			return row.taskId === query.taskId;
		case "project-person":
			return row.projectId === query.projectId && row.userId === query.userId;
		case "project":
			return row.projectId === query.projectId;
		case "person":
			return row.userId === query.userId;
		case "organisation":
			return true;
	}
}

/**
 * The rate of `query.kind` in force for some work, or null when there is none:
 * a missing rate, which counts 0 in totals and is shown as such (B5).
 *
 * The levels are tried in `RATE_PRECEDENCE` order. At each level the rate in
 * force is the one with the latest `effectiveFrom` on or before `on`; a level
 * whose rates all start later has none in force, and the next level is tried.
 * A level whose ids the query lacks (no task, say) is skipped.
 *
 * The project's rate mode (project, person or task) is the caller's: it
 * decides which ids it passes, so a project billed by project rate is asked
 * with no task and no person.
 */
export function resolveRate(rates: readonly RateRow[], query: RateQuery): RateRow | null {
	const byLevel = new Map<RateLevel, RateRow>();
	for (const row of rates) {
		if (row.kind !== query.kind || row.effectiveFrom > query.on) continue;
		const level = rateLevel(row);
		if (!applies(row, level, query)) continue;
		const held = byLevel.get(level);
		if (held === undefined || row.effectiveFrom > held.effectiveFrom) byLevel.set(level, row);
	}
	for (const level of RATE_PRECEDENCE) {
		const row = byLevel.get(level);
		if (row !== undefined) return row;
	}
	return null;
}
