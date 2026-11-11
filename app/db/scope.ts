/**
 * The organisation-scoped data layer: the only way code outside `app/db/`
 * reaches a table that carries an `organisation_id`.
 *
 * Every statement an accessor builds is restricted to the scope's organisation,
 * and the organisation id of a row is written by the scope alone: an insert
 * cannot name another organisation and an update cannot move a row to one.
 */
import { and, eq, type InferInsertModel, type InferSelectModel, type SQL } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { memberships } from "./schema";

/** A table whose rows belong to one organisation. A table without the column is rejected by the compiler. */
export type TenantTable = SQLiteTable & {
	organisationId: AnySQLiteColumn<{ data: string; notNull: true }>;
};

type Row<T extends TenantTable> = InferSelectModel<T>;
/**
 * What a caller supplies for a new row: everything except the organisation.
 * The `infer` step makes TypeScript wait for the real table before removing
 * the key; applied to the generic directly, `Omit` also drops optional columns.
 */
type NewRow<T extends TenantTable> =
	InferInsertModel<T> extends infer Insert ? Omit<Insert, "organisationId"> : never;
/** Narrows a statement further within the organisation, for example `(m) => eq(m.userId, id)`. */
type Filter<T extends TenantTable> = (table: T) => SQL | undefined;

export interface ScopedAccessor<T extends TenantTable> {
	/** Rows of this organisation, all of them or those the filter keeps. */
	select(filter?: Filter<T>): Promise<Row<T>[]>;
	/** Adds rows to this organisation and returns them. */
	insert(rows: NewRow<T> | NewRow<T>[]): Promise<Row<T>[]>;
	/** Changes rows of this organisation and returns the changed rows. */
	update(changes: Partial<NewRow<T>>, filter?: Filter<T>): Promise<Row<T>[]>;
	/** Deletes rows of this organisation and returns the deleted rows. */
	delete(filter?: Filter<T>): Promise<Row<T>[]>;
}

export function scopedAccessor<T extends TenantTable>(
	db: DrizzleD1Database,
	table: T,
	organisationId: string,
): ScopedAccessor<T> {
	// Drizzle cannot infer row shapes through a generic table, so the statements
	// are built against the constraint and typed by the interface above.
	const tenantTable: TenantTable = table;
	const within = (filter?: Filter<T>) =>
		and(eq(tenantTable.organisationId, organisationId), filter?.(table));

	return {
		async select(filter) {
			const rows = await db.select().from(tenantTable).where(within(filter));
			return rows as Row<T>[];
		},
		async insert(rows) {
			// The scope's id is spread last: values arriving from an untyped source
			// (a form, a JSON body) cannot place a row in another organisation.
			const values = (Array.isArray(rows) ? rows : [rows]).map((row) => ({
				...row,
				organisationId,
			}));
			const inserted = await db.insert(tenantTable).values(values).returning();
			return inserted as Row<T>[];
		},
		async update(changes, filter) {
			const { organisationId: _ignored, ...allowed } = changes as Record<string, unknown>;
			const updated = await db.update(tenantTable).set(allowed).where(within(filter)).returning();
			return updated as Row<T>[];
		},
		async delete(filter) {
			const deleted = await db.delete(tenantTable).where(within(filter)).returning();
			return deleted as Row<T>[];
		},
	};
}

/** Accessors for every tenant table, each limited to one organisation. */
export interface OrganisationScope {
	readonly organisationId: string;
	readonly memberships: ScopedAccessor<typeof memberships>;
}

/** A new tenant table is added to `OrganisationScope` and here, and nowhere else. */
export function organisationScope(database: D1Database, organisationId: string): OrganisationScope {
	const db = drizzle(database);
	return {
		organisationId,
		memberships: scopedAccessor(db, memberships, organisationId),
	};
}
