import { type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { nameKey } from "~/lib/names";

/**
 * How Projects and Clients narrow a list by the words typed in their search
 * field (TS-057), in SQL, so only the records that match leave the database.
 */

/**
 * `column`, a `name_key`, has the words typed in it anywhere: "acme" finds
 * "Acme Ltd" and "The ACME project". The words are made a key the way a name
 * is (`nameKey`), so capitals and other forms of a letter match, and `instr`
 * takes them as they are: `%` and `_` are no wildcards.
 */
export function nameHas(column: SQLiteColumn, typed: string): SQL {
	return sql`instr(${column}, ${nameKey(typed)}) > 0`;
}

/** `column` is one of `values`, as one bound parameter however many they are. */
export function among(column: SQLiteColumn, values: readonly string[]): SQL {
	return sql`${column} in (select value from json_each(${JSON.stringify(values)}))`;
}
