/**
 * The organisation-scoped data layer: the only way code outside `app/db/`
 * reaches a table that carries an `organisation_id`.
 *
 * Every statement an accessor builds is restricted to the scope's organisation,
 * and the organisation id of a row is written by the scope alone: an insert
 * cannot name another organisation and an update cannot move a row to one.
 */
import { and, eq, type InferInsertModel, type InferSelectModel, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import {
	clients,
	invitations,
	memberships,
	periodEvents,
	periods,
	projects,
	teamMembers,
	teams,
	timeEntries,
} from "./schema";

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
export type Filter<T extends TenantTable> = (table: T) => SQL | undefined;

/** The filter to pass when an update or delete is meant for every row of the organisation. */
export const everyRow: Filter<TenantTable> = () => sql`1 = 1`;

/** How a select orders and limits its rows, for example `{ orderBy: (e) => [desc(e.startedAt)], limit: 50 }`. */
export interface SelectOptions<T extends TenantTable> {
	orderBy?: (table: T) => (SQL | AnySQLiteColumn)[];
	limit?: number;
}

/**
 * A scoped statement not yet sent, for `OrganisationScope.batch`. It is built
 * by an accessor's `statements`, so it is limited to the organisation like
 * everything else the accessor builds. `R` is the row it returns.
 */
export interface ScopedStatement<R> {
	readonly query: BatchItem<"sqlite">;
	/** Never set: it carries the row type to `batch`. */
	readonly rows?: R[];
}

export interface ScopedAccessor<T extends TenantTable> {
	/** Rows of this organisation, all of them or those the filter keeps. */
	select(filter?: Filter<T>, options?: SelectOptions<T>): Promise<Row<T>[]>;
	/** Adds rows to this organisation and returns them. */
	insert(rows: NewRow<T> | NewRow<T>[]): Promise<Row<T>[]>;
	/** Changes the rows of this organisation that the filter keeps, and returns them. */
	update(changes: Partial<NewRow<T>>, filter: Filter<T>): Promise<Row<T>[]>;
	/** Deletes the rows of this organisation that the filter keeps, and returns them. */
	delete(filter: Filter<T>): Promise<Row<T>[]>;
	/** The same three writes, built and not sent, for `OrganisationScope.batch`. */
	statements: {
		insert(rows: NewRow<T> | NewRow<T>[]): ScopedStatement<Row<T>>;
		update(changes: Partial<NewRow<T>>, filter: Filter<T>): ScopedStatement<Row<T>>;
		delete(filter: Filter<T>): ScopedStatement<Row<T>>;
	};
}

export function scopedAccessor<T extends TenantTable>(
	db: DrizzleD1Database,
	table: T,
	organisationId: string,
): ScopedAccessor<T> {
	// Drizzle cannot infer row shapes through a generic table, so the statements
	// are built against the constraint and typed by the interface above.
	const tenantTable: TenantTable = table;
	// The caller's condition goes inside its own parentheses. Without them a raw
	// SQL condition with a top-level OR would sit beside the organisation check
	// instead of under it, and reach other organisations' rows.
	const within = (filter?: Filter<T>) => {
		const condition = filter?.(table);
		return and(
			eq(tenantTable.organisationId, organisationId),
			condition ? sql`(${condition})` : undefined,
		);
	};
	// A filter that returns nothing would turn "these rows" into "every row of
	// the organisation". That has to be asked for by name.
	const narrowed = (filter: Filter<T>) => {
		if (!filter?.(table)) {
			throw new Error(
				"A scoped update or delete needs a condition. Pass everyRow to affect every row of the organisation.",
			);
		}
		return within(filter);
	};

	const statements = {
		insert(rows: NewRow<T> | NewRow<T>[]) {
			// The scope's id is spread last: values arriving from an untyped source
			// (a form, a JSON body) cannot place a row in another organisation.
			const values = (Array.isArray(rows) ? rows : [rows]).map((row) => ({
				...row,
				organisationId,
			}));
			return { query: db.insert(tenantTable).values(values).returning() };
		},
		update(changes: Partial<NewRow<T>>, filter: Filter<T>) {
			const { organisationId: _ignored, ...allowed } = changes as Record<string, unknown>;
			return { query: db.update(tenantTable).set(allowed).where(narrowed(filter)).returning() };
		},
		delete(filter: Filter<T>) {
			return { query: db.delete(tenantTable).where(narrowed(filter)).returning() };
		},
	};

	return {
		async select(filter, options = {}) {
			const query = db.select().from(tenantTable).where(within(filter)).$dynamic();
			if (options.orderBy) query.orderBy(...options.orderBy(table));
			if (options.limit !== undefined) query.limit(options.limit);
			return (await query) as Row<T>[];
		},
		async insert(rows) {
			return (await statements.insert(rows).query) as Row<T>[];
		},
		async update(changes, filter) {
			return (await statements.update(changes, filter).query) as Row<T>[];
		},
		async delete(filter) {
			return (await statements.delete(filter).query) as Row<T>[];
		},
		statements,
	};
}

/** Every table whose rows belong to one organisation. A new one is added here and nowhere else. */
export const tenantTables = {
	memberships,
	invitations,
	clients,
	projects,
	timeEntries,
	periods,
	periodEvents,
	teams,
	teamMembers,
} as const;

type Accessors = {
	readonly [Name in keyof typeof tenantTables]: ScopedAccessor<(typeof tenantTables)[Name]>;
};

type Results<S extends readonly ScopedStatement<unknown>[]> = {
	[K in keyof S]: S[K] extends ScopedStatement<infer R> ? R[] : never;
};

/** Accessors for every tenant table, each limited to one organisation. */
export type OrganisationScope = { readonly organisationId: string } & Accessors & {
		/**
		 * Sends several scoped writes as one D1 batch, which D1 applies all
		 * together or not at all (decision 25), and returns the rows each returned.
		 */
		batch<const S extends readonly [ScopedStatement<unknown>, ...ScopedStatement<unknown>[]]>(
			statements: S,
		): Promise<Results<S>>;
	};

export function organisationScope(database: D1Database, organisationId: string): OrganisationScope {
	const db = drizzle(database);
	const accessors = Object.fromEntries(
		Object.entries(tenantTables).map(([name, table]) => [
			name,
			scopedAccessor(db, table as TenantTable, organisationId),
		]),
	) as unknown as Accessors;
	return {
		organisationId,
		...accessors,
		async batch(statements) {
			const [first, ...rest] = statements.map((statement) => statement.query);
			if (!first) throw new Error("A batch needs at least one statement.");
			return (await db.batch([first, ...rest])) as Results<typeof statements>;
		},
	};
}
