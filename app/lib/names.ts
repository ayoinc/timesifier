import * as z from "zod";

/**
 * The name of something an organisation keeps a list of: a project, a client,
 * a team (TS-011a, TS-011b, TS-038). 1 to 120 characters once the space around
 * it is cut, with no line break, no other control character and none that
 * reverses the direction of text, as `Name` in `app/organisations/name.ts`.
 */
export const RECORD_NAME_MAX_LENGTH = 120;

export const RecordName = z
	.string()
	.trim()
	.min(1)
	.max(RECORD_NAME_MAX_LENGTH)
	.regex(/^[^\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]+$/u);

/**
 * What makes two names the same in one organisation: the name normalised
 * (NFKC), trimmed and lower-cased. It is stored as `name_key` beside the name,
 * and a unique index on it refuses a second "design" after "Design".
 */
export function nameKey(name: string): string {
	return name.normalize("NFKC").trim().toLowerCase();
}

/** What a person is told when a name of a record breaks the rule above. */
export const RECORD_NAME_PROBLEM = `Enter a name of up to ${RECORD_NAME_MAX_LENGTH} characters.`;

/** The name typed, as it is stored, or null when it is no name (`RECORD_NAME_PROBLEM`). */
export function recordName(typed: string): string | null {
	const parsed = RecordName.safeParse(typed);
	return parsed.success ? parsed.data : null;
}

/** The same rule, for a field in the browser: the problem, or null. */
export function recordNameProblem(typed: string): string | null {
	return recordName(typed) === null ? RECORD_NAME_PROBLEM : null;
}

/**
 * Whether a write failed on the unique index of `(organisation_id, name_key)`:
 * another request gave the same name between the check and the write. D1's
 * message names the columns; Drizzle wraps it in an error of its own.
 */
export function isNameClash(error: unknown): boolean {
	for (let at: unknown = error; at instanceof Error; at = at.cause) {
		if (/UNIQUE constraint failed: \w+\.organisation_id, \w+\.name_key/.test(at.message))
			return true;
	}
	return false;
}
