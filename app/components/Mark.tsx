import { cx } from "./cx";
import { MARK_ARROW, MARK_BAR, MARK_HEIGHT, MARK_STEM, MARK_WIDTH } from "./mark-paths";

export interface MarkProps {
	/** `two` draws the arrowhead in the accent; `one` draws it in the text colour, like the T. */
	tone?: "two" | "one";
	/** The accessible name. Without one the mark is decoration beside a name already in the text. */
	title?: string;
	/** Sizes the mark, which has no size of its own. The T takes the text colour around it. */
	className?: string;
}

/** The product's mark, drawn in the page so that it follows the colour scheme. */
export function Mark({ tone = "two", title, className }: MarkProps) {
	const viewBox = `0 0 ${MARK_WIDTH} ${MARK_HEIGHT}`;
	const classes = cx("shrink-0", className);
	const shapes = (
		<>
			<path fill="currentColor" d={MARK_BAR} />
			<path fill="currentColor" d={MARK_STEM} />
			<path className={tone === "two" ? "fill-primary-container" : "fill-current"} d={MARK_ARROW} />
		</>
	);

	// Two whole elements, not one with conditional attributes: each then states in
	// full how assistive technology meets it, either as a named image or not at all.
	if (title) {
		return (
			<svg viewBox={viewBox} role="img" aria-label={title} focusable="false" className={classes}>
				{shapes}
			</svg>
		);
	}
	return (
		<svg viewBox={viewBox} aria-hidden="true" focusable="false" className={classes}>
			{shapes}
		</svg>
	);
}
