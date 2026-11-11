import { type Day, dayOf, instantAt } from "./calendar";

/** When the working day is taken to start for a day with no entries: 09:00 (the owner, 2026-11-11, TS-052). */
export const GRID_DAY_STARTS_AT_MINUTES = 9 * 60;

/** An entry as the rule below reads it. `endedAt` is null while it runs. */
export interface Span {
	startedAt: Date | number;
	endedAt: Date | number | null;
}

/**
 * When the entry made from hours typed into a cell of the week's grid starts
 * (TS-052, decided by the owner on 2026-11-11): when the last of the person's
 * entries that belong to `day` ends, or at 09:00 in `zone` on `day` when none
 * does. An entry belongs to the local day it starts in; a running one is taken
 * to end at `now`. The entry made lasts the hours typed.
 */
export function gridEntryStart(
	day: Day,
	zone: string,
	entries: readonly Span[],
	now: number,
): number {
	let latest: number | null = null;
	for (const entry of entries) {
		if (dayOf(entry.startedAt, zone) !== day) continue;
		const end = entry.endedAt === null ? now : Number(entry.endedAt);
		if (latest === null || end > latest) latest = end;
	}
	return latest ?? instantAt(day, GRID_DAY_STARTS_AT_MINUTES, zone);
}
