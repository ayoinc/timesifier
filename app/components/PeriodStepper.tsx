import type { ReactNode } from "react";
import { Link as AriaLink } from "react-aria-components";
import { Link, type To } from "react-router";

import { ACTION_LINK } from "~/shell/links";
import { finishRunningTransition } from "~/shell/transitions";

import { cx } from "./cx";
import { ChevronLeftIcon } from "./icons/ChevronLeftIcon";
import { ChevronRightIcon } from "./icons/ChevronRightIcon";

export interface Step {
	/** Where the step goes. */
	to: To;
	/** Its accessible name: "Previous week". */
	label: string;
}

export interface PeriodStepperProps {
	/** What it steps through, for assistive technology: "Weeks", "Report range". */
	label: string;
	/** The period shown, already written by app/time/format.ts: "9–15 November 2026". */
	period: ReactNode;
	previous: Step;
	/** null when there is nothing after (drawn disabled). */
	next: Step | null;
	/** The way back to the period holding today ("This week", "This month"); omit when already there. */
	current?: Step;
}

// The 44px icon link: the standard icon button's look, as a link.
const ICON_LINK =
	"relative inline-flex size-11 shrink-0 items-center justify-center rounded-large-increased outline-none state-layer transition-control";

/**
 * Steps a page through periods: ‹ the period › and then the way back to today,
 * on one row that fits 390px. Each is a link, so every period has an address;
 * the arrows are named by their step ("Previous week"), and the period between
 * them is plain visible text, not a tooltip.
 */
export function PeriodStepper({ label, period, previous, next, current }: PeriodStepperProps) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: a fieldset is for form controls; these are links named as one group.
		<div role="group" aria-label={label} className="flex min-w-0 items-center gap-1">
			<Link
				to={previous.to}
				preventScrollReset
				onClick={finishRunningTransition}
				aria-label={previous.label}
				className={cx(
					ICON_LINK,
					"text-on-surface-variant hover:state-hover focus-visible:focus-indicator active:state-pressed",
				)}
			>
				<ChevronLeftIcon />
			</Link>
			<span className="min-w-0 text-center text-on-surface text-title-small">{period}</span>
			{next ? (
				<Link
					to={next.to}
					preventScrollReset
					onClick={finishRunningTransition}
					aria-label={next.label}
					className={cx(
						ICON_LINK,
						"text-on-surface-variant hover:state-hover focus-visible:focus-indicator active:state-pressed",
					)}
				>
					<ChevronRightIcon />
				</Link>
			) : (
				// Nothing comes after: a link with no address, which assistive
				// technology announces as unavailable.
				<AriaLink
					isDisabled
					aria-label="No later period"
					className={cx(ICON_LINK, "text-disabled")}
				>
					<ChevronRightIcon />
				</AriaLink>
			)}
			{current && (
				<Link
					to={current.to}
					preventScrollReset
					onClick={finishRunningTransition}
					className={cx(ACTION_LINK, "ms-2 shrink-0")}
				>
					{current.label}
				</Link>
			)}
		</div>
	);
}
