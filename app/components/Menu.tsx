import type { ReactNode } from "react";
import {
	Menu as AriaMenu,
	MenuItem as AriaMenuItem,
	MenuTrigger,
	Popover,
} from "react-aria-components";

import { cx } from "./cx";
import { POPOVER_MOTION } from "./motion";

// Material 3 Expressive menu: a surface-container-low list with 16px corners at
// elevation 2, between 112 and 280px wide. Items are 44px tall, label-large,
// with 4px corners; the focus indicator sits inside the item.

/** Wraps a button and a `Menu`: pressing the button, or Enter, Space or an arrow key on it, opens the menu. */
export { MenuTrigger };

export interface MenuProps {
	/** Called with the `id` of the item the person chose. */
	onAction?: (id: string) => void;
	/** Which edge of the button the menu lines up with. Defaults to the start. */
	align?: "start" | "end";
	/**
	 * Plain text above the items, such as who the menu is about. It is not an
	 * item: the arrow keys pass over it.
	 */
	header?: ReactNode;
	/** The `MenuItem`s. */
	children: ReactNode;
}

/**
 * A list of actions that opens from a button. Arrow keys, Home, End and typing
 * move through it; Enter or Space chooses; Escape closes. Its accessible name is
 * the button's.
 */
export function Menu({ onAction, align = "start", header, children }: MenuProps) {
	return (
		<Popover
			placement={`bottom ${align}`}
			offset={4}
			className={cx(
				POPOVER_MOTION,
				"min-w-28 max-w-70 overflow-auto rounded-large bg-surface-container-low shadow-level2 outline-none",
			)}
		>
			{header && (
				<div className="border-b border-outline-variant px-5 pt-4 pb-3 text-on-surface">
					{header}
				</div>
			)}
			<AriaMenu
				onAction={onAction && ((key) => onAction(`${key}`))}
				className="flex flex-col gap-0.5 p-1 outline-none"
			>
				{children}
			</AriaMenu>
		</Popover>
	);
}

export interface MenuItemProps {
	/** Passed to the menu's `onAction` when this item is chosen. */
	id: string;
	/** The item's label. Typing its first letters moves to it. */
	children: string;
	/** An icon drawn before the label, at the `medium` size. */
	icon?: ReactNode;
	/** Shown, but cannot be chosen. */
	isDisabled?: boolean;
	/** Makes the item a link to this address, followed by the router when one is provided. */
	href?: string;
	/** Keeps the menu open when this item is chosen, for an action that may fail and say so in the menu. */
	keepsOpen?: boolean;
}

/** One action in a `Menu`. */
export function MenuItem({ id, children, icon, isDisabled, href, keepsOpen }: MenuItemProps) {
	return (
		<AriaMenuItem
			id={id}
			textValue={children}
			isDisabled={isDisabled}
			href={href}
			shouldCloseOnSelect={keepsOpen ? false : undefined}
			className={
				"flex min-h-11 cursor-pointer select-none items-center gap-3 rounded-extra-small px-4 text-label-large text-on-surface outline-none state-layer transition-control " +
				"data-hovered:state-hover data-focused:state-hover data-focus-visible:state-focus data-focus-visible:focus-indicator-inner data-pressed:state-pressed " +
				"data-disabled:cursor-not-allowed data-disabled:text-disabled"
			}
		>
			{icon}
			{children}
		</AriaMenuItem>
	);
}
