// The guard on the platform console's reads (TS-099, docs/security.md, "The
// platform console"): the console reads metadata only. A database handle is
// wrapped so that every statement prepared through it is kept, and each kept
// statement is taken apart into the table and column pairs it names. Any pair
// outside `CONSOLE_COLUMNS` is a read the console must not make. Route tests
// can hand the same wrapper to a loader to watch a whole page.

/**
 * What the console may name, table by table, and why. An organisation's own
 * tables appear with `organisation_id` alone: the console counts their rows
 * and reads nothing in them.
 */
export const CONSOLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
	// Who has an account, since when, whether it is closed, and its two mail choices.
	users: ["id", "name", "email", "created_at", "closed_at", "newsletter", "announcements"],
	// Which organisations exist, on which plan, and since when.
	organisations: ["id", "name", "slug", "plan", "seats", "trial_ends_at", "created_at"],
	// Who belongs where, in which role: the people a seat counts and the owners to talk to.
	memberships: ["organisation_id", "user_id", "role"],
	// Waiting invitations take seats, and an account's page lists the ones addressed to it.
	invitations: ["id", "organisation_id", "email", "role", "status", "expires_at", "inviter_id"],
	// When a person last used a session, and how many are live.
	sessions: ["user_id", "updated_at", "expires_at"],
	// An account's sign-in history: when, and the browser's kind.
	sign_ins: ["id", "user_id", "device", "created_at"],
	// Counted by organisation, never read.
	time_entries: ["organisation_id"],
	projects: ["organisation_id"],
	invoices: ["organisation_id"],
	// The platform's own records.
	platform_events: [
		"id",
		"actor_id",
		"action",
		"subject_type",
		"subject_id",
		"reason",
		"detail",
		"created_at",
	],
	mailings: ["id", "kind", "subject", "recipients", "created_at", "sent_by"],
	mailing_deliveries: ["mailing_id", "outcome", "sent_at"],
};

/** A database handle that keeps every statement prepared through it. */
export interface WatchedDatabase {
	database: D1Database;
	/** The SQL of every statement prepared or run so far, oldest first. */
	statements: string[];
}

/** Wraps `database`: each statement is kept, then handed to the real one unchanged. */
export function watchDatabase(database: D1Database): WatchedDatabase {
	const statements: string[] = [];
	const watched = new Proxy(database, {
		get(target, property) {
			if (property === "prepare") {
				return (query: string) => {
					statements.push(query);
					return target.prepare(query);
				};
			}
			if (property === "exec") {
				return (query: string) => {
					statements.push(query);
					return target.exec(query);
				};
			}
			// `batch` and `dump` take statements already prepared, and kept, above.
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { database: watched, statements };
}

/** The tables and `table.column` pairs one statement names. A column it cannot place is under `?`. */
export function namesIn(statement: string): { tables: Set<string>; columns: Set<string> } {
	// A quoted string is a value, never a name: it is set aside first.
	let rest = statement.replace(/'(?:[^']|'')*'/g, "?");
	const tables = new Set<string>();
	const columns = new Set<string>();
	rest = rest.replace(/"([^"]+)"\s*\.\s*"([^"]+)"/g, (_, table: string, column: string) => {
		tables.add(table);
		columns.add(`${table}.${column}`);
		return " ";
	});
	rest = rest.replace(
		/\b(from|join|into|update)\s+"([^"]+)"/gi,
		(_, word: string, table: string) => {
			tables.add(table);
			return `${word} `;
		},
	);
	// Drizzle leaves the columns of a query of one table unqualified: they are that table's.
	const only = tables.size === 1 ? [...tables][0] : "?";
	for (const [, column] of rest.matchAll(/"([^"]+)"/g)) columns.add(`${only}.${column}`);
	// Every column, by a star, is never metadata; `count(*)` names none.
	if (/\*/.test(rest.replace(/count\(\s*\*\s*\)/gi, ""))) columns.add(`${only}.*`);
	return { tables, columns };
}

/** Each name in `statements` outside `CONSOLE_COLUMNS`, with the statement that named it. */
export function outsideMetadata(statements: readonly string[]): string[] {
	const found: string[] = [];
	for (const statement of statements) {
		const { tables, columns } = namesIn(statement);
		for (const table of tables) {
			if (!(table in CONSOLE_COLUMNS)) found.push(`table ${table} in: ${statement}`);
		}
		for (const pair of columns) {
			const [table = "", column = ""] = pair.split(".");
			if (!CONSOLE_COLUMNS[table]?.includes(column)) found.push(`column ${pair} in: ${statement}`);
		}
	}
	return found;
}
