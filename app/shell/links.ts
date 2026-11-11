import { LINK } from "~/landing/Site";

/**
 * A link inside a page's own text: the public pages' underlined link, in the
 * text's ink. Its target reaches 44px tall through an invisible extension above
 * and below, so the words around it keep their baseline; in a sentence the
 * lines around it may overlap that extension, which WCAG 2.5.8 allows for a
 * link inside a sentence.
 */
export const TEXT_LINK = `${LINK} relative text-body-large before:absolute before:inset-x-0 before:-inset-y-2.5`;

/**
 * A link that stands on its own, not inside a sentence: "This week", "Export
 * CSV", "Back to your organisations". At least 44 by 44px, its text centred.
 */
export const ACTION_LINK = `${LINK} inline-flex min-h-11 min-w-11 items-center text-body-large`;
