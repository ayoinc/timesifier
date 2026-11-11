/**
 * What a person's name may be, wherever one is taken: Settings, and any page
 * that changes it later. No name is asked on the way in.
 *
 * One line of text that begins and ends with something other than a space, no
 * longer than a page can show, with no control character and none that
 * reverses the direction of text, because pages show a name to the other
 * members of an organisation. A page trims what was typed before it sends it.
 *
 * This module holds no server code: pages import it too.
 */
import * as z from "zod";

export const PERSON_NAME_MAX = 100;

export const PersonName = z
	.string()
	.max(PERSON_NAME_MAX)
	.regex(/^[^\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]+$/u)
	.regex(/^\S(?:.*\S)?$/u);

/**
 * The letters a person's avatar shows: the first letters of the first and the
 * last word of their name, or of the only word, and the first letter of their
 * address while they have given no name. Upper case, counted in characters a
 * reader sees, so an accented letter or an emoji is never cut in half.
 */
export function initialsOf(name: string | null, email: string): string {
	const words = name?.trim().split(/\s+/u).filter(Boolean) ?? [];
	const first = words[0];
	const last = words.length > 1 ? words[words.length - 1] : undefined;
	const letters = first ? [first, last] : [email.trim()];
	return letters
		.map((word) => (word ? firstCharacter(word) : ""))
		.join("")
		.toLocaleUpperCase();
}

function firstCharacter(text: string): string {
	const [segment] = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text);
	return segment?.segment ?? "";
}
