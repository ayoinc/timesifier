import type { ReactNode } from "react";
import { Button as AriaButton, type ButtonProps as AriaButtonProps } from "react-aria-components";

import { cx } from "./cx";
import { doing } from "./doing";
import { WaitingLabel } from "./WaitingLabel";

// Material 3 Expressive button, small size: 44px tall, 16px either side, label-large.
// Material draws it 40px; it is drawn 44px so that what is pressed is what is seen
// (docs/design-system.md, "Targets"). Its corners are the corner scale's `large-increased` step; pressed, they settle
// to the `small` step on the spring.
//
// The large size is the action of a page nobody is signed in on, as the home
// page draws its own: 48px tall, 24px either side, title-medium, and the `small`
// corner throughout (docs/design-direction.md, "Buttons").

const BASE =
	"relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 " +
	"outline-none state-layer transition-control " +
	"data-hovered:state-hover data-focus-visible:state-focus data-focus-visible:focus-indicator " +
	"data-pressed:state-pressed data-pending:cursor-progress " +
	"data-disabled:cursor-not-allowed data-disabled:text-disabled data-disabled:shadow-none";

const SIZES = {
	small: "h-11 min-w-11 rounded-large-increased text-label-large data-pressed:rounded-small",
	large: "h-12 rounded-small px-6 text-title-medium",
} as const;

/** The padding at each side of a small button. A large one has its own. */
const SMALL_PADDING = {
	filled: "px-4",
	tonal: "px-4",
	outlined: "px-4",
	text: "px-3",
	danger: "px-4",
	"outlined-danger": "px-4",
} as const;

const VARIANTS = {
	filled:
		"over-primary text-on-primary data-hovered:not-data-pressed:shadow-level1 data-disabled:bg-disabled",
	tonal:
		"over-secondary-container text-on-secondary-container data-hovered:not-data-pressed:shadow-level1 data-disabled:bg-disabled",
	outlined: "border border-outline-variant text-on-surface-variant",
	text: "text-primary",
	// The error colour, for the one action that cannot be undone: the confirmation
	// of a deletion. Disabled, it is drawn like any disabled filled button.
	danger:
		"over-error text-on-error data-hovered:not-data-pressed:shadow-level1 data-disabled:bg-disabled",
	// The error colour, outlined: the action that opens a destructive confirmation
	// ("Delete organisation"). The confirmation itself is `danger`.
	"outlined-danger": "border border-error text-error data-disabled:border-outline-variant",
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
	 * `tonal`, `outlined` and `text` step down from it. `danger` takes the place of
	 * `filled` when the action cannot be undone. Defaults to `filled`.
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
	/**
	 * Whether the request the button sent is on its way. A pending button cannot
	 * be pressed or submit its form again, stays in the focus order, and after
	 * 400ms says what it is doing beside the WaitClock. Give it (true or false) to
	 * every button that sends a request: from the start it is as wide as it will
	 * be while it waits.
	 */
	isPending?: boolean;
	/** What it says while pending. Defaults to the verb of a text label: "Save" says "Saving…". */
	pendingLabel?: string;
}

/** A filled button is ink or amber: the clock on it is drawn in its text colour alone. */
const CLOCK_TONE = {
	filled: "one",
	tonal: "one",
	outlined: "two",
	text: "two",
	danger: "one",
	"outlined-danger": "two",
} as const;

/**
 * A button with a text label. Inside a `Dialog` or `Sheet`, `slot="close"` makes
 * it close the overlay.
 */
export function Button({
	variant = "filled",
	size = "small",
	icon,
	children,
	isPending,
	pendingLabel,
	...props
}: ButtonProps) {
	return (
		<AriaButton
			{...props}
			isPending={isPending}
			className={cx(
				BASE,
				SIZES[size],
				size === "small" && SMALL_PADDING[variant],
				VARIANTS[variant],
			)}
		>
			{isPending === undefined ? (
				<>
					{icon}
					{children}
				</>
			) : (
				<WaitingLabel
					waiting={isPending}
					doing={pendingLabel ?? (typeof children === "string" ? doing(children) : "Sending…")}
					tone={CLOCK_TONE[variant]}
				>
					{icon}
					{children}
				</WaitingLabel>
			)}
		</AriaButton>
	);
}
