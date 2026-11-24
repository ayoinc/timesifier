/**
 * A share of the queries one Worker invocation may make of D1, for work that
 * must leave the rest to the work beside it (decision 69). Cloudflare counts a
 * statement run, and a batch, as one query each against the invocation's
 * limit; `countedDatabase` counts them the same way and refuses the first past
 * the share, before it reaches D1.
 */

/** Thrown, before it is sent, by the first query past a budget. */
export class QueriesSpent extends Error {
	override name = "QueriesSpent";
}

/** Whether `error`, or what it was thrown for (Drizzle wraps a driver's errors), is `QueriesSpent`. */
export function isQueriesSpent(error: unknown): boolean {
	let cause = error;
	for (let depth = 0; depth < 5 && cause instanceof Error; depth += 1) {
		if (cause instanceof QueriesSpent) return true;
		cause = cause.cause;
	}
	return false;
}

/** The queries a piece of work may make, and those it has made. */
export class QueryBudget {
	spent = 0;

	constructor(private limit: number) {}

	/** The queries left to make. */
	get left(): number {
		return this.limit - this.spent;
	}

	/** Counts one query, or throws `QueriesSpent` when none is left. */
	spend(): void {
		if (this.spent >= this.limit) throw new QueriesSpent(`More than ${this.limit} queries.`);
		this.spent += 1;
	}

	/** Allows `more` queries past the limit: those kept back for the work's last write. */
	extend(more: number): void {
		this.limit += more;
	}
}

/**
 * `database`, with each statement run and each batch counted against
 * `budget`. Statements prepared from it may be batched on it as from D1.
 */
export function countedDatabase(database: D1Database, budget: QueryBudget): D1Database {
	const inner = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
	const counted = (statement: D1PreparedStatement): D1PreparedStatement => {
		const wrapped = {
			bind: (...values: unknown[]) => counted(statement.bind(...values)),
			first: (column?: string) => {
				budget.spend();
				return column === undefined ? statement.first() : statement.first(column);
			},
			run: () => {
				budget.spend();
				return statement.run();
			},
			all: () => {
				budget.spend();
				return statement.all();
			},
			raw: (options?: { columnNames: true }) => {
				budget.spend();
				return options ? statement.raw(options) : statement.raw();
			},
		} as unknown as D1PreparedStatement;
		inner.set(wrapped, statement);
		return wrapped;
	};
	return {
		prepare: (query: string) => counted(database.prepare(query)),
		batch: (statements: D1PreparedStatement[]) => {
			budget.spend();
			return database.batch(statements.map((statement) => inner.get(statement) ?? statement));
		},
		exec: (query: string) => {
			budget.spend();
			return database.exec(query);
		},
		withSession: () => {
			throw new Error("A counted database has no sessions.");
		},
		dump: () => database.dump(),
	} as unknown as D1Database;
}
