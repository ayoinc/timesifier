import { type SQL, type SQLWrapper, sql } from "drizzle-orm";

// A list goes to D1 as one JSON value (decision 40). D1 takes at most 100
// bound parameters a statement, and `inArray(column, ids)` binds one a value,
// so a list that grows with the organisation's people, projects or records
// fails once it holds about a hundred. `json_each` reads the list from one
// parameter, whatever its length, and SQLite still uses the column's index
// (`LIST SUBQUERY … SCAN json_each`). `pnpm test` refuses an `inArray(` over
// such a list, or an `in (` written into SQL, anywhere else in `app/`
// (`test/node/lists.test.ts`).

/** The list as one JSON value, each value once. */
function listOf(values: Iterable<string | number>): string {
	return JSON.stringify([...new Set(values)]);
}

/** `column` is one of `values`, as one bound parameter however many they are. None is false. */
export function among(column: SQLWrapper, values: Iterable<string | number>): SQL {
	return sql`${column} in (select value from json_each(${listOf(values)}))`;
}

/** `column` is none of `values`, as one bound parameter however many they are. None is true. */
export function notAmong(column: SQLWrapper, values: Iterable<string | number>): SQL {
	return sql`${column} not in (select value from json_each(${listOf(values)}))`;
}

/**
 * The latest of `values` on or before `value` (they compare as SQL does), or
 * null when none is: one bound parameter however many they are. Reports and
 * budgets group time by the latest rate start on or before its day, so each
 * group is one span of days in which no rate starts (decision 57).
 */
export function latestAmong(value: SQLWrapper, values: Iterable<string | number>): SQL {
	return sql`(select max(value) from json_each(${listOf(values)}) where value <= ${value})`;
}
