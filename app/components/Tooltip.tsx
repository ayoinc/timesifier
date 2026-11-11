import type { ReactNode } from "react";
import {
	Tooltip as AriaTooltip,
	type TooltipProps as AriaTooltipProps,
	TooltipTrigger,
	type TooltipTriggerComponentProps,
} from "react-aria-components";

import { cx } from "./cx";
import { TOOLTIP_MOTION } from "./motion";

// Material 3 plain tooltip: inverse-surface, body-small, 4px corners, at least
// 24px tall with 8px either side.

/** How long the pointer rests on the control before the tooltip shows. Keyboard focus shows it at once. */
const HOVER_DELAY_MS = 500;

export interface TooltipProps
	extends Pick<TooltipTriggerComponentProps, "isOpen" | "defaultOpen" | "onOpenChange">,
		Pick<AriaTooltipProps, "placement"> {
	/** The tooltip's text: a few words that name or describe the control. */
	label: string;
	/** The control the tooltip belongs to: a `Button` or an `IconButton`. */
	children: ReactNode;
}

/**
 * A short label that appears beside a control when the pointer rests on it or
 * the keyboard focuses it, and describes the control to assistive technology.
 * Escape hides it. It holds text only and is never the one place something is said.
 */
export function Tooltip({ label, children, placement = "top", ...props }: TooltipProps) {
	return (
		<TooltipTrigger {...props} delay={HOVER_DELAY_MS}>
			{children}
			<AriaTooltip
				placement={placement}
				offset={4}
				className={cx(
					"flex min-h-6 max-w-50 items-center rounded-extra-small bg-inverse-surface px-2 py-1 text-body-small text-inverse-on-surface",
					TOOLTIP_MOTION,
				)}
			>
				{label}
			</AriaTooltip>
		</TooltipTrigger>
	);
}
