import type { ReactNode } from "react";
import {
	Dialog as AriaDialog,
	Heading,
	Modal,
	ModalOverlay,
	type ModalOverlayProps,
} from "react-aria-components";

import { cx } from "./cx";
import { SCRIM_MOTION, SHEET_MOTION } from "./motion";

// Material 3 modal bottom sheet: a surface-container-low panel with `extra-large`
// top corners at elevation 1, over a 32% scrim, at most 640px wide. From the
// `expanded` breakpoint (840px) a sheet along the bottom of a wide window reads
// as a stray strip, so there it is drawn as a dialog (taste HT-C): in the middle
// of the window, at most 480px wide, every corner `extra-large`, 24px from
// every edge. It has no drag
// handle because it is not dragged: it closes by Escape, by pressing outside, or
// by one of its own buttons.

export interface SheetProps
	extends Pick<ModalOverlayProps, "isOpen" | "defaultOpen" | "onOpenChange"> {
	/** The title at the top of the sheet. It is the sheet's accessible name. */
	title: string;
	/** One piece of content or one action. */
	children?: ReactNode;
	/** The buttons. A button with `slot="close"` closes the sheet. */
	actions?: ReactNode;
	/** Whether pressing outside closes the sheet. Escape always does. Defaults to true. */
	isDismissable?: boolean;
}

/**
 * A sheet that slides up over the current view (a dialog from 840px), for a task that is brief or
 * belongs to that view: confirming, quick editing, a warning. To assistive
 * technology it is a modal dialog: focus moves in, stays in, and returns to the
 * control that opened it. Open it with a `DialogTrigger` (see Dialog.tsx).
 */
export function Sheet({ title, children, actions, isDismissable = true, ...props }: SheetProps) {
	return (
		<ModalOverlay
			{...props}
			isDismissable={isDismissable}
			className={cx(
				"fixed inset-x-0 top-0 z-50 flex h-(--visual-viewport-height) items-end justify-center bg-scrim-dim pt-14 expanded:items-center expanded:p-6",
				SCRIM_MOTION,
			)}
		>
			<Modal
				className={cx(
					"flex max-h-full w-full max-w-160 flex-col overflow-auto rounded-t-extra-large bg-surface-container-low shadow-level1 expanded:max-w-120 expanded:rounded-extra-large",
					SHEET_MOTION,
				)}
			>
				<AriaDialog className="flex flex-col gap-4 p-6 outline-none">
					<Heading slot="title" className="text-title-large text-on-surface">
						{title}
					</Heading>
					{children && <div className="text-body-medium text-on-surface-variant">{children}</div>}
					{actions && <div className="mt-2 flex flex-wrap justify-end gap-2">{actions}</div>}
				</AriaDialog>
			</Modal>
		</ModalOverlay>
	);
}
