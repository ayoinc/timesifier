import {
	Button as AriaButton,
	Text,
	UNSTABLE_Toast as Toast,
	UNSTABLE_ToastContent as ToastContent,
	UNSTABLE_ToastQueue as ToastQueue,
	UNSTABLE_ToastRegion as ToastRegion,
} from "react-aria-components";

import { CloseIcon } from "./icons/CloseIcon";

// Material 3 snackbar: inverse-surface with 4px corners at elevation 3, at least
// 48px tall with 16px before the text, body-medium, at most 600px wide, one at a
// time. React Aria's toast is still exported as UNSTABLE_: its names may change
// in a minor release, and this file is the only place that uses them.

interface SnackbarContent {
	message: string;
	action?: SnackbarAction;
}

export interface SnackbarAction {
	/** One or two words: "Undo". */
	label: string;
	/** Called when the person presses the action. The snackbar then closes. */
	onAction: () => void;
}

export interface SnackbarOptions {
	/** One action the person can take about the message. */
	action?: SnackbarAction;
	/**
	 * Milliseconds until the snackbar closes itself. The clock stops while the
	 * pointer or the keyboard focus is on it. Defaults to 6 seconds, or 10 with an action.
	 */
	timeout?: number;
}

/** Holds the snackbars waiting to be shown. One `SnackbarRegion` shows them. */
export type SnackbarQueue = ToastQueue<SnackbarContent>;

/** Makes a queue of its own. The application uses the one behind `showSnackbar`. */
export function createSnackbarQueue(): SnackbarQueue {
	const queue: SnackbarQueue = new ToastQueue<SnackbarContent>({
		maxVisibleToasts: 1,
		// The queue removes a snackbar in one step. To let it leave with a transition,
		// mark it as exiting, and carry out the removal when the transition has ended.
		wrapUpdate(update, action) {
			if (action === "add") return update();
			const staying = new Set(queue.visibleToasts.map((toast) => toast.key));
			const leaving = [...document.querySelectorAll<HTMLElement>("[data-snackbar]")].filter(
				(element) => !staying.has(element.dataset.snackbar ?? ""),
			);
			for (const element of leaving) element.dataset.exiting = "true";
			const transitions = leaving.flatMap((element) => element.getAnimations());
			Promise.allSettled(transitions.map((transition) => transition.finished)).then(update);
		},
	});
	return queue;
}

const applicationQueue = createSnackbarQueue();

/**
 * Shows a brief message about something that has just happened: "Entry saved".
 * It is announced politely, never takes the keyboard focus, and closes itself.
 * Returns a function that closes it early.
 */
export function showSnackbar(
	message: string,
	options: SnackbarOptions = {},
	queue: SnackbarQueue = applicationQueue,
): () => void {
	const timeout = options.timeout ?? (options.action ? 10_000 : 6_000);
	const key = queue.add({ message, action: options.action }, { timeout });
	return () => queue.close(key);
}

export interface SnackbarRegionProps {
	/** The queue to show. Defaults to the application's, the one `showSnackbar` adds to. */
	queue?: SnackbarQueue;
}

/**
 * Where snackbars appear: along the bottom of the window. Render it once, near
 * the root of the application. It is a landmark that F6 moves to.
 */
export function SnackbarRegion({ queue = applicationQueue }: SnackbarRegionProps) {
	return (
		<ToastRegion
			queue={queue}
			className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-150 flex-col rounded-extra-small outline-none data-focus-visible:focus-indicator"
		>
			{({ toast }) => (
				<Toast
					toast={toast}
					data-snackbar={toast.key}
					className={
						"flex min-h-12 items-center gap-2 rounded-extra-small bg-inverse-surface py-1 ps-4 pe-2 text-body-medium text-inverse-on-surface shadow-level3 outline-none data-focus-visible:focus-indicator-inverse " +
						"transition duration-spring ease-spring motion-reduce:transition-opacity motion-reduce:duration-short4 motion-reduce:ease-standard " +
						"starting:opacity-0 motion-safe:starting:translate-y-4 " +
						"data-exiting:opacity-0 data-exiting:duration-short3 data-exiting:ease-emphasized-accelerate motion-safe:data-exiting:translate-y-4"
					}
				>
					{/* `status` in place of the library's `alert`: a snackbar waits its turn to be read out. */}
					<ToastContent role="status" className="min-w-0 flex-1 py-2">
						<Text slot="title">{toast.content.message}</Text>
					</ToastContent>
					{toast.content.action && (
						<AriaButton
							onPress={() => {
								toast.content.action?.onAction();
								queue.close(toast.key);
							}}
							className="relative inline-flex h-10 shrink-0 cursor-pointer select-none items-center rounded-large-increased px-3 text-inverse-primary text-label-large outline-none state-layer transition-control before:absolute before:inset-x-0 before:-inset-y-1 data-hovered:state-hover data-focus-visible:state-focus data-focus-visible:focus-indicator-inverse data-pressed:rounded-small data-pressed:state-pressed"
						>
							{toast.content.action.label}
						</AriaButton>
					)}
					<AriaButton
						slot="close"
						aria-label="Dismiss"
						className="relative inline-flex size-10 shrink-0 cursor-pointer select-none items-center justify-center rounded-large-increased outline-none state-layer transition-control before:absolute before:-inset-1 data-hovered:state-hover data-focus-visible:state-focus data-focus-visible:focus-indicator-inverse data-pressed:rounded-small data-pressed:state-pressed"
					>
						<CloseIcon />
					</AriaButton>
				</Toast>
			)}
		</ToastRegion>
	);
}
