import * as z from "zod";

/**
 * A name a person chooses, for themselves or for an organisation: 1 to 80
 * characters once the space around it is cut. It is shown in pages and quoted
 * in email, so it holds no line break, no other control character and none
 * that reverses the direction of text. The server's gate holds an
 * organisation's name to the same rule (app/auth/organisations.server.ts).
 */
export const Name = z
	.string()
	.trim()
	.min(1)
	.max(80)
	.regex(/^[^\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]+$/u);

/** The longest a name can be, for the field a person types it in. */
export const NAME_MAX_LENGTH = 80;

/** For a field: says so when a name is nothing but spaces, which the browser's own check lets through. */
export function nameProblem(value: string): string | null {
	return value.trim() ? null : "Enter a name.";
}
