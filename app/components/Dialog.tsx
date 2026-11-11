import type { ReactNode } from "react";
import {
	Dialog as AriaDialog,
	DialogTrigger,
	Heading,
	Modal,
	ModalOverlay,
	type ModalOverlayProps,
} from "react-aria-components";

import { cx } from "./cx";
import { DIALOG_MOTION, SCRIM_MOTION } from "./motion";

// Material 3 basic dialog: a surface-container-high card with `extra-large`
// corners at elevation 3, between 280 and 560px wide with 24px of padding, over a 32% scrim.

/** Wraps a button and a `Dialog` or `Sheet`: pressing the button opens it. */
export { DialogTrigger };

export interface DialogProps
	extends Pick<ModalOverlayProps, "isOpen" | "defaultOpen" | "onOpenChange"> {
	/** The headline. It is the dialog's accessible name. */
	title: string;
	/** What the person needs to know to decide. */
	children?: ReactNode;
	/**
	 * The buttons, least important first. Give the one that confirms `variant="filled"`
	 * and the others `variant="text"`. A button with `slot="close"` closes the dialog.
	 */
	actions?: ReactNode;
	/**
	 * `alertdialog` for a message the person must answer before going on, such as
	 * confirming a deletion. Defaults to `dialog`.
	 */
	role?: "dialog" | "alertdialog";
	/**
	 * Whether pressing outside closes the dialog. Escape always does. Defaults to
	 * true; set false when closing by accident would lose work.
	 */
	isDismissable?: boolean;
}

/**
 * A modal dialog in the middle of the window, for a decision that interrupts.
 * Focus moves into it, stays inside while it is open, and returns to the control
 * that opened it. For a task that belongs to the current view, use a `Sheet`.
 */
export function Dialog({
	title,
	children,
	actions,
	role = "dialog",
	isDismissable = true,
	...props
}: DialogProps) {
	return (
		<ModalOverlay
			{...props}
			isDismissable={isDismissable}
			className={cx(
				"fixed inset-x-0 top-0 z-50 grid h-(--visual-viewport-height) place-items-center bg-scrim-dim p-6",
				SCRIM_MOTION,
			)}
		>
			<Modal
				className={cx(
					"flex max-h-full w-full min-w-70 max-w-140 flex-col overflow-auto rounded-extra-large bg-surface-container-high shadow-level3",
					DIALOG_MOTION,
				)}
			>
				<AriaDialog role={role} className="flex flex-col gap-4 p-6 outline-none">
					<Heading slot="title" className="text-headline-small text-on-surface">
						{title}
					</Heading>
					{children && <div className="text-body-medium text-on-surface-variant">{children}</div>}
					{actions && <div className="mt-2 flex flex-wrap justify-end gap-2">{actions}</div>}
				</AriaDialog>
			</Modal>
		</ModalOverlay>
	);
}
