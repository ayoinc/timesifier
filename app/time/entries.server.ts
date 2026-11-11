import { and, eq, isNull } from "drizzle-orm";

import type { OrganisationScope } from "~/db";
import { lockedDays } from "~/periods/locks.server";
import { findActiveProject } from "~/projects/projects.server";

import { dayOf } from "./calendar";

/**
 * Time entries: the rules every writer of them shares (docs/decisions.md
 * entry 25). A person has at most one running entry in an organisation, which
 * the partial unique index on `time_entries` holds whatever the code does.
 * Starting while one runs stops it and starts the next in one D1 batch, so the
 * end of one is the start of the other and neither happens alone. Times are
 * the server's clock; a time the browser claims is never used.
 */

/** The longest description an entry takes (TS-012a). */
export const ENTRY_DESCRIPTION_MAX_LENGTH = 500;

/** The entry of `userId` that is running in the organisation, or null. */
export async function runningEntry(scope: OrganisationScope, userId: string) {
	const [entry] = await scope.timeEntries.select(
		(e) => and(eq(e.userId, userId), isNull(e.endedAt)),
		{ limit: 1 },
	);
	return entry ?? null;
}

export interface StartTimer {
	userId: string;
	projectId: string;
	description: string | null;
	/** The person's zone, which decides the day the entry belongs to. */
	zone: string;
	/** The server's clock. */
	now: number;
}

/** Why a timer was not started: no active project of this organisation by that id, or a locked day. */
export type NotStarted = "no-project" | "locked";

/**
 * Starts a timer for `userId` on an active project of the organisation. A
 * running entry is stopped at the same instant in the same batch. Refused when
 * the project is archived or not the organisation's, or when the day the new
 * entry starts on or the day the running one started on is in a submitted or
 * approved period.
 */
export async function startTimer(scope: OrganisationScope, start: StartTimer) {
	const { userId, projectId, description, zone, now } = start;
	if (!(await findActiveProject(scope, projectId))) {
		return { ok: false as const, reason: "no-project" satisfies NotStarted };
	}
	const running = await runningEntry(scope, userId);
	const days = [dayOf(now, zone), ...(running ? [dayOf(running.startedAt, zone)] : [])];
	if ((await lockedDays(scope, userId, days)).size > 0) {
		return { ok: false as const, reason: "locked" satisfies NotStarted };
	}

	const at = new Date(now);
	const [stopped, [started]] = await scope.batch([
		scope.timeEntries.statements.update({ endedAt: at }, (e) =>
			and(eq(e.userId, userId), isNull(e.endedAt)),
		),
		scope.timeEntries.statements.insert({
			userId,
			projectId,
			description,
			startedAt: at,
			endedAt: null,
		}),
	]);
	if (!started) throw new Error("The new entry was not returned.");
	return { ok: true as const, started, stopped: stopped[0] ?? null };
}

/** Stops the running entry of `userId` at `now`, and returns it; null when nothing was running. */
export async function stopTimer(scope: OrganisationScope, userId: string, now: number) {
	const [stopped] = await scope.timeEntries.update({ endedAt: new Date(now) }, (e) =>
		and(eq(e.userId, userId), isNull(e.endedAt)),
	);
	return stopped ?? null;
}
