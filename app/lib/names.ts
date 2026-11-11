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
