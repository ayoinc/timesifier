import { Link, type To } from "react-router";

import { ACTION_LINK } from "~/shell/links";

import { cx } from "./cx";

export interface PagerProps {
	/** What it pages through, for assistive technology: "Pages of people". */
	label: string;
	/** The place of the page's first item in the list, from 1. */
	first: number;
	/** How many items the page shows. */
	shown: number;
	/** How many the whole list holds. */
	total: number;
	/** The page before, or null on the first. */
	previous: To | null;
	/** The page after, or null on the last. */
	next: To | null;
	/** How many a page holds: what a step moves by. */
	size: number;
}

/**
 * Pages a long list: where the page sits, "51–100 of 300", then the links to
 * the page before and the page after, each its own address so it works without
 * script. A step there is no page for is left out.
 */
export function Pager({ label, first, shown, total, previous, next, size }: PagerProps) {
	const last = first + shown - 1;
	return (
		<nav aria-label={label} className="flex flex-wrap items-center gap-x-4">
			<p className="text-body-medium text-on-surface-variant">
				{first}–{last} of {total}
			</p>
			{previous !== null && (
				<Link to={previous} className={cx(ACTION_LINK, "shrink-0")}>
					Previous {size}
				</Link>
			)}
			{next !== null && (
				<Link to={next} className={cx(ACTION_LINK, "shrink-0")}>
					Next {Math.min(size, total - last)}
				</Link>
			)}
		</nav>
	);
}
