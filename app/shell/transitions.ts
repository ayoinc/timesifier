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
 * animation (design rule 8). Does nothing where the browser has no
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
