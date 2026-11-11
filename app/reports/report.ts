import { bounds, type Day, dayOf } from "~/time/calendar";

import type { Grouping } from "./choices";
import type { ReportDays } from "./query";

/**
 * The arithmetic of a report (TS-014a), apart from the database, so the same
 * code makes the page and the export and a property test can hold it.
 *
 * A report follows the rule the Timesheet and Team follow (docs/decisions.md
 * entry 26): an entry belongs whole to the local day it starts in, in the zone
 * of the person looking. A report holds the entries that start in its range of
 * days, each counted whole on its start day, never cut at midnight; a running
 * entry is counted up to the time of the request (TS-091, W04 and W33).
 *
 * Every figure is whole minutes (W07): an entry's length is floored to the
 * minute once, and every total is the sum of those minutes, so a total always
 * equals the sum of the rows written above it.
 */

/** One time entry with the names a report shows, as the database holds it. */
export interface ReportEntry {
	id: string;
	userId: string;
	person: string;
	projectId: string;
	project: string;
	clientId: string | null;
	client: string | null;
	description: string | null;
	startedAt: number;
	/** Null while it runs. */
	endedAt: number | null;
}

/** An entry as a report counts it: on the day it starts, for its whole length in minutes. */
export interface Row {
	entry: ReportEntry;
	/** The local day it starts in. */
	day: Day;
	start: number;
	/** When it ended, or the time of the request while it runs. */
	end: number;
	/** Whether it is still running, so `end` is the time of the request. */
	running: boolean;
	/** Its length, floored to whole minutes. */
	minutes: number;
}

const MINUTE = 60_000;

/**
 * `entry` as a report of `range` in `zone` counts it, or null when it starts
 * outside the range. A running entry ends at `now`.
 */
export function rowOf(
	entry: ReportEntry,
	range: ReportDays,
	zone: string,
	now: number,
): Row | null {
	const { from, to } = bounds(range.first, range.last, zone);
	if (entry.startedAt < from || entry.startedAt >= to) return null;
	const running = entry.endedAt === null;
	const end = entry.endedAt ?? Math.max(now, entry.startedAt);
	return {
		entry,
		day: dayOf(entry.startedAt, zone),
		start: entry.startedAt,
		end,
		running,
		minutes: Math.max(0, Math.floor((end - entry.startedAt) / MINUTE)),
	};
}

/** The order rows are listed in: by when they start, then by entry. */
export function byStart(a: Row, b: Row): number {
	return a.start - b.start || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0);
}

/** One line of a report: what is grouped on, and its time. */
export interface GroupTotal {
	/** A project's or a client's id, the empty string for no client, or a day. */
	key: string;
	/** The project's or client's name, or the day; null for no client. */
	label: string | null;
	minutes: number;
}

export interface Totals {
	groups: GroupTotal[];
	minutes: number;
}

/**
 * The rows' time by `grouping`, and in all, in whole minutes. Projects and
 * clients are in the order of their names, the time with no client last; days
 * in their order. A group is listed only when it has a row.
 */
export function totalsOf(rows: readonly Row[], grouping: Grouping): Totals {
	const groups = new Map<string, GroupTotal>();
	let minutes = 0;
	for (const row of rows) {
		const { entry } = row;
		const [key, label] =
			grouping === "project"
				? [entry.projectId, entry.project]
				: grouping === "client"
					? [entry.clientId ?? "", entry.client]
					: [row.day, row.day];
		const group = groups.get(key) ?? { key, label, minutes: 0 };
		group.minutes += row.minutes;
		groups.set(key, group);
		minutes += row.minutes;
	}
	const ordered = [...groups.values()].sort((a, b) => {
		if (a.label === null || b.label === null) return a.label === null ? 1 : -1;
		if (grouping === "day") return a.key < b.key ? -1 : 1;
		return a.label.localeCompare(b.label, "en") || (a.key < b.key ? -1 : 1);
	});
	return { groups: ordered, minutes };
}
