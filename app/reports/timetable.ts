import type { Day } from "~/time/calendar";

import type { Row } from "./report";

/**
 * A week of a report as a timetable (harvest-taste item 10, the weekly report
 * in docs/design-direction.md): a row for each project, a column for each
 * day, and a total at the end of every row and column. Every total is the sum
 * of the cells it closes, in whole seconds, so the timetable, the sheets under
 * it and the export agree.
 */

export interface TimetableRow {
	/** The project's id. */
	key: string;
	label: string;
	/** Seconds on each of the timetable's days, in their order. */
	cells: number[];
	total: number;
}

export interface Timetable {
	days: Day[];
	/** Projects by name. */
	rows: TimetableRow[];
	/** Seconds on each day, every project together. */
	dayTotals: number[];
	total: number;
}

/** The pieces of a report laid out by project and day. A piece outside `days` is left out. */
export function timetableOf(pieces: readonly Row[], days: readonly Day[]): Timetable {
	const column = new Map(days.map((day, index) => [day, index]));
	const rows = new Map<string, TimetableRow>();
	const dayTotals = days.map(() => 0);
	let total = 0;
	for (const piece of pieces) {
		const at = column.get(piece.day);
		if (at === undefined) continue;
		const { projectId, project } = piece.entry;
		const row = rows.get(projectId) ?? {
			key: projectId,
			label: project,
			cells: days.map(() => 0),
			total: 0,
		};
		row.cells[at] = (row.cells[at] ?? 0) + piece.minutes * 60;
		row.total += piece.minutes * 60;
		rows.set(projectId, row);
		dayTotals[at] = (dayTotals[at] ?? 0) + piece.minutes * 60;
		total += piece.minutes * 60;
	}
	return {
		days: [...days],
		rows: [...rows.values()].sort(
			(a, b) => a.label.localeCompare(b.label, "en") || (a.key < b.key ? -1 : 1),
		),
		dayTotals,
		total,
	};
}
