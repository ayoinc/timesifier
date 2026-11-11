import type { ReactNode } from "react";

/**
 * The one `h1` of a page in the shell. After a move between destinations the
 * shell puts the keyboard focus here, so a screen reader announces the new page
 * and Tab carries on from its top. It takes focus from script only: it is not a
 * stop in the tab order.
 */
export function PageHeading({ children }: { children: ReactNode }) {
	return (
		<h1
			tabIndex={-1}
			className="w-fit rounded-extra-small text-headline-medium outline-none focus-visible:focus-indicator"
		>
			{children}
		</h1>
	);
}
