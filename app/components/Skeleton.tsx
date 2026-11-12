import { cx } from "./cx";

/**
 * A shape that holds the place of something still on its way from the server:
 * a heading, a line of text, a control, a row. It is the size of what it stands
 * for, so nothing moves when the real thing takes its place. It breathes slowly
 * (`skeleton-pulse` in app/app.css); with reduced motion it stands still.
 * Hidden from assistive technology: what is loading is said once, by the region
 * that holds the shapes.
 */
export function Skeleton({ className }: { className?: string }) {
	return (
		<div
			aria-hidden="true"
			className={cx("skeleton-pulse rounded-small bg-surface-container-high", className)}
		/>
	);
}
