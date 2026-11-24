import { hours } from "./words";

// Team › This week as a capacity table (TS-125, S2-08): each person's logged
// time against what their week expects of them, said in words, and the orders
// the table can be read in. Nothing here runs only on the server.

/** The query that orders This week: `?sort=remaining`. Without it the list is by name. */
export const SORT_PARAM = "sort";

/** The orders This week can be read in, by name first: the order without a `?sort=`. */
export const CAPACITY_SORTS = ["name", "logged", "share", "remaining"] as const;
export type CapacitySort = (typeof CAPACITY_SORTS)[number];

/** Each order as the Sort field offers it. */
export const SORT_LABELS: Record<CapacitySort, string> = {
	name: "Name",
	logged: "Most logged",
	share: "Most of capacity",
	remaining: "Most remaining",
};

/** The order an address asks for, by name when it asks for none it knows. */
export function capacitySortIn(search: URLSearchParams): CapacitySort {
	const asked = search.get(SORT_PARAM);
	return CAPACITY_SORTS.find((sort) => sort === asked && sort !== "name") ?? "name";
}

/** One person's week, or a team's, measured: what was logged and what was expected. */
export interface Capacity {
	/** Seconds logged in the week, overtime included. */
	seconds: number;
	/** Seconds expected: the schedule's week less public holidays and approved leave. */
	expectedSeconds: number;
}

/** What is left to log of the week; below zero, how far past it. */
export function remainingSeconds({ seconds, expectedSeconds }: Capacity): number {
	return expectedSeconds - seconds;
}

/** The logged time as a whole percentage of the expected; null when nothing is expected. */
export function shareOf({ seconds, expectedSeconds }: Capacity): number | null {
	return expectedSeconds > 0 ? Math.round((seconds / expectedSeconds) * 100) : null;
}

/**
 * The logged time against the expected, for ordering: time logged where none
 * was expected comes above every share, a week with nothing either way below.
 */
function ratioOf({ seconds, expectedSeconds }: Capacity): number {
	if (expectedSeconds > 0) return seconds / expectedSeconds;
	return seconds > 0 ? Number.POSITIVE_INFINITY : 0;
}

/** How `a` and `b` compare in `sort`, the one to come first below zero; 0 for by name. */
function compare(sort: CapacitySort, a: Capacity, b: Capacity): number {
	switch (sort) {
		case "logged":
			return b.seconds - a.seconds;
		case "share": {
			const [x, y] = [ratioOf(a), ratioOf(b)];
			return x === y ? 0 : y > x ? 1 : -1;
		}
		case "remaining":
			return remainingSeconds(b) - remainingSeconds(a);
		default:
			return 0;
	}
}

/**
 * `people` in `sort`'s order, each the most first: the most logged, the
 * largest share of their week, the most left to log (the furthest under).
 * People who tie keep the order they came in, which is by name.
 */
export function sortByCapacity<P extends Capacity>(people: readonly P[], sort: CapacitySort): P[] {
	return sort === "name" ? [...people] : [...people].sort((a, b) => compare(sort, a, b));
}

/**
 * Where the week stands, in words, so over and under never rest on colour:
 * "29:00 under", "1:00 over", "On capacity" within a minute of it; "1:00
 * over, nothing expected" for time on a week that expected none.
 */
export function standingOf(capacity: Capacity): string {
	const left = remainingSeconds(capacity);
	if (capacity.expectedSeconds === 0) {
		return capacity.seconds === 0 ? "Nothing expected" : `${hours(-left)} over, nothing expected`;
	}
	if (left >= 60) return `${hours(left)} under`;
	if (left <= -60) return `${hours(-left)} over`;
	return "On capacity";
}

/** The standing and the share beside it: "29:00 under · 23% of capacity". */
export function capacityLine(capacity: Capacity): string {
	const share = shareOf(capacity);
	return share === null ? standingOf(capacity) : `${standingOf(capacity)} · ${share}% of capacity`;
}
