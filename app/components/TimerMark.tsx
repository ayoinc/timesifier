import { cx } from "./cx";
import { MARK_ARROW } from "./mark-paths";

/**
 * The part of the mark's drawing its arrowhead takes. Start is the one control
 * the arrowhead stands on: it means forward (docs/design-direction.md, "The mark").
 */
const ARROWHEAD_BOX = "535 -4 322 372";

const SIZES = {
	/** 32px: at the end of a row. */
	small: { disc: "size-8", square: "size-2.5", triangle: "size-3" },
	/** 40px: beside the running time in the picture of the day. */
	large: { disc: "size-10", square: "size-3", triangle: "size-3.5" },
} as const;

export interface TimerMarkProps {
	/** A square on a filled disc while the timer runs; the mark's arrowhead to start it. */
	running: boolean;
	/** `filled` draws the arrowhead on a filled disc too: the stopped state of the control. */
	tone?: "filled" | "outlined";
	size?: keyof typeof SIZES;
}

/** The start and stop mark of a timer: a drawing, for a row or for the inside of a button. */
export function TimerMark({ running, tone = "outlined", size = "small" }: TimerMarkProps) {
	const { disc, square, triangle } = SIZES[size];
	const filled = running || tone === "filled";

	return (
		<span
			aria-hidden="true"
			className={cx(
				"grid shrink-0 place-items-center rounded-full",
				disc,
				filled ? "bg-on-primary-fixed" : "border-2 border-on-surface",
			)}
		>
			{running ? (
				<span className={cx("rounded-extra-small bg-primary-container", square)} />
			) : (
				<svg
					viewBox={ARROWHEAD_BOX}
					aria-hidden="true"
					className={cx(triangle, filled ? "fill-primary-container" : "fill-on-surface")}
				>
					<path d={MARK_ARROW} />
				</svg>
			)}
		</span>
	);
}

/**
 * The mark's arrowhead alone, in the text colour, for the inside of an icon
 * button that starts a timer: "Start again" on an entry (taste HT-A).
 */
export function StartArrowhead({ className = "size-4" }: { className?: string }) {
	return (
		<svg
			viewBox={ARROWHEAD_BOX}
			aria-hidden="true"
			focusable="false"
			className={cx("shrink-0 fill-current", className)}
		>
			<path d={MARK_ARROW} />
		</svg>
	);
}
