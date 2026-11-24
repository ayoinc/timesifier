/**
 * The organisation-scoped data layer: the only way code outside `app/db/`
 * reaches a table that carries an `organisation_id`.
 *
 * Every statement an accessor builds is restricted to the scope's organisation,
 * and the organisation id of a row is written by the scope alone: an insert
 * cannot name another organisation and an update cannot move a row to one.
 */
import {
	and,
	eq,
	type GetColumnData,
	getTableColumns,
	type InferInsertModel,
	type InferSelectModel,
	SQL,
	sql,
} from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { jsonTable } from "./among";
import {
	activityRecords,
	apiTokens,
	budgetAlerts,
	budgetLines,
	calendarFeeds,
	clientContacts,
	clientManagers,
	clients,
	contracts,
	contractVersions,
	entryTags,
	estimateLines,
	estimates,
	expenseCategories,
	expenseCategoryPrices,
	expenses,
	expenseTags,
	importJobs,
	invitationPlans,
	invitations,
	invoiceLineSources,
	invoiceLines,
	invoiceSettings,
	invoices,
	leaveKinds,
	leaveRequests,
	membershipRemovals,
	memberships,
	notifications,
	organisationDomains,
	organisationExports,
	payments,
	peopleImports,
	periodEvents,
	periods,
	pins,
	projectMembers,
	projects,
	projectTags,
	projectTasks,
	publicHolidays,
	rates,
	recurringInvoiceLines,
	recurringInvoices,
	retainerMovements,
	retainers,
	savedReportShares,
	savedReports,
	scheduleAssignments,
	setupImports,
	supportGrants,
	tags,
	tasks,
	taxes,
	teamMembers,
	teams,
	timeEntries,
	timesheetRuleVersions,
	webhookDeliveries,
	webhooks,
	workingDays,
	workPackages,
	workRequests,
	workScheduleDays,
	workSchedules,
	workScheduleVersions,
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
/**
 * A new row or a change whose values may be SQL computed by the database when
 * the statement runs, for example the next invoice number read inside the
 * batch that stores it.
 */
type Values<T extends TenantTable> = { [K in keyof NewRow<T>]: NewRow<T>[K] | SQL };
/** A row of a tenant table, by its name in `tenantTables`. */
export type TenantRow<Name extends keyof typeof tenantTables> = InferSelectModel<
	(typeof tenantTables)[Name]
>;
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

/** One line of a `sum`: a value of the column summed by, and the total of the rows that have it. */
export interface Sum<K> {
	key: K;
	total: number;
}

/**
 * One line of `sums`: which of the groupings it is of (its index), the values
 * of that grouping's keys (null for a key the grouping leaves out), and the
 * totals of the rows that have them.
 */
export type SumLine<K extends string, A extends string> = { grouping: number } & {
	[Key in K]: string | number | null;
} & { [Amount in A]: number };

export interface ScopedAccessor<T extends TenantTable> {
	/** Rows of this organisation, all of them or those the filter keeps. */
	select(filter?: Filter<T>, options?: SelectOptions<T>): Promise<Row<T>[]>;
	/** Adds rows to this organisation and returns them. */
	insert(rows: Values<T> | Values<T>[]): Promise<Row<T>[]>;
	/** Changes the rows of this organisation that the filter keeps, and returns them. */
	update(changes: Partial<Values<T>>, filter: Filter<T>): Promise<Row<T>[]>;
	/** Deletes the rows of this organisation that the filter keeps, and returns them. */
	delete(filter: Filter<T>): Promise<Row<T>[]>;
	/**
	 * `exists (select 1 from T where …)` limited to this organisation, for a
	 * condition on another table, for example "no invoice line holds this entry".
	 */
	exists(filter: Filter<T>): SQL<boolean>;
	/** `(select expression from T where …)` limited to this organisation: one value, or null. */
	value<V>(expression: (table: T) => SQL<V> | AnySQLiteColumn, filter?: Filter<T>): SQL<V>;
	/**
	 * Adds up `amount` over the rows of this organisation that the filter keeps,
	 * one total for each value of `by`, in one statement:
	 * `SELECT by, SUM(amount) … GROUP BY by`. A value no row has is not listed.
	 */
	sum<C extends AnySQLiteColumn>(
		amount: (table: T) => SQL<number>,
		by: (table: T) => C,
		filter?: Filter<T>,
	): Promise<Sum<GetColumnData<C>>[]>;
	/**
	 * Adds up several amounts over the rows of this organisation that the
	 * filter keeps, grouped several ways in one statement: for each grouping,
	 * one line for each combination of its keys' values (`SELECT keys,
	 * SUM(amount)… GROUP BY keys`), the groupings joined by `UNION ALL`. A
	 * grouping of no key is one line of the whole, even of no row.
	 */
	sums<K extends string, A extends string>(
		keys: (table: T) => Record<K, SQL | AnySQLiteColumn>,
		amounts: (table: T) => Record<A, SQL<number>>,
		groupings: readonly (readonly K[])[],
		filter?: Filter<T>,
	): Promise<SumLine<K, A>[]>;
	/** The writes, built and not sent, for `OrganisationScope.batch`. */
	statements: {
		insert(rows: Values<T> | Values<T>[]): ScopedStatement<Row<T>>;
		/** Adds the row unless one with the same unique key exists. */
		insertIfAbsent(row: Values<T>): ScopedStatement<Row<T>>;
		/**
		 * Adds the row only when `condition` holds as the statement runs, so a
		 * later statement of the same batch can depend on an earlier one.
		 */
		insertWhen(row: Values<T>, condition: SQL): ScopedStatement<never>;
		/**
		 * Adds every row of `rows` in one statement, whatever their number: they
		 * go to D1 as one JSON value (decision 40), not as a bound parameter a
		 * value. With `condition`, only the rows for which it holds as the
		 * statement runs: a condition on nothing but other tables adds all of
		 * them or none, and one given as a function may read a column of the row
		 * being added through `column`.
		 */
		insertMany(
			rows: Values<T>[],
			condition?: SQL | ((column: (key: keyof NewRow<T> & string) => SQL) => SQL),
		): ScopedStatement<never>;
		update(changes: Partial<Values<T>>, filter: Filter<T>): ScopedStatement<Row<T>>;
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

	const withOrganisation = (rows: Values<T> | Values<T>[]) =>
		// The scope's id is spread last: values arriving from an untyped source
		// (a form, a JSON body) cannot place a row in another organisation.
		(Array.isArray(rows) ? rows : [rows]).map((row) => ({ ...row, organisationId }));
	/**
	 * Every column of `row`, in the table's order, as `insert … select` writes
	 * them: the given value, else the column's default, else null; each as the
	 * driver stores it, or as SQL.
	 */
	const columnValues = (row: Values<T>): unknown[] => {
		const given = { ...row, organisationId } as Record<string, unknown>;
		return Object.entries(getTableColumns(tenantTable)).map(([key, column]) => {
			const value =
				given[key] !== undefined
					? given[key]
					: column.defaultFn
						? column.defaultFn()
						: column.hasDefault
							? column.default
							: null;
			return value instanceof SQL || value === null ? value : column.mapToDriverValue(value);
		});
	};
	const statements = {
		insert(rows: Values<T> | Values<T>[]) {
			return { query: db.insert(tenantTable).values(withOrganisation(rows)).returning() };
		},
		insertIfAbsent(row: Values<T>) {
			return {
				query: db
					.insert(tenantTable)
					.values(withOrganisation(row))
					.onConflictDoNothing()
					.returning(),
			};
		},
		insertWhen(row: Values<T>, condition: SQL) {
			const values = columnValues(row).map((value) =>
				value instanceof SQL ? value : value === null ? sql`null` : sql`${value}`,
			);
			// A built `insert`, not `db.run`: D1's batch takes prepared statements only.
			return {
				query: db
					.insert(tenantTable)
					.select(sql`select ${sql.join(values, sql`, `)} where ${condition}`),
			} as unknown as ScopedStatement<never>;
		},
		insertMany(
			rows: Values<T>[],
			condition?: SQL | ((column: (key: keyof NewRow<T> & string) => SQL) => SQL),
		) {
			// Each row as an array of the driver's values, in the table's order. A
			// value given as SQL is the same for every row, so it is written once.
			if (rows.length === 0) throw new Error("insertMany needs at least one row.");
			const keys = Object.keys(getTableColumns(tenantTable));
			const given = rows.map(columnValues);
			const column = (key: string) => sql`json_extract(value, ${`$[${keys.indexOf(key)}]`})`;
			const values = (given[0] ?? []).map((value, index) =>
				value instanceof SQL ? value : column(keys[index] ?? ""),
			);
			const table = jsonTable(
				given.map((row) => row.map((value) => (value instanceof SQL ? null : value))),
			);
			const holds = typeof condition === "function" ? condition(column) : condition;
			const where = holds ? sql` where ${holds}` : sql``;
			return {
				query: db
					.insert(tenantTable)
					.select(sql`select ${sql.join(values, sql`, `)} from ${table}${where}`),
			} as unknown as ScopedStatement<never>;
		},
		update(changes: Partial<Values<T>>, filter: Filter<T>) {
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
		exists(filter) {
			return sql<boolean>`exists (select 1 from ${tenantTable} where ${within(filter)})`;
		},
		value(expression, filter) {
			return sql`(select ${expression(table)} from ${tenantTable} where ${within(filter)})`;
		},
		async sum(amount, by, filter) {
			const key = by(table);
			const rows = await db
				.select({ key, total: sql<number>`coalesce(sum(${amount(table)}), 0)` })
				.from(tenantTable)
				.where(within(filter))
				.groupBy(key);
			return rows.map((row) => ({
				key: row.key as GetColumnData<typeof key>,
				total: Number(row.total),
			}));
		},
		async sums<K extends string, A extends string>(
			keys: (table: T) => Record<K, SQL | AnySQLiteColumn>,
			amounts: (table: T) => Record<A, SQL<number>>,
			groupings: readonly (readonly K[])[],
			filter?: Filter<T>,
		): Promise<SumLine<K, A>[]> {
			const keyed = Object.entries(keys(table)) as [K, SQL | AnySQLiteColumn][];
			const added = Object.entries(amounts(table)) as [A, SQL<number>][];
			// Each part names its columns, so the lines of every part line up; a part
			// groups by its keys' names, so an expression with a bound value is bound once.
			const parts = groupings.map((grouping, at) => {
				const columns = [
					sql`${sql.raw(String(at))} as "grouping"`,
					...keyed.map(([name, expression]) =>
						grouping.includes(name)
							? sql`${expression} as ${sql.identifier(`k_${name}`)}`
							: sql`null as ${sql.identifier(`k_${name}`)}`,
					),
					...added.map(
						([name, expression]) =>
							sql`coalesce(sum(${expression}), 0) as ${sql.identifier(`a_${name}`)}`,
					),
				];
				const by = grouping.map((name) => sql.identifier(`k_${name}`));
				return sql`select ${sql.join(columns, sql`, `)} from ${tenantTable} where ${within(filter)}${
					by.length > 0 ? sql` group by ${sql.join(by, sql`, `)}` : sql``
				}`;
			});
			const rows = await db.all<Record<string, string | number | null>>(
				sql.join(parts, sql` union all `),
			);
			return rows.map((row) => {
				const line: Record<string, string | number | null> = { grouping: Number(row.grouping) };
				for (const [name] of keyed) line[name] = row[`k_${name}`] ?? null;
				for (const [name] of added) line[name] = Number(row[`a_${name}`] ?? 0);
				// Built from the caller's own names: the keys' values and the totals as numbers.
				return line as unknown as SumLine<K, A>;
			});
		},
		statements,
	};
}

/** Every table whose rows belong to one organisation. A new one is added here and nowhere else. */
export const tenantTables = {
	memberships,
	invitations,
	clients,
	clientContacts,
	clientManagers,
	projects,
	workPackages,
	projectMembers,
	timeEntries,
	periods,
	periodEvents,
	teams,
	teamMembers,
	leaveKinds,
	leaveRequests,
	publicHolidays,
	workingDays,
	workSchedules,
	workScheduleVersions,
	workScheduleDays,
	scheduleAssignments,
	tasks,
	projectTasks,
	tags,
	entryTags,
	projectTags,
	expenseTags,
	rates,
	budgetLines,
	budgetAlerts,
	expenseCategories,
	expenseCategoryPrices,
	expenses,
	taxes,
	invoiceSettings,
	invoices,
	invoiceLines,
	invoiceLineSources,
	payments,
	estimates,
	estimateLines,
	recurringInvoices,
	recurringInvoiceLines,
	retainers,
	retainerMovements,
	activityRecords,
	savedReports,
	savedReportShares,
	pins,
	apiTokens,
	webhooks,
	webhookDeliveries,
	importJobs,
	peopleImports,
	setupImports,
	invitationPlans,
	calendarFeeds,
	workRequests,
	timesheetRuleVersions,
	organisationDomains,
	membershipRemovals,
	supportGrants,
	notifications,
	organisationExports,
	contracts,
	contractVersions,
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
