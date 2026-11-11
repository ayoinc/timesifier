import type { ReactNode } from "react";
import { Button as AriaButton, type ButtonProps as AriaButtonProps } from "react-aria-components";

import { cx } from "./cx";

// Material 3 Expressive button, small size: 40px tall, 16px either side, label-large.
// Its corners are the corner scale's `large-increased` step; pressed, they settle
// to the `small` step on the spring.
//
// The large size is the action of a page nobody is signed in on, as the home
// page draws its own: 48px tall, 24px either side, title-medium, and the `small`
// corner throughout (docs/design-direction.md, "Buttons").

const BASE =
	"relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 " +
	"outline-none state-layer transition-control " +
	"data-hovered:state-hover data-focus-visible:state-focus data-focus-visible:focus-indicator " +
	"data-pressed:state-pressed " +
	"data-disabled:cursor-not-allowed data-disabled:text-disabled data-disabled:shadow-none";

const SIZES = {
	small:
		"h-10 rounded-large-increased text-label-large data-pressed:rounded-small " +
		// The touch target is 48px tall although the button is drawn 40px tall.
		"before:absolute before:inset-x-0 before:-inset-y-1",
	large: "h-12 rounded-small px-6 text-title-medium",
} as const;

/** The padding at each side of a small button. A large one has its own. */
const SMALL_PADDING = { filled: "px-4", tonal: "px-4", outlined: "px-4", text: "px-3" } as const;

const VARIANTS = {
	filled:
		"over-primary text-on-primary data-hovered:not-data-pressed:shadow-level1 data-disabled:bg-disabled",
	tonal:
		"over-secondary-container text-on-secondary-container data-hovered:not-data-pressed:shadow-level1 data-disabled:bg-disabled",
	outlined: "border border-outline-variant text-on-surface-variant",
	text: "text-primary",
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
	/**
	 * `small` everywhere in the product, and the default. `large` is the one
	 * action of a public page: the sign-in page's.
	 */
	size?: keyof typeof SIZES;
	/** An icon drawn before the label. Pass it at the `medium` size. */
	icon?: ReactNode;
	/** The label. */
	children: ReactNode;
}

/**
 * A button with a text label. Inside a `Dialog` or `Sheet`, `slot="close"` makes
 * it close the overlay.
 */
export function Button({
	variant = "filled",
	size = "small",
	icon,
	children,
	...props
}: ButtonProps) {
	return (
		<AriaButton
			{...props}
			className={cx(
				BASE,
				SIZES[size],
				size === "small" && SMALL_PADDING[variant],
				VARIANTS[variant],
			)}
		>
			{icon}
			{children}
		</AriaButton>
	);
}
