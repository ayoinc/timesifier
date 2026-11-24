import { asc, getTableColumns, getTableName, gt, type SQL, sql } from "drizzle-orm";
import { type AnySQLiteColumn, getTableConfig } from "drizzle-orm/sqlite-core";
import * as z from "zod";

import {
	type OrganisationScope,
	type ScopedAccessor,
	type TenantTable,
	tenantTables,
} from "./scope";

/**
 * Every table of an organisation, a page at a time, for the export of
 * everything (TS-126, docs/decisions.md entry 71). Each page is read through
 * `organisationScope`, so it holds the organisation's rows and nobody else's,
 * and starts after the last key of the one before (keyset paging, decision 58):
 * a tenant table's key is its `id`, with an index on `(organisation_id, id)` or
 * a handful of rows, or, for the one with no `id` (`client_managers`, TS-115a),
 * its primary key. The columns are the table's own, by their SQL names, less
 * the few that are secrets.
 */

/** Tables not exported: the exports' own bookkeeping, which says nothing of the organisation's work. */
const NOT_EXPORTED = ["organisationExports"] as const;

/** A tenant table the export writes. */
export type ExportedTable = Exclude<keyof typeof tenantTables, (typeof NOT_EXPORTED)[number]>;

/**
 * Columns never written, by table: the hashes of API tokens, webhook secrets
 * and calendar feed addresses, which prove a secret and are of no use outside,
 * and an invitation's id, which is the secret in its link.
 */
export const WITHHELD_COLUMNS: { readonly [T in ExportedTable]?: readonly string[] } = {
	invitations: ["id"],
	apiTokens: ["tokenHash"],
	webhooks: ["secretHash"],
	calendarFeeds: ["tokenHash"],
};

/** Every table the export writes, in the order the data layer lists them. */
export const EXPORTED_TABLES = (Object.keys(tenantTables) as (keyof typeof tenantTables)[]).filter(
	(name): name is ExportedTable => !(NOT_EXPORTED as readonly string[]).includes(name),
);

/**
 * A table as the export writes it: its SQL name, its columns' properties and
 * SQL names, and the SQL names of the columns withheld.
 */
export function exportedTable(name: ExportedTable): {
	sqlName: string;
	columns: { key: string; name: string }[];
	withheld: string[];
} {
	const table = tenantTables[name];
	const withheld = WITHHELD_COLUMNS[name] ?? [];
	const all = Object.entries(getTableColumns(table)).map(([key, column]) => ({
		key,
		name: column.name,
	}));
	return {
		sqlName: getTableName(table),
		columns: all.filter(({ key }) => !withheld.includes(key)),
		withheld: all.filter(({ key }) => withheld.includes(key)).map(({ name }) => name),
	};
}

/**
 * The columns a tenant table's pages are ordered and started by, each with its
 * property: its `id`, or its primary key where it has no `id`; checked, since
 * the type cannot say so.
 */
function keyColumns(table: TenantTable): { key: string; column: AnySQLiteColumn }[] {
	const columns: Record<string, AnySQLiteColumn> = getTableColumns(table);
	if (columns.id) return [{ key: "id", column: columns.id }];
	const primary = getTableConfig(table).primaryKeys[0]?.columns ?? [];
	const keyed = primary.map((column) => ({
		key: Object.keys(columns).find((key) => columns[key] === column) ?? "",
		column,
	}));
	if (keyed.length === 0 || keyed.some(({ key }) => key === "")) {
		throw new Error(`${getTableName(table)} has no id column and no primary key.`);
	}
	return keyed;
}

/**
 * Rows after `after`: after the id, or, for a primary key of several columns,
 * after the key's values as a JSON array, compared as one row value.
 */
function afterKey(table: TenantTable, after: string): SQL | undefined {
	const keyed = keyColumns(table);
	if (keyed.length === 1) return gt(keyed[0].column, after);
	const values = z.array(z.string()).length(keyed.length).parse(JSON.parse(after));
	return sql`(${sql.join(
		keyed.map(({ column }) => column),
		sql`, `,
	)}) > (${sql.join(
		values.map((value) => sql`${value}`),
		sql`, `,
	)})`;
}

/**
 * Up to `limit` rows of `name` after the row whose key is `after`, in the
 * order of their keys, each as its values in the order of
 * `exportedTable(name).columns`; and the key of the last row, to start the
 * next page from: its id, or its primary key's values as a JSON array.
 */
export async function exportedPage(
	scope: OrganisationScope,
	name: ExportedTable,
	after: string | null,
	limit: number,
): Promise<{ rows: unknown[][]; last: string | null }> {
	// Every accessor has the same shape; the union of their row types is too wide for a call.
	const accessor: ScopedAccessor<TenantTable> = scope[name];
	const found: Record<string, unknown>[] = await accessor.select(
		(t) => (after === null ? undefined : afterKey(t, after)),
		{ orderBy: (t) => keyColumns(t).map(({ column }) => asc(column)), limit },
	);
	const { columns } = exportedTable(name);
	const keyed = keyColumns(tenantTables[name]);
	const lastRow = found.at(-1);
	const lastKey = lastRow ? keyed.map(({ key }) => lastRow[key]) : [];
	const last = keyed.length === 1 ? lastKey[0] : lastRow ? JSON.stringify(lastKey) : null;
	return {
		rows: found.map((row) => columns.map(({ key }) => row[key])),
		last: typeof last === "string" ? last : null,
	};
}
