/**
 * What a person's name may be, wherever one is taken: the sign-up page, the
 * server when a code creates the account, and any page that changes it later.
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
