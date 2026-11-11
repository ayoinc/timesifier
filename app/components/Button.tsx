import type { ReactNode } from "react";
import { Button as AriaButton, type ButtonProps as AriaButtonProps } from "react-aria-components";

import { cx } from "./cx";

// Material 3 Expressive button, small size: 40px tall, 16px either side, label-large.
// Its corners are the corner scale's `large-increased` step; pressed, they settle
// to the `small` step on the spring.

const BASE =
	"relative inline-flex h-10 shrink-0 cursor-pointer select-none items-center justify-center gap-2 " +
	"rounded-large-increased text-label-large outline-none state-layer transition-control " +
	// The touch target is 48px tall although the button is drawn 40px tall.
	"before:absolute before:inset-x-0 before:-inset-y-1 " +
	"data-hovered:state-hover data-focus-visible:state-focus data-focus-visible:focus-indicator " +
	"data-pressed:rounded-small data-pressed:state-pressed " +
	"data-disabled:cursor-not-allowed data-disabled:text-disabled data-disabled:shadow-none";

const VARIANTS = {
	filled:
		"over-primary px-4 text-on-primary data-hovered:not-data-pressed:shadow-level1 data-disabled:bg-disabled",
	tonal:
		"over-secondary-container px-4 text-on-secondary-container data-hovered:not-data-pressed:shadow-level1 data-disabled:bg-disabled",
	outlined: "border border-outline-variant px-4 text-on-surface-variant",
	text: "px-3 text-primary",
} as const;

export type ButtonVariant = keyof typeof VARIANTS;

export interface ButtonProps
	extends Pick<
		AriaButtonProps,
		| "onPress"
		| "isDisabled"
		| "type"
		| "slot"
		| "autoFocus"
		| "form"
		| "name"
		| "value"
		| "id"
		| "aria-label"
		| "aria-describedby"
	> {
	/**
	 * How much the button stands out. `filled` is the one primary action of a view;
	 * `tonal`, `outlined` and `text` step down from it. Defaults to `filled`.
	 */
	variant?: ButtonVariant;
	/** An icon drawn before the label. Pass it at the `medium` size. */
	icon?: ReactNode;
	/** The label. */
	children: ReactNode;
}

/**
 * A button with a text label. Inside a `Dialog` or `Sheet`, `slot="close"` makes
 * it close the overlay.
 */
export function Button({ variant = "filled", icon, children, ...props }: ButtonProps) {
	return (
		<AriaButton {...props} className={cx(BASE, VARIANTS[variant])}>
			{icon}
			{children}
		</AriaButton>
	);
}
