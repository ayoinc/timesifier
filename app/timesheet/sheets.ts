import { locksEntries, type PeriodDays, type PeriodStatus, periodAfter } from "~/periods/periods";
import type { Day } from "~/time/calendar";

/**
 * What the views of Timesheet add up (TS-013, TS-046, TS-052). Nothing here
 * reads the database or the clock: the loader passes the person's entries and
 * the time of the request, so a total is the same sum wherever it is worked
 * out. An entry belongs whole to its day, the local day it started in, stored
 * with it when it was tracked (decision 39), and a running entry counts up to
 * `now`.
 */

/** An entry as the sheets read it: times in milliseconds, `endedAt` null while it runs. */
export interface SheetEntry {
	id: string;
	projectId: string;
	description: string | null;
	startedAt: number;
	endedAt: number | null;
	/** Whether the entry is overtime rather than regular time (TS-095). */
	overtime: boolean;
	/** The day it belongs to, stored when it was tracked (TS-111). */
	day: Day;
}

/** How long `entry` has lasted by `now`. */
export function durationOf(entry: Pick<SheetEntry, "startedAt" | "endedAt">, now: number): number {
	return Math.max(0, (entry.endedAt ?? now) - entry.startedAt);
}

/** The sum of the entries' durations by `now`. */
export function totalOf(entries: readonly SheetEntry[], now: number): number {
	return entries.reduce((sum, entry) => sum + durationOf(entry, now), 0);
}

/** One project's time on one day of the week's grid. */
export interface GridCell {
	day: Day;
	/** The sum of the entries of that project that start on that day. */
	total: number;
	/** How many entries make it up. A cell of more than one is changed in the Day view. */
	entries: number;
	/** Whether one of them is running. Such a cell is changed in the Day view too. */
	running: boolean;
	/** The one entry behind the cell when there is exactly one, which typing hours changes. */
	entryId: string | null;
}

export interface GridRow {
	projectId: string;
	/** Whether the row is the project's overtime, rather than its regular time (TS-095). */
	overtime: boolean;
	cells: GridCell[];
	/** The project's total for the week: the sum of its cells. */
	total: number;
}

export interface WeekSheet {
	/** Each day's time, and how much of it is overtime. */
	days: { day: Day; total: number; overtime: number }[];
	/**
	 * One row per project and kind with time in the week, a project's overtime
	 * after its regular time, then each added row, in the order given.
	 */
	rows: GridRow[];
	total: number;
}

/**
 * The week's grid: a row for each project with time on `days`, in the order
 * of `projectOrder` (projects it does not name come last), then a row for
 * each of `addedRows` that has no time yet. A project with overtime has a
 * second row of it, after its regular time (TS-095): a cell is one project and
 * one kind. A day's total and the week's are sums of the cells.
 */
export function weekSheet(
	entries: readonly SheetEntry[],
	days: readonly Day[],
	now: number,
	{
		projectOrder = [],
		addedRows = [],
	}: { projectOrder?: readonly string[]; addedRows?: readonly string[] } = {},
): WeekSheet {
	const byRow = new Map<string, Map<Day, SheetEntry[]>>();
	const projectIds: string[] = [];
	for (const entry of entries) {
		const { day } = entry;
		if (!days.includes(day)) continue;
		const key = rowKey(entry.projectId, entry.overtime);
		let ofRow = byRow.get(key);
		if (!ofRow) {
			ofRow = new Map();
			byRow.set(key, ofRow);
		}
		ofRow.set(day, [...(ofRow.get(day) ?? []), entry]);
		if (!projectIds.includes(entry.projectId)) projectIds.push(entry.projectId);
	}

	const rank = (id: string) => {
		const at = projectOrder.indexOf(id);
		return at === -1 ? Number.MAX_SAFE_INTEGER : at;
	};
	projectIds.sort((a, b) => rank(a) - rank(b));
	// Each project's regular time, then its overtime, where it has each; an added row is regular time.
	const ordered: { projectId: string; overtime: boolean }[] = [];
	for (const projectId of projectIds) {
		for (const overtime of [false, true]) {
			if (byRow.has(rowKey(projectId, overtime))) ordered.push({ projectId, overtime });
		}
	}
	for (const projectId of addedRows) {
		if (!projectIds.includes(projectId)) ordered.push({ projectId, overtime: false });
	}

	const rows = ordered.map((row): GridRow => {
		const ofRow = byRow.get(rowKey(row.projectId, row.overtime));
		const cells = days.map((day): GridCell => {
			const inCell = ofRow?.get(day) ?? [];
			return {
				day,
				total: totalOf(inCell, now),
				entries: inCell.length,
				running: inCell.some((entry) => entry.endedAt === null),
				entryId: inCell.length === 1 ? (inCell[0]?.id ?? null) : null,
			};
		});
		return {
			projectId: row.projectId,
			overtime: row.overtime,
			cells,
			total: cells.reduce((sum, cell) => sum + cell.total, 0),
		};
	});

	const dayTotals = days.map((day, index) => {
		let total = 0;
		let overtime = 0;
		for (const row of rows) {
			const ms = row.cells[index]?.total ?? 0;
			total += ms;
			if (row.overtime) overtime += ms;
		}
		return { day, total, overtime };
	});
	return { days: dayTotals, rows, total: dayTotals.reduce((sum, each) => sum + each.total, 0) };
}

/** A row of the grid by its project and kind, as `data-row` names it. */
export function rowKey(projectId: string, overtime: boolean): string {
	return overtime ? `${projectId}:overtime` : projectId;
}

/** Whether a cell of the grid takes typed hours: one entry or none, not running, on a day not locked. */
export function isTypable(cell: GridCell, locked: boolean): boolean {
	return !locked && !cell.running && cell.entries <= 1;
}

/** What the Week view's header and History say a period is. */
export type PeriodState = "not-submitted" | "submitted" | "approved" | "returned";

export const PERIOD_STATE_LABELS: Record<PeriodState, string> = {
	"not-submitted": "Not submitted",
	submitted: "Submitted",
	approved: "Approved",
	returned: "Returned",
};

/** A period never submitted, or withdrawn, is not submitted. */
export function periodState(status: PeriodStatus | null): PeriodState {
	return status === null || status === "withdrawn" ? "not-submitted" : status;
}

/** Whether the person may change the entries of a period in `status`. */
export function isEditable(status: PeriodStatus | null): boolean {
	return !locksEntries(status);
}

/** How many periods History lists at most: a year of weeks. */
export const HISTORY_LENGTH = 53;

export interface HistoryRow extends PeriodDays {
	state: PeriodState;
	total: number;
	/** The reason given when it was returned, while it stands returned. */
	comment: string | null;
}

/**
 * Every period of the person from the earliest one with an entry or a
 * submission up to `current`, newest first, at most `HISTORY_LENGTH` of them,
 * each with its state and its total.
 */
export function historyRows(
	current: PeriodDays,
	periods: readonly (PeriodDays & { status: PeriodStatus; comment: string | null })[],
	entries: readonly SheetEntry[],
	now: number,
): HistoryRow[] {
	const earliestEntry = entries.reduce<Day | null>(
		(first, { day }) => (first === null || day < first ? day : first),
		null,
	);
	const earliestPeriod = periods.reduce<Day | null>(
		(first, period) => (first === null || period.startsOn < first ? period.startsOn : first),
		null,
	);
	const earliest = [earliestEntry, earliestPeriod, current.startsOn]
		.filter((day): day is Day => day !== null)
		.sort()[0] as Day;

	const rows: HistoryRow[] = [];
	for (
		let period = current;
		period.endsOn >= earliest && rows.length < HISTORY_LENGTH;
		period = periodAfter(period, -1)
	) {
		const row = periods.find((each) => each.startsOn === period.startsOn) ?? null;
		const inPeriod = entries.filter(({ day }) => period.startsOn <= day && day <= period.endsOn);
		rows.push({
			...period,
			state: periodState(row?.status ?? null),
			total: totalOf(inPeriod, now),
			comment: row?.status === "returned" ? row.comment : null,
		});
	}
	return rows;
}
