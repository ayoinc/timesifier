import type { ReactNode } from "react";
import { Button as AriaButton, type ButtonProps as AriaButtonProps } from "react-aria-components";

import { cx } from "./cx";

// Material 3 Expressive icon button, small size: a 40px container around a 24px
// icon, with a 48px touch target. Pressed, its corners settle to 8px on the spring.

const BASE =
	"relative inline-flex size-10 shrink-0 cursor-pointer select-none items-center justify-center " +
	"rounded-large-increased outline-none state-layer transition-control " +
	"before:absolute before:-inset-1 " +
	"data-hovered:state-hover data-focus-visible:state-focus data-focus-visible:focus-indicator " +
	"data-pressed:rounded-small data-pressed:state-pressed " +
	"data-disabled:cursor-not-allowed data-disabled:text-disabled";

const VARIANTS = {
	standard: "text-on-surface-variant",
	filled: "over-primary text-on-primary data-disabled:bg-disabled",
	tonal: "over-secondary-container text-on-secondary-container data-disabled:bg-disabled",
	outlined: "border border-outline-variant text-on-surface-variant",
} as const;

export type IconButtonVariant = keyof typeof VARIANTS;

export interface IconButtonProps
	extends Pick<
		AriaButtonProps,
		"onPress" | "isDisabled" | "type" | "slot" | "autoFocus" | "id" | "aria-describedby"
	> {
	/**
	 * What the button does, in words. It is the accessible name, since an icon has
	 * none: "Start timer", not "Play".
	 */
	label: string;
	/** How much the button stands out. Defaults to `standard`: the icon alone. */
	variant?: IconButtonVariant;
	/** The icon, at its default 24px size. */
	children: ReactNode;
}

/** A button that shows only an icon. Wrap it in a `Tooltip` to show its label to sighted people. */
export function IconButton({ label, variant = "standard", children, ...props }: IconButtonProps) {
	return (
		<AriaButton {...props} aria-label={label} className={cx(BASE, VARIANTS[variant])}>
			{children}
		</AriaButton>
	);
}
