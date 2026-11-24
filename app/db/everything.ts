import { asc, getTableColumns, getTableName, gt } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

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
 * and starts after the last id of the one before (keyset paging, decision 58):
 * every tenant table has an `id` and an index on `(organisation_id, id)` or a
 * handful of rows. The columns are the table's own, by their SQL names, less
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

/** The `id` column of a tenant table, which every one has; checked, since the type cannot say so. */
function idColumn(table: TenantTable): AnySQLiteColumn {
	const columns: Record<string, AnySQLiteColumn> = getTableColumns(table);
	const id = columns.id;
	if (!id) throw new Error(`${getTableName(table)} has no id column.`);
	return id;
}

/**
 * Up to `limit` rows of `name` after the row whose id is `after`, oldest id
 * first, each as its values in the order of `exportedTable(name).columns`;
 * and the id of the last row, to start the next page from.
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
		(t) => (after === null ? undefined : gt(idColumn(t), after)),
		{ orderBy: (t) => [asc(idColumn(t))], limit },
	);
	const { columns } = exportedTable(name);
	const last = found.at(-1)?.id;
	return {
		rows: found.map((row) => columns.map(({ key }) => row[key])),
		last: typeof last === "string" ? last : null,
	};
}
