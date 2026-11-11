import { PAGE } from "~/landing/Site";

// The frame of a signed-in page that is in no organisation: the chooser, the
// page that creates an organisation, and an invitation's page. It is the
// sign-in page's frame: the public pages' band at the top holding the name
// alone, the page's column of five, and who is signed in at the foot.

/** The whole page: the band, the main region, and the foot. */
export const OUTSIDE_FRAME = "flex min-h-dvh flex-col";

/** The main region, set as the sign-in page sets its own. */
export const OUTSIDE_MAIN = `${PAGE} flex-1 pt-10 pb-16 outline-none expanded:pt-24 expanded:pb-24`;

/** The one column a page outside an organisation is written in: no wider than a form. */
export const OUTSIDE_COLUMN = "flex min-w-0 max-w-120 flex-col";
