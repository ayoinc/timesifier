/**
 * What authentication writes to the log, and what it never does: an address, a
 * code or its hash, a cookie, a token, an invitation's id (docs/security.md,
 * "Never logged").
 *
 * The danger is an error's message. Drizzle's quotes the statement that failed
 * together with its parameters, which are exactly those values, so a line
 * about an error carries the error's name and nothing else of it.
 */

/** The one thing about a caught value that is safe to write down. */
export function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "error";
}

/**
 * Better Auth's logger. The library passes the error it caught, the request's
 * address or a value from the request as extra arguments, and where it builds
 * a value into the message it does so after a colon ("Invalid origin: …"). A
 * line keeps the library's words up to the first colon and the name of each
 * error it was handed.
 */
export function logLibraryLine(
	level: "debug" | "info" | "warn" | "error",
	message: unknown,
	...details: unknown[]
): void {
	const words = typeof message === "string" ? message.split(":", 1) : [];
	const names = [message, ...details].filter((detail) => detail instanceof Error).map(errorName);
	console[level](["auth:", ...words, ...names].join(" "));
}
