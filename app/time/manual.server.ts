import { and, eq, gte, lt } from "drizzle-orm";

import type { ActivitySource } from "~/activity/actions";
import { changes, recordStatement } from "~/activity/activity.server";
import { type OrganisationScope, uuidv7 } from "~/db";
import { refusalOf } from "~/leave/rules.server";
import { invoicedIds } from "~/locks/locks.server";
import { lockedDays } from "~/periods/locks.server";
import { findActiveProject } from "~/projects/projects.server";
import { entryTagStatements, tagsAllowed, tagsOfEntries } from "~/tags/tags.server";
import { entryTaskOf } from "~/tasks/tasks.server";

import { bounds, type Day, dayOf } from "./calendar";
import { formatDuration } from "./format";
import { gridEntryStart, placeOnDay } from "./grid";

/**
 * Entries a person writes by hand: hours tracked on a day from the Day view's
 * "Track time" (TS-056), an entry changed or deleted in the Day view
 * (TS-012b), and the hours of one cell of the week's grid (TS-052). Each
 * acts on the caller's own entries alone: an entry of anybody else, in this
 * organisation or another, is not found, whatever the caller's role
 * (`mayChangeTimeOf`). A day in a submitted or approved period is refused,
 * before and after the change (`lockedDays`), and so is time a day does not
 * take: a public holiday, whole-day leave, or more than is left of the day's
 * limit (TS-090, `refusalOf`). Each change goes in one batch with its row in
 * the activity log.
 */

/** Why a change was not made. */
export type NotWritten =
	| "no-project"
	| "locked"
	| "not-found"
	| "running"
	| "ends-before-start"
	| "in-day-view"
	| "limit"
	| "invoiced"
	| "no-task"
	| "no-tag";

export interface Span {
	projectId: string;
	description: string | null;
	startedAt: number;
	endedAt: number;
	/** The task chosen; left out, the entry keeps its own, or a new project's first (TS-066). */
	taskId?: string;
	/** The entry's tags; left out, they stay as they are (TS-085). */
	tagIds?: readonly string[];
}

export const refuse = (reason: Exclude<NotWritten, "limit">) => ({ ok: false as const, reason });
/** A change the day's limit does not take, with what to tell the person (TS-090). */
export const limited = (message: string) => ({
	ok: false as const,
	reason: "limit" as const,
	message,
});

/** What the activity log records of an entry. */
export const ENTRY_FIELDS = [
	"projectId",
	"taskId",
	"billable",
	"description",
	"startedAt",
	"endedAt",
] as const;

/** The entry `id` of `userId`, as the activity log names it. */
export const subject = (userId: string, id: string) =>
	({ type: "time_entry", id, ownerId: userId }) as const;

/** The caller's entry by id, or null: another person's is none. */
async function ownEntry(scope: OrganisationScope, userId: string, id: string) {
	const [entry] = await scope.timeEntries.select((e) => and(eq(e.id, id), eq(e.userId, userId)), {
		limit: 1,
	});
	return entry ?? null;
}

/**
 * Changes an entry of `userId` that has ended. The project must be active,
 * unless it is the one the entry already has: an entry of a project archived
 * since keeps it. A running entry is changed by the timer, not here. Time
 * may always be taken off a day, or moved off it; what it adds to a day must
 * fit in the day's limit.
 */
export async function editEntry(
	scope: OrganisationScope,
	userId: string,
	zone: string,
	id: string,
	span: Span,
	now: number,
	source: ActivitySource = "web",
) {
	const entry = await ownEntry(scope, userId, id);
	if (!entry) return refuse("not-found");
	if (entry.endedAt === null) return refuse("running");
	if (span.endedAt <= span.startedAt) return refuse("ends-before-start");
	if (span.projectId !== entry.projectId && !(await findActiveProject(scope, span.projectId))) {
		return refuse("no-project");
	}
	const days = [dayOf(entry.startedAt, zone), dayOf(span.startedAt, zone)];
	if ((await lockedDays(scope, userId, days)).size > 0) return refuse("locked");
	if ((await invoicedIds(scope, "time_entry", [id])).size > 0) return refuse("invoiced");
	const over = await refusalOf(scope, userId, zone, now, {
		day: dayOf(span.startedAt, zone),
		replaces: id,
		afterMs: span.endedAt - span.startedAt,
	});
	if (over) return limited(over);
	const task = await entryTaskOf(
		scope,
		span.projectId,
		span.taskId,
		span.projectId === entry.projectId ? entry.taskId : null,
	);
	if (!task.ok) return refuse("no-task");
	const currentTags = (await tagsOfEntries(scope, [id])).get(id) ?? [];
	if (span.tagIds && !(await tagsAllowed(scope, currentTags, span.tagIds))) return refuse("no-tag");
	const changed = {
		projectId: span.projectId,
		taskId: task.taskId,
		billable: task.billable,
		description: span.description,
		startedAt: new Date(span.startedAt),
		endedAt: new Date(span.endedAt),
	};
	await scope.batch([
		scope.timeEntries.statements.update(changed, (e) => and(eq(e.id, id), eq(e.userId, userId))),
		...(span.tagIds ? entryTagStatements(scope, id, currentTags, span.tagIds) : []),
		recordStatement(
			scope,
			userId,
			"time_entry.updated",
			subject(userId, id),
			changes(entry, changed, ENTRY_FIELDS),
			source,
		),
	]);
	return { ok: true as const };
}

/** An entry as it was when it was deleted: what "Undo" puts back (taste HT-A). */
export interface DeletedEntry {
	id: string;
	projectId: string;
	taskId: string | null;
	billable: boolean;
	description: string | null;
	startedAt: number;
	endedAt: number;
	tagIds: string[];
}

/** Deletes an entry of `userId` that has ended, and answers what it was, so it can be put back. */
export async function deleteEntry(
	scope: OrganisationScope,
	userId: string,
	zone: string,
	id: string,
	source: ActivitySource = "web",
) {
	const entry = await ownEntry(scope, userId, id);
	if (!entry) return refuse("not-found");
	if (entry.endedAt === null) return refuse("running");
	if ((await lockedDays(scope, userId, [dayOf(entry.startedAt, zone)])).size > 0) {
		return refuse("locked");
	}
	if ((await invoicedIds(scope, "time_entry", [id])).size > 0) return refuse("invoiced");
	const tagIds = (await tagsOfEntries(scope, [id])).get(id) ?? [];
	await scope.batch([
		scope.timeEntries.statements.delete((e) => and(eq(e.id, id), eq(e.userId, userId))),
		recordStatement(
			scope,
			userId,
			"time_entry.deleted",
			subject(userId, id),
			changes(entry, null, ENTRY_FIELDS),
			source,
		),
	]);
	const deleted: DeletedEntry = {
		id,
		projectId: entry.projectId,
		taskId: entry.taskId,
		billable: entry.billable,
		description: entry.description,
		startedAt: entry.startedAt.getTime(),
		endedAt: entry.endedAt.getTime(),
		tagIds,
	};
	return { ok: true as const, deleted };
}

/**
 * Puts back an entry of `userId` deleted moments ago, with its id, times,
 * task and tags (taste HT-A, "Undo"). The day must still take it: a day
 * locked since, or with no room left under its limit, refuses it as any new
 * time is refused; so does a project archived since. An entry with that id
 * already there is not written twice.
 */
export async function restoreEntry(
	scope: OrganisationScope,
	userId: string,
	zone: string,
	entry: DeletedEntry,
	now: number,
) {
	if (await ownEntry(scope, userId, entry.id)) return { ok: true as const };
	if (!(await findActiveProject(scope, entry.projectId))) return refuse("no-project");
	const day = dayOf(entry.startedAt, zone);
	if ((await lockedDays(scope, userId, [day])).size > 0) return refuse("locked");
	const over = await refusalOf(scope, userId, zone, now, {
		day,
		replaces: null,
		afterMs: entry.endedAt - entry.startedAt,
	});
	if (over) return limited(over);
	const restored = {
		id: entry.id,
		userId,
		projectId: entry.projectId,
		taskId: entry.taskId,
		billable: entry.billable,
		description: entry.description,
		startedAt: new Date(entry.startedAt),
		endedAt: new Date(entry.endedAt),
	};
	const kept = entry.tagIds.length > 0 && (await tagsAllowed(scope, [], entry.tagIds));
	await scope.batch([
		scope.timeEntries.statements.insert(restored),
		...entryTagStatements(scope, entry.id, [], kept ? entry.tagIds : []),
		recordStatement(
			scope,
			userId,
			"time_entry.created",
			subject(userId, entry.id),
			changes(null, restored, ENTRY_FIELDS),
		),
	]);
	return { ok: true as const };
}

/** The entries of `userId` that belong to `day` in `zone`: those that start on it. */
export function entriesOfDay(scope: OrganisationScope, userId: string, day: Day, zone: string) {
	const { from, to } = bounds(day, day, zone);
	return scope.timeEntries.select((e) =>
		and(eq(e.userId, userId), gte(e.startedAt, new Date(from)), lt(e.startedAt, new Date(to))),
	);
}

export interface DayHours {
	projectId: string;
	description: string | null;
	day: Day;
	/** Whole minutes, more than none. */
	minutes: number;
	/** When it starts, an instant on `day`, where a slot of the calendar was chosen (TS-062); else `gridEntryStart` places it. */
	startedAt?: number;
	zone: string;
	/** The server's clock. */
	now: number;
	/** The task chosen; left out, the project's first active task (TS-066). */
	taskId?: string;
	/** The entry's tags (TS-085). */
	tagIds?: readonly string[];
}

/** The refusal of hours a day has no room for, saying what it has left (TS-091, W08). */
const dayFull = (minutesLeft: number) => ({
	ok: false as const,
	reason: "day-full" as const,
	message: `This day has only ${formatDuration(minutesLeft * 60)} left`,
});

/**
 * Adds one entry of `minutes` on `day` for `userId`, on an active project
 * (TS-056): it starts at `startedAt` when given, or where `gridEntryStart`
 * says, as an hour typed into an empty cell of the week's grid does, and
 * lasts the time typed. It is placed within its day by `placeOnDay` (TS-091,
 * W08); a start the person chose is kept, so the hours must fit after it.
 */
export async function addHours(
	scope: OrganisationScope,
	userId: string,
	hours: DayHours,
	source: ActivitySource = "web",
) {
	const { projectId, description, day, minutes, zone, now } = hours;
	if (!(await findActiveProject(scope, projectId))) return refuse("no-project");
	if ((await lockedDays(scope, userId, [day])).size > 0) return refuse("locked");
	const over = await refusalOf(scope, userId, zone, now, {
		day,
		replaces: null,
		afterMs: minutes * 60_000,
	});
	if (over) return limited(over);
	const task = await entryTaskOf(scope, projectId, hours.taskId);
	if (!task.ok) return refuse("no-task");
	if (hours.tagIds && !(await tagsAllowed(scope, [], hours.tagIds))) return refuse("no-tag");
	const wanted =
		hours.startedAt ?? gridEntryStart(day, zone, await entriesOfDay(scope, userId, day, zone), now);
	const placed = placeOnDay(day, zone, wanted, minutes, now, {
		keepStart: hours.startedAt !== undefined,
	});
	if (!placed.fits) return dayFull(placed.minutesLeft);
	const added = {
		id: uuidv7(),
		userId,
		projectId,
		taskId: task.taskId,
		billable: task.billable,
		description,
		startedAt: new Date(placed.start),
		endedAt: new Date(placed.start + minutes * 60_000),
	};
	const [[entry]] = await scope.batch([
		scope.timeEntries.statements.insert(added),
		...entryTagStatements(scope, added.id, [], hours.tagIds ?? []),
		recordStatement(
			scope,
			userId,
			"time_entry.created",
			subject(userId, added.id),
			changes(null, added, ENTRY_FIELDS),
			source,
		),
	]);
	return { ok: true as const, entry };
}

export interface CellHours {
	projectId: string;
	day: Day;
	/** Whole minutes; 0 removes the cell's time. */
	minutes: number;
	zone: string;
	/** The server's clock. */
	now: number;
}

/**
 * Sets the time of one project on one day to `minutes` (TS-052). A cell with
 * no entry gains one, which starts where `gridEntryStart` says; a cell of one
 * entry keeps its start and has its end moved; 0 deletes it. A cell of more
 * than one entry, or of a running one, is changed in the Day view. Either way
 * the entry is placed within its day by `placeOnDay` (TS-091, W08): it never
 * ends past the end of the day or past now, and a day without room for the
 * hours is refused, saying what it has left.
 */
export async function setCellHours(scope: OrganisationScope, userId: string, cell: CellHours) {
	const { projectId, day, minutes, zone, now } = cell;
	if ((await lockedDays(scope, userId, [day])).size > 0) return refuse("locked");

	const ofDay = await entriesOfDay(scope, userId, day, zone);
	const inCell = ofDay.filter((entry) => entry.projectId === projectId);
	if (inCell.length > 1 || inCell.some((entry) => entry.endedAt === null)) {
		return refuse("in-day-view");
	}
	const [entry] = inCell;
	if (entry && (await invoicedIds(scope, "time_entry", [entry.id])).size > 0) {
		return refuse("invoiced");
	}
	const over = await refusalOf(scope, userId, zone, now, {
		day,
		replaces: entry?.id ?? null,
		afterMs: minutes * 60_000,
	});
	if (over) return limited(over);

	if (minutes === 0) {
		if (entry) {
			await scope.batch([
				scope.timeEntries.statements.delete((e) => and(eq(e.id, entry.id), eq(e.userId, userId))),
				recordStatement(
					scope,
					userId,
					"time_entry.deleted",
					subject(userId, entry.id),
					changes(entry, null, ENTRY_FIELDS),
				),
			]);
		}
		return { ok: true as const };
	}
	if (!entry && !(await findActiveProject(scope, projectId))) return refuse("no-project");

	const wanted = entry ? entry.startedAt.getTime() : gridEntryStart(day, zone, ofDay, now);
	const placed = placeOnDay(day, zone, wanted, minutes, now);
	if (!placed.fits) return dayFull(placed.minutesLeft);
	const span = {
		startedAt: new Date(placed.start),
		endedAt: new Date(placed.start + minutes * 60_000),
	};
	if (entry) {
		await scope.batch([
			scope.timeEntries.statements.update(span, (e) =>
				and(eq(e.id, entry.id), eq(e.userId, userId)),
			),
			recordStatement(
				scope,
				userId,
				"time_entry.updated",
				subject(userId, entry.id),
				changes(entry, span, ["startedAt", "endedAt"]),
			),
		]);
	} else {
		// A cell's entry has the project's first active task, as Track time gives one by default.
		const task = await entryTaskOf(scope, projectId, undefined);
		if (!task.ok) return refuse("no-task");
		const added = {
			id: uuidv7(),
			userId,
			projectId,
			taskId: task.taskId,
			billable: task.billable,
			description: null,
			...span,
		};
		await scope.batch([
			scope.timeEntries.statements.insert(added),
			recordStatement(
				scope,
				userId,
				"time_entry.created",
				subject(userId, added.id),
				changes(null, added, ENTRY_FIELDS),
			),
		]);
	}
	return { ok: true as const };
}
