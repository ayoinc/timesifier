import { and, eq, gte, lt } from "drizzle-orm";

import type { OrganisationScope } from "~/db";
import { lockedDays } from "~/periods/locks.server";
import { findActiveProject } from "~/projects/projects.server";

import { bounds, type Day, dayOf } from "./calendar";
import { gridEntryStart } from "./grid";

/**
 * Entries a person writes by hand: hours tracked on a day from the Day view's
 * "Track time" (TS-056), an entry changed or deleted in the Day view
 * (TS-012b), and the hours of one cell of the week's grid (TS-052). Each
 * acts on the caller's own entries alone: an entry of anybody else, in this
 * organisation or another, is not found, whatever the caller's role
 * (`mayChangeTimeOf`). A day in a submitted or approved period is refused,
 * before and after the change (`lockedDays`).
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
	await scope.timeEntries.update(
		{
			projectId: span.projectId,
			description: span.description,
			startedAt: new Date(span.startedAt),
			endedAt: new Date(span.endedAt),
		},
		(e) => and(eq(e.id, id), eq(e.userId, userId)),
	);
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
	await scope.timeEntries.delete((e) => and(eq(e.id, id), eq(e.userId, userId)));
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

/**
 * Adds one entry of `minutes` on `day` for `userId`, on an active project
 * (TS-056): it starts at `startedAt` when given, or where `gridEntryStart`
 * says, as an hour typed into an empty cell of the week's grid does, and
 * lasts the time typed.
 */
export async function addHours(scope: OrganisationScope, userId: string, hours: DayHours) {
	const { projectId, description, day, minutes, zone, now } = hours;
	if (!(await findActiveProject(scope, projectId))) return refuse("no-project");
	if ((await lockedDays(scope, userId, [day])).size > 0) return refuse("locked");
	const startedAt =
		hours.startedAt ?? gridEntryStart(day, zone, await entriesOfDay(scope, userId, day, zone), now);
	const [added] = await scope.timeEntries.insert({
		userId,
		projectId,
		description,
		startedAt: new Date(startedAt),
		endedAt: new Date(startedAt + minutes * 60_000),
	});
	return { ok: true as const, entry: added };
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
 * entry has that entry's end moved; 0 deletes it. A cell of more than one
 * entry, or of a running one, is changed in the Day view.
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
	const length = minutes * 60_000;

	if (entry) {
		if (minutes === 0) {
			await scope.timeEntries.delete((e) => and(eq(e.id, entry.id), eq(e.userId, userId)));
		} else {
			await scope.timeEntries.update(
				{ endedAt: new Date(entry.startedAt.getTime() + length) },
				(e) => and(eq(e.id, entry.id), eq(e.userId, userId)),
			);
		}
		return { ok: true as const };
	}
	if (minutes === 0) return { ok: true as const };
	if (!(await findActiveProject(scope, projectId))) return refuse("no-project");
	const startedAt = gridEntryStart(day, zone, ofDay, now);
	await scope.timeEntries.insert({
		userId,
		projectId,
		description: null,
		startedAt: new Date(startedAt),
		endedAt: new Date(startedAt + length),
	});
	return { ok: true as const };
}
