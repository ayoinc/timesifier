import { addDays, type Day, dayOf, instantAt, startOfDay } from "./calendar";

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

/** Where an entry of typed hours goes on its day, or how much of the day is left when it does not fit. */
export type Placement = { fits: true; start: number } | { fits: false; minutesLeft: number };

/**
 * Places an entry of `minutes` that should start at `start` within `day` in
 * `zone` (TS-091, W08): typed hours never carry an entry past the end of its
 * day or past `now`. It keeps `start` when it ends by both; else it starts
 * earlier, so it ends at the first of the two, while it still starts on the
 * day. When the day, from its start to the first of its end and now, is
 * shorter than `minutes`, it does not fit, and the whole minutes the day has
 * are said.
 *
 * With `keepStart`, the start is the one the person chose (a slot of the
 * calendar, TS-062) and never moves: the entry fits only if it ends by both
 * from there, and the minutes left are counted from it.
 */
export function placeOnDay(
	day: Day,
	zone: string,
	start: number,
	minutes: number,
	now: number,
	{ keepStart = false }: { keepStart?: boolean } = {},
): Placement {
	const length = minutes * 60_000;
	const limit = Math.min(startOfDay(addDays(day, 1), zone), now);
	if (start + length <= limit) return { fits: true, start };
	const from = keepStart ? start : startOfDay(day, zone);
	if (!keepStart && limit - length >= from) return { fits: true, start: limit - length };
	return { fits: false, minutesLeft: Math.max(0, Math.floor((limit - from) / 60_000)) };
}
