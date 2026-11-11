import { and, eq, gte, lt } from "drizzle-orm";

import { changes, recordStatement } from "~/activity/activity.server";
import { type OrganisationScope, uuidv7 } from "~/db";
import { lockedDays } from "~/periods/locks.server";
import { findActiveProject } from "~/projects/projects.server";

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
 * before and after the change (`lockedDays`). Each change goes in one batch
 * with its row in the activity log.
 */

/** Why a change was not made. */
export type NotWritten =
	| "no-project"
	| "locked"
	| "not-found"
	| "running"
	| "ends-before-start"
	| "in-day-view";

export interface Span {
	projectId: string;
	description: string | null;
	startedAt: number;
	endedAt: number;
}

const refuse = (reason: NotWritten) => ({ ok: false as const, reason });

/** What the activity log records of an entry. */
const ENTRY_FIELDS = ["projectId", "description", "startedAt", "endedAt"] as const;

/** The entry `id` of `userId`, as the activity log names it. */
const subject = (userId: string, id: string) =>
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
 * since keeps it. A running entry is changed by the timer, not here.
 */
export async function editEntry(
	scope: OrganisationScope,
	userId: string,
	zone: string,
	id: string,
	span: Span,
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
	const changed = {
		projectId: span.projectId,
		description: span.description,
		startedAt: new Date(span.startedAt),
		endedAt: new Date(span.endedAt),
	};
	await scope.batch([
		scope.timeEntries.statements.update(changed, (e) => and(eq(e.id, id), eq(e.userId, userId))),
		recordStatement(
			scope,
			userId,
			"time_entry.updated",
			subject(userId, id),
			changes(entry, changed, ENTRY_FIELDS),
		),
	]);
	return { ok: true as const };
}

/** Deletes an entry of `userId` that has ended. */
export async function deleteEntry(
	scope: OrganisationScope,
	userId: string,
	zone: string,
	id: string,
) {
	const entry = await ownEntry(scope, userId, id);
	if (!entry) return refuse("not-found");
	if (entry.endedAt === null) return refuse("running");
	if ((await lockedDays(scope, userId, [dayOf(entry.startedAt, zone)])).size > 0) {
		return refuse("locked");
	}
	await scope.batch([
		scope.timeEntries.statements.delete((e) => and(eq(e.id, id), eq(e.userId, userId))),
		recordStatement(
			scope,
			userId,
			"time_entry.deleted",
			subject(userId, id),
			changes(entry, null, ENTRY_FIELDS),
		),
	]);
	return { ok: true as const };
}

/** The entries of `userId` that belong to `day` in `zone`: those that start on it. */
function entriesOfDay(scope: OrganisationScope, userId: string, day: Day, zone: string) {
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
export async function addHours(scope: OrganisationScope, userId: string, hours: DayHours) {
	const { projectId, description, day, minutes, zone, now } = hours;
	if (!(await findActiveProject(scope, projectId))) return refuse("no-project");
	if ((await lockedDays(scope, userId, [day])).size > 0) return refuse("locked");
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
		description,
		startedAt: new Date(placed.start),
		endedAt: new Date(placed.start + minutes * 60_000),
	};
	const [[entry]] = await scope.batch([
		scope.timeEntries.statements.insert(added),
		recordStatement(
			scope,
			userId,
			"time_entry.created",
			subject(userId, added.id),
			changes(null, added, ENTRY_FIELDS),
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
		const added = { id: uuidv7(), userId, projectId, description: null, ...span };
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
