import type { ReactNode } from "react";

import { cx } from "./cx";

// A sheet of rows: how Timesifier draws anything that is a list with a number at
// the end of each line and, often, a total under them. A day of entries, a week
// of projects, the members of an organisation. docs/design-direction.md, "For
// the product screens", says when to use one and what goes in it.
//
// It is ruled, not carded: one 2px frame round the sheet, a 1px rule between
// rows, and a 2px rule above the total, as on a timesheet. It lays itself out by
// its own width, so it is the same sheet in a narrow column and on a phone.

export interface LedgerProps {
	/** What the sheet is: "Today, Wednesday 11 November". */
	heading: ReactNode;
	/** A word at the other end of the heading line: a count, a state, "Example". */
	note?: ReactNode;
	/** `sheet` where it stands on the yellow band, so its frame is the band's ink. */
	on?: "surface" | "sheet";
	/** `LedgerRows`, a `LedgerTotal`, and anything that belongs between them. */
	children: ReactNode;
}

export function Ledger({ heading, note, on = "surface", children }: LedgerProps) {
	return (
		<div
			className={cx(
				"@container overflow-hidden rounded-large border-2 bg-surface text-on-surface",
				on === "sheet" ? "border-on-sheet" : "border-on-surface",
			)}
		>
			<p className="flex items-baseline justify-between gap-4 px-4 pt-4 pb-3 text-label-large @sm:px-5">
				<span>{heading}</span>
				{note && <span className="text-on-surface-variant">{note}</span>}
			</p>
			{children}
		</div>
	);
}

/** The rows, in the order they happened or are ranked. Its children are `LedgerRow`s. */
export function LedgerRows({ children }: { children: ReactNode }) {
	return <ol className="divide-y divide-outline-variant px-4 @sm:px-5">{children}</ol>;
}

export interface LedgerRowProps {
	/** What the row is: an entry's note, a project, a person's name. */
	title: ReactNode;
	/** One quieter line under it: the project, an email address, a role. */
	detail?: ReactNode;
	/** The figure the row ends in, in tabular figures. */
	value?: ReactNode;
	/**
	 * A short column before the title where there is room for one, and a line under
	 * the detail where there is not: an entry's times.
	 */
	aside?: ReactNode;
	className?: string;
}

export function LedgerRow({ title, detail, value, aside, className }: LedgerRowProps) {
	return (
		<li className={cx("flex flex-wrap items-baseline gap-x-4 py-3", className)}>
			<span className="min-w-0 flex-1">
				<span className="block text-body-large">{title}</span>
				{detail && <span className="block text-body-medium text-on-surface-variant">{detail}</span>}
			</span>
			{value && <span className="text-title-large tabular-nums">{value}</span>}
			{aside && (
				<span className="basis-full text-body-medium whitespace-nowrap text-on-surface-variant tabular-nums @sm:order-first @sm:w-24 @sm:shrink-0 @sm:basis-auto">
					{aside}
				</span>
			)}
		</li>
	);
}

export interface LedgerTotalProps {
	/** What is added up: "Today so far", "Week". */
	label: ReactNode;
	value: ReactNode;
	className?: string;
}

/** The sum of the rows above it, under the sheet's one heavy rule. A sheet has at most one. */
export function LedgerTotal({ label, value, className }: LedgerTotalProps) {
	return (
		<p
			className={cx(
				"mx-4 flex items-baseline justify-between gap-4 border-t-2 border-on-surface py-3 @sm:mx-5",
				className,
			)}
		>
			<span className="text-label-large">{label}</span>
			<span className="text-title-large tabular-nums">{value}</span>
		</p>
	);
}
