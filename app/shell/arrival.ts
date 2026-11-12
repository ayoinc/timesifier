import { startTransition, useEffect, useLayoutEffect, useState } from "react";
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
	// The move itself, not its location's key: Back and Forward return to a history
	// entry with the key it had, and a move that ended may not count as late again.
	const moving = to && next >= 0 && next !== here ? to : null;

	// Which move has waited long enough to show its destination's shape.
	const [late, setLate] = useState<typeof to | null>(null);
	useEffect(() => {
		if (moving === null) return;
		// A transition, so the shape slides in the direction of travel and the
		// indicator travels, as when a page arrives (layout.tsx).
		const timer = setTimeout(() => startTransition(() => setLate(moving)), SKELETON_DELAY_MS);
		return () => clearTimeout(timer);
	}, [moving]);
	// The destination whose shape is on screen, from the first frame it shows to
	// the frame its page takes its place.
	const [shape, setShape] = useState<number | null>(null);
	// The shape that has waited long enough slides in with the indicator. Set
	// while rendering, in the transition that brought the timer's answer.
	if (moving !== null && late === moving && shape === null) setShape(next);
	// A press on another destination while a shape is shown swaps it for that
	// one's at once (design rule 8). Not in the navigation's transition: a view
	// transition started for the swap would hold back the page's own arrival until
	// it had played. An update from a layout effect is not a transition, so React
	// draws it before the frame is painted and animates nothing.
	useLayoutEffect(() => {
		if (moving !== null && shape !== null && shape !== next) setShape(next);
	}, [moving, shape, next]);
	// The page that arrives after its shape was shown reveals its sections. Worked
	// out while rendering, so the sections are hidden on the very frame they arrive.
	const [revealing, setRevealing] = useState<string | null>(null);
	if (moving === null && shape !== null && navigation.state === "idle") {
		setShape(null);
		setRevealing(pathname);
	}
	const waiting = moving === null ? null : shape;

	return {
		index: waiting ?? here,
		waitingFor: waiting === null ? null : (destinations[waiting]?.id ?? null),
		revealing: revealing === pathname ? revealing : null,
	};
}
