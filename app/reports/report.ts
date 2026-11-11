import { addDays, bounds, type Day, dayOf, startOfDay } from "~/time/calendar";

import type { Grouping } from "./choices";
import type { ReportDays } from "./query";

/**
 * The arithmetic of a report (TS-014a), apart from the database, so the same
 * code makes the page and the export and a property test can hold it.
 *
 * A report covers whole local days of the organisation's zone. Unlike the
 * timesheet, where an entry belongs whole to the day it starts in, a report
 * cuts an entry at each local midnight and counts each piece in its own day,
 * and leaves out what falls outside the range: an entry from 23:30 to 00:30 is
 * half an hour on each day. A running entry is counted up to the time of the
 * request. Lengths are whole seconds: a piece runs from the second its start is
 * in to the second its end is in, so the pieces of one entry add up to the
 * entry, however it is cut.
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

/** The part of an entry that falls in one local day of the range. */
export interface Piece {
	entry: ReportEntry;
	day: Day;
	/** Instants on a whole second. */
	start: number;
	end: number;
	/** Whether this piece ends at the time of the request because its entry is still running. */
	running: boolean;
	seconds: number;
}

const SECOND = 1000;

/** The instant at the start of the second `instant` is in. */
const wholeSecond = (instant: number) => Math.floor(instant / SECOND) * SECOND;

/**
 * The pieces of `entry` in the days of `range` in `zone`, one for each local
 * day it covers, in order. A running entry ends at `now`. An entry of no length
 * is one piece of no length on the day it starts, when that day is in the range.
 */
export function piecesOf(
	entry: ReportEntry,
	range: ReportDays,
	zone: string,
	now: number,
): Piece[] {
	const { from, to } = bounds(range.first, range.last, zone);
	const running = entry.endedAt === null;
	const ended = wholeSecond(entry.endedAt ?? Math.max(now, entry.startedAt));
	let start = wholeSecond(Math.max(entry.startedAt, from));
	const end = Math.min(ended, to);

	if (start === end && start === wholeSecond(entry.startedAt) && start < to) {
		return [{ entry, day: dayOf(start, zone), start, end, running, seconds: 0 }];
	}
	const pieces: Piece[] = [];
	let day = dayOf(start, zone);
	while (start < end) {
		const next = startOfDay(addDays(day, 1), zone);
		const pieceEnd = Math.min(next, end);
		pieces.push({
			entry,
			day,
			start,
			end: pieceEnd,
			running: running && pieceEnd === ended,
			seconds: (pieceEnd - start) / SECOND,
		});
		start = pieceEnd;
		day = addDays(day, 1);
	}
	return pieces;
}

/** The order pieces are listed in: by when they start, then by entry. */
export function byStart(a: Piece, b: Piece): number {
	return a.start - b.start || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0);
}

/** One line of a report: what is grouped on, and its time. */
export interface GroupTotal {
	/** A project's or a client's id, the empty string for no client, or a day. */
	key: string;
	/** The project's or client's name, or the day; null for no client. */
	label: string | null;
	seconds: number;
}

export interface Totals {
	groups: GroupTotal[];
	seconds: number;
}

/**
 * The pieces' time by `grouping`, and in all. Projects and clients are in the
 * order of their names, the time with no client last; days in their order. A
 * group is listed only when it has a piece.
 */
export function totalsOf(pieces: readonly Piece[], grouping: Grouping): Totals {
	const groups = new Map<string, GroupTotal>();
	let seconds = 0;
	for (const piece of pieces) {
		const { entry } = piece;
		const [key, label] =
			grouping === "project"
				? [entry.projectId, entry.project]
				: grouping === "client"
					? [entry.clientId ?? "", entry.client]
					: [piece.day, piece.day];
		const group = groups.get(key) ?? { key, label, seconds: 0 };
		group.seconds += piece.seconds;
		groups.set(key, group);
		seconds += piece.seconds;
	}
	const ordered = [...groups.values()].sort((a, b) => {
		if (a.label === null || b.label === null) return a.label === null ? 1 : -1;
		if (grouping === "day") return a.key < b.key ? -1 : 1;
		return a.label.localeCompare(b.label, "en") || (a.key < b.key ? -1 : 1);
	});
	return { groups: ordered, seconds };
}
