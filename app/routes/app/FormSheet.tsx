import { type ReactNode, useEffect, useId, useRef } from "react";
import { useFetcher } from "react-router";

import { Button, type ButtonVariant } from "~/components/Button";
import { Sheet } from "~/components/Sheet";
import type { Outcome } from "~/organisations/problems";

/**
 * A sheet gives the focus back to the control that opened it. A task may have
 * removed that control with the thing it acted on, a member or an invitation,
 * and the focus would then be nowhere. Once the sheet has gone, a focus that
 * is nowhere goes to the page's heading.
 */
function focusHeadingIfLost() {
	let frames = 0;
	const whenGone = () => {
		// About two seconds of frames: longer than any sheet takes to leave.
		if (document.querySelector('[role="dialog"]') && frames++ < 120) {
			return requestAnimationFrame(whenGone);
		}
		// One more frame: React Aria gives the focus back in the frame after the sheet goes.
		requestAnimationFrame(() => {
			if (document.activeElement !== document.body) return;
			document.querySelector<HTMLElement>("main h1")?.focus();
		});
	};
	requestAnimationFrame(whenGone);
}

export interface FormSheetProps {
	/** The sheet's title: the task, in a few words. */
	title: string;
	/** Which of the page's actions the form asks for. Sent as the field `intent`. */
	intent: string;
	/** The label of the one primary action. */
	submitLabel: string;
	/** `danger` for the confirmation of a deletion. Defaults to `filled`. */
	submitVariant?: ButtonVariant;
	/** Holds the primary action back until what it needs is filled in: a typed name that matches. */
	isSubmitDisabled?: boolean;
	/** The label of the button that gives the task up. Defaults to "Cancel". */
	cancelLabel?: string;
	isOpen: boolean;
	/** Called when the sheet closes, whether the task was done or given up. */
	onClose: () => void;
	/**
	 * Called with what the server said when the task was done, before the sheet
	 * closes, and with the whole answer: the entries it wrote, a token to undo it.
	 */
	onDone?: (said: string, answer: Extract<Outcome, { ok: true }>) => void;
	/** Where the form is sent, when it is not the page's own action: the Timesheet's, from any page. */
	action?: string;
	/** What the person reads and fills in. Fields are part of the form. */
	children: ReactNode;
	/** `multipart/form-data` for a form with a file field. */
	encType?: "multipart/form-data";
}

/**
 * A secondary task of a page, in a sheet (design rule 3): a form with one
 * primary action that submits it to the page's own action, and Cancel.
 *
 * While the server is refusing, the sheet stays open and says why in the
 * server's place; when the task is done it closes and hands the page what to
 * say. While the request is on its way the primary action is pending: it says
 * what it is doing beside the WaitClock, and a second press does nothing.
 */
export function FormSheet({
	title,
	intent,
	submitLabel,
	submitVariant = "filled",
	isSubmitDisabled = false,
	cancelLabel = "Cancel",
	isOpen,
	onClose,
	onDone,
	children,
	encType,
	action,
}: FormSheetProps) {
	const form = useId();
	const fetcher = useFetcher<Outcome>();
	const answer = fetcher.state === "idle" ? fetcher.data : undefined;

	// The answer to one submission is acted on once.
	const handled = useRef<Outcome | undefined>(undefined);
	useEffect(() => {
		if (!answer || handled.current === answer) return;
		handled.current = answer;
		if (!answer.ok) return;
		onDone?.(answer.said, answer);
		onClose();
		focusHeadingIfLost();
	}, [answer, onDone, onClose]);

	// An answer belongs to the visit that got it: the sheet opens again without it.
	const { reset } = fetcher;
	useEffect(() => {
		if (!isOpen) reset();
	}, [isOpen, reset]);

	return (
		<Sheet
			title={title}
			isOpen={isOpen}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			actions={
				<>
					<Button variant="text" slot="close">
						{cancelLabel}
					</Button>
					<Button
						type="submit"
						form={form}
						variant={submitVariant}
						isDisabled={isSubmitDisabled}
						isPending={fetcher.state !== "idle"}
					>
						{submitLabel}
					</Button>
				</>
			}
		>
			<fetcher.Form
				id={form}
				method="post"
				action={action}
				encType={encType}
				className="flex flex-col gap-4"
				onSubmit={(event) => {
					if (fetcher.state !== "idle") event.preventDefault();
				}}
			>
				<input type="hidden" name="intent" value={intent} />
				{children}
				<p role="alert" className="text-body-medium text-error empty:hidden">
					{answer && !answer.ok ? answer.problem : null}
				</p>
			</fetcher.Form>
		</Sheet>
	);
}
