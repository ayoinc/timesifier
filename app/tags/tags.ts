import * as z from "zod";

/**
 * What the pages that carry tags share with the browser (TS-085). The rules
 * that read the database are in `tags.server.ts`.
 */

/** The form field a tag picker sends, once for each tag ticked, and once empty so that "none" is said. */
export const TAG_FIELD = "tagIds";

/** A tag as a picker or a filter offers it. */
export interface TagChoice {
	id: string;
	name: string;
	archived: boolean;
}

/**
 * The tags a form sends: each value of `tagIds` that is not empty. Undefined
 * when the form has no picker, which leaves the tags as they are.
 */
export const TagIds = z
	.union([z.string().max(64), z.array(z.string().max(64)).max(51)])
	.optional()
	.transform((value) =>
		value === undefined ? undefined : (Array.isArray(value) ? value : [value]).filter(Boolean),
	);

/** The tags a picker offers for something that has `selected`: the active ones, and any archived one it has. */
export function offeredTags(tags: readonly TagChoice[], selected: readonly string[]): TagChoice[] {
	return tags.filter((tag) => !tag.archived || selected.includes(tag.id));
}
