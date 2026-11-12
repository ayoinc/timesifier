import { startTransition, useEffect, useState } from "react";
import { useNavigation } from "react-router";

import { type DestinationId, destinationIndex, destinations } from "./destinations";

// How a move to another destination looks while it waits for the server
// (docs/design-system.md, "Shell", "While the page waits"). A quick answer shows
// nothing but the page: it slides in the direction of travel when it arrives.
// Once the wait has lasted `SKELETON_DELAY_MS` the person has their answer that
// the press landed: the indicator moves to the destination and the page they
// left gives way to the destination's shape (DestinationSkeleton.tsx), sliding
// as the page would have. When the page arrives it takes the shape's place and
// its sections come in one after another (`data-reveal`, app/app.css).
//
// A move within the destination (a filter, another week, one project's own
// page) keeps the page on screen with the pending bar alone: the person is
// still looking at it. So does a form that was sent.

/** How long a move waits before the destination's shape replaces the page: the pending bar's delay. */
export const SKELETON_DELAY_MS = 150;

export interface Arrival {
	/** The destination drawn: the one moved to once its shape is shown, else the one in the address. */
	index: number;
	/** The destination whose shape stands in for its page, while it waits. */
	waitingFor: DestinationId | null;
	/** The address whose sections come in one after another: the page that took a shape's place. */
	revealing: string | null;
}

export function useArrival(organisation: string | undefined, pathname: string): Arrival {
	const navigation = useNavigation();
	const here = organisation ? destinationIndex(organisation, pathname) : -1;

	// The destination being moved to by a link: not a form, and not this one.
	const to =
		navigation.state === "loading" && navigation.formMethod === undefined
			? navigation.location
			: undefined;
	const next = organisation && to ? destinationIndex(organisation, to.pathname) : -1;
	const moving = to && next >= 0 && next !== here ? to.key : null;

	// Which move has waited long enough to show its destination's shape.
	const [late, setLate] = useState<string | null>(null);
	useEffect(() => {
		if (moving === null) return;
		// A transition, so the shape slides in the direction of travel and the
		// indicator travels, as when a page arrives (layout.tsx).
		const timer = setTimeout(() => startTransition(() => setLate(moving)), SKELETON_DELAY_MS);
		return () => clearTimeout(timer);
	}, [moving]);
	// The page that arrives after its shape was shown reveals its sections. Worked
	// out while rendering, so the sections are hidden on the very frame they arrive.
	const [shapeShown, setShapeShown] = useState(false);
	const [revealing, setRevealing] = useState<string | null>(null);
	// Once a shape is shown, a press on another destination swaps it for that
	// one's at once: the page that was left never comes back in between.
	const waiting = moving !== null && (late === moving || shapeShown) ? next : null;
	if (waiting !== null && !shapeShown) setShapeShown(true);
	if (waiting === null && shapeShown && navigation.state === "idle") {
		setShapeShown(false);
		setRevealing(pathname);
	}

	return {
		index: waiting ?? here,
		waitingFor: waiting === null ? null : (destinations[waiting]?.id ?? null),
		revealing: revealing === pathname ? revealing : null,
	};
}
