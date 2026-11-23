import type { ReactNode } from "react";

import { SIGN_IN_PATH } from "~/routes/auth/paths";

import { PAGE, PRIMARY_ACTION } from "./Site";

// What the home page and the buyer pages (TS-106) share between the band at the
// top and the foot: a section's frame and opening, and the one way in.

/** A section that runs the width of the page. */
export const SECTION = `${PAGE} py-16 expanded:py-24`;
export const HEADING = "text-headline-large text-balance medium:text-display-small";
export const LEAD = "max-w-136 text-body-large text-on-surface-variant";

/**
 * The opening of a section that runs the width of the page: from 840px the
 * heading stands at the left and the words that lead into the section at the
 * right, on the heading's first line. They rise into place (`rise` in public.css).
 */
export function SectionHead({
	id,
	title,
	children,
}: {
	id: string;
	title: string;
	children: ReactNode;
}) {
	return (
		<div className="rise grid gap-4 expanded:grid-cols-12 expanded:items-baseline expanded:gap-8">
			<h2 id={id} className={`${HEADING} expanded:col-span-6`}>
				{title}
			</h2>
			<p className={`${LEAD} expanded:col-span-5 expanded:col-start-8`}>{children}</p>
		</div>
	);
}

/**
 * The page's one primary action, and the one way in: the sign-in page takes a
 * person who is new and a person coming back alike. Its words promise only what
 * the next page does (`PRIMARY_ACTION` in ~/landing/Site). It stands on the
 * sheet, in the sheet's two colours swapped.
 */
export function GetStarted() {
	return (
		<a
			href={SIGN_IN_PATH}
			className="inline-flex h-12 items-center rounded-small px-6 text-title-medium text-sheet outline-none state-layer over-on-sheet press transition-control hover:state-hover focus-visible:state-focus focus-visible:focus-indicator active:state-pressed motion-safe:active:scale-97"
		>
			{PRIMARY_ACTION}
		</a>
	);
}

/**
 * What opening the action leads to, said wherever the page asks a person in.
 */
export function OpenToday() {
	return (
		<p className="mt-4 max-w-120 text-body-medium text-on-sheet-variant">
			Free today. Sign in with your email address, set up your organisation and a first project, and
			start the timer.
		</p>
	);
}
