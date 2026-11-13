import { useEffect, useState } from "react";
import { useFetchers, useNavigation } from "react-router";

import { MAIN_ID } from "~/landing/Site";

// The sign that the page is waiting for the server (audit W09): a 3px bar across
// the top edge of the window, above the band, while a move to another page or a
// form sent from the page is waiting for its answer. docs/design-system.md,
// "Shell", "While the page waits".

/** How long a wait lasts before it is shown: a quicker answer shows nothing, so nothing flickers. */
const PENDING_BAR_DELAY_MS = 150;

/**
 * The start of the key of a fetcher that reads ahead behind the page, such as
 * the Timesheet's neighbours (TS-114): nobody is waiting for it, so the page
 * shows no wait for it.
 */
export const READ_AHEAD = "read-ahead:";

/** Whether React Router is waiting for the server: a move to another page, or a fetcher's form or load. */
function usePending(): boolean {
	const moving = useNavigation().state !== "idle";
	const fetching = useFetchers().some(
		({ state, key }) => state !== "idle" && !key.startsWith(READ_AHEAD),
	);
	return moving || fetching;
}

/**
 * Drawn once, by the root layout, so every page has it. While the page waits
 * its main region is `aria-busy`, at once; the bar itself appears only once the
 * wait has lasted `PENDING_BAR_DELAY_MS`, and is a `progressbar` named
 * "Loading" for as long as it is on the screen. With reduced motion requested
 * the bar stands still across the whole width (app/app.css, `.pending-bar`).
 */
export function PendingBar() {
	const pending = usePending();
	const [shown, setShown] = useState(false);

	useEffect(() => {
		if (!pending) {
			setShown(false);
			return;
		}
		// The main region is drawn by whichever layout the page has (the shell, a
		// public page, an error page); each gives it the same id.
		const main = document.getElementById(MAIN_ID);
		main?.setAttribute("aria-busy", "true");
		const timer = setTimeout(() => setShown(true), PENDING_BAR_DELAY_MS);
		return () => {
			clearTimeout(timer);
			main?.removeAttribute("aria-busy");
		};
	}, [pending]);

	if (!pending || !shown) return null;
	return (
		<div
			role="progressbar"
			aria-label="Loading"
			className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.75 overflow-hidden"
		>
			<div className="pending-bar h-full bg-on-sheet" />
		</div>
	);
}
