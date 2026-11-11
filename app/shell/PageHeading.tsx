import type { ReactNode } from "react";

import { cx } from "~/components/cx";
import { Ledger } from "~/components/Ledger";

// The type of a signed-in page, which is the sign-in page's: its heading
// (`StepHeading`), the sentence under it (`StepLead`), and the home page's
// section heading under the 2px ink rule that heads a sheet of rows
// (docs/design-direction.md, "For the product screens", "Headings").

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
			className="w-fit rounded-extra-small text-headline-large text-balance outline-none focus-visible:focus-indicator medium:text-display-small"
		>
			{children}
		</h1>
	);
}

/** The sentence under a page's heading that says what the page is for. */
export function PageLead({ children }: { children: ReactNode }) {
	return <p className="mt-4 max-w-160 text-body-large text-on-surface-variant">{children}</p>;
}

export interface SectionProps {
	/** The id of its heading, which names the section. */
	id: string;
	heading: ReactNode;
	/** One sentence under the heading saying whose the section is. */
	lead?: ReactNode;
	className?: string;
	children: ReactNode;
}

/** A part of a page: its heading under the 2px ink rule, 40px below what is above it. */
export function Section({ id, heading, lead, className, children }: SectionProps) {
	return (
		<section
			aria-labelledby={id}
			className={cx("mt-10 border-t-2 border-on-surface pt-4", className)}
		>
			<h2 id={id} className="text-headline-medium text-balance">
				{heading}
			</h2>
			{lead && <p className="mt-2 max-w-160 text-body-medium text-on-surface-variant">{lead}</p>}
			<div className="mt-4">{children}</div>
		</section>
	);
}

export interface EmptySheetProps {
	/** What the sheet will hold. */
	heading: ReactNode;
	note?: ReactNode;
	/** One sentence saying what will be here. */
	children: ReactNode;
}

/** A sheet of rows before it has any: the sheet's frame and heading, and one sentence where the rows will be. */
export function EmptySheet({ heading, note, children }: EmptySheetProps) {
	return (
		<div className="mt-10 max-w-200">
			<Ledger heading={heading} note={note}>
				<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
					{children}
				</p>
			</Ledger>
		</div>
	);
}
