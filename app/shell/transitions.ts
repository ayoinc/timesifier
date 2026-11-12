import { useLayoutEffect, useRef } from "react";

// How a change of destination moves. React's <ViewTransition> starts the browser's
// view transition and puts these class names on its parts; app/app.css holds the
// animations, the axis for each window size and the reduced-motion rules.

/** View-transition classes, each styled in app/app.css. */
export const TRANSITION = {
	/** The content moves on to a later destination. */
	forward: "shell-forward",
	/** The content moves back to an earlier destination. */
	back: "shell-back",
	/** The active indicator travels from the old destination to the new one. */
	indicator: "shell-indicator",
} as const;

/** The name the active indicator keeps in every destination: it is one element that moves. */
export const INDICATOR_NAME = "shell-active-indicator";

/**
 * The direction of travel while the destination at `index` is arriving: forward
 * when it is later in the order than the one on screen, back when it is earlier.
 * `null` in every other render, so that only a change of destination starts a
 * transition.
 */
export function useTravel(index: number): "forward" | "back" | null {
	// The destination on screen. It changes when the new one is committed, so the
	// render that brings a new destination still sees the old one here.
	const shown = useRef(index);
	useLayoutEffect(() => {
		shown.current = index;
	}, [index]);

	if (index > shown.current) return "forward";
	if (index < shown.current) return "back";
	return null;
}

/**
 * Ends a running view transition at once: its animations jump to their end. React
 * holds the next transition until the running one finishes, so the input that
 * starts a navigation calls this and the new page never waits for the old
 * animation (design rule 8). The press itself reaches the page because the
 * document is never part of the transition (the content's outer boundary in
 * app/routes/app/layout.tsx). Does nothing where the browser has no
 * `document.activeViewTransition`; there the next transition follows the running one.
 */
export function finishRunningTransition() {
	const { activeViewTransition } = document as Document & {
		activeViewTransition?: ViewTransition | null;
	};
	if (!activeViewTransition) return;
	// Skipping before the transition is ready rejects its `ready` promise with
	// "Transition was skipped". That is what was asked for, not an error.
	activeViewTransition.ready.catch(() => {});
	activeViewTransition.skipTransition();
}

/**
 * Whether a rejected promise is a view transition the browser skipped: an
 * `AbortError` saying "Transition was skipped", or the `InvalidStateError`
 * Chromium gives a whole-page transition (`@view-transition` in app/app.css) it
 * abandons because the page stopped taking part, as when a form sent as a whole
 * page starts its own transition on the way out.
 */
export function isSkippedTransition(reason: unknown): boolean {
	if (!(reason instanceof DOMException)) return false;
	if (reason.name === "AbortError") return reason.message.includes("Transition was skipped");
	return (
		reason.name === "InvalidStateError" &&
		reason.message.includes("Transition was aborted because of invalid state")
	);
}

let ignoringSkips = false;

/**
 * Keeps a skipped view transition from being reported as an uncaught error.
 * Skipping is the shell's design (design rule 8): a press that starts a
 * navigation ends the running transition, and when React starts the next one
 * the browser skips the one it supersedes. Each skip rejects that transition's
 * `ready` promise, which React holds and leaves unhandled, so nobody else can
 * catch it. `finishRunningTransition` catches its own skip; this catches the
 * browser's. Any other rejection is still reported. Installed once, in the
 * browser, by the root of the application.
 */
export function ignoreSkippedTransitions() {
	if (ignoringSkips || typeof window === "undefined") return;
	ignoringSkips = true;
	window.addEventListener("unhandledrejection", (event) => {
		if (isSkippedTransition(event.reason)) event.preventDefault();
	});
}
