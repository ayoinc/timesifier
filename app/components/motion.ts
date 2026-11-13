// How overlays enter and leave. React Aria marks an overlay with `data-entering`
// on its first frame and `data-exiting` while it leaves, and waits for the
// transition to end before removing it. These are CSS transitions, so opening and
// closing in quick succession turns the movement around from where it is.
//
// With reduced motion requested only opacity changes: the `motion-safe` classes
// that move or scale do not apply, and `motion-reduce:transition-opacity` leaves
// opacity as the one property that transitions.

/**
 * A menu, a select list: grows from 90% out of its trigger on the spring; leaves
 * quicker than it came, in 100ms by its opacity alone (TS-114, harvest sweep
 * S2-15). Dismissed with Escape it is gone at once (`settleOnEscape`).
 */
export const POPOVER_MOTION =
	"popover-motion transition duration-spring ease-spring motion-reduce:transition-opacity motion-reduce:duration-short4 motion-reduce:ease-standard " +
	"data-entering:opacity-0 data-exiting:opacity-0 motion-safe:data-entering:scale-90 " +
	"data-exiting:transition-opacity data-exiting:duration-short2 data-exiting:ease-emphasized-accelerate " +
	"data-[placement=bottom]:origin-top data-[placement=top]:origin-bottom";

/** A tooltip: the same, smaller and quicker. */
export const TOOLTIP_MOTION =
	"transition duration-short4 ease-emphasized-decelerate motion-reduce:transition-opacity " +
	"data-entering:opacity-0 data-exiting:opacity-0 " +
	"motion-safe:data-entering:scale-90 motion-safe:data-exiting:scale-90 " +
	"data-exiting:duration-short2 data-exiting:ease-emphasized-accelerate";

/** The scrim behind a dialog or a sheet: a fade. */
export const SCRIM_MOTION =
	"transition-opacity duration-medium2 ease-standard data-entering:opacity-0 data-exiting:opacity-0 data-exiting:duration-short4";

/** A dialog: rises a little and grows from 90% on the spring. */
export const DIALOG_MOTION =
	"transition duration-spring ease-spring motion-reduce:transition-opacity motion-reduce:duration-short4 motion-reduce:ease-standard " +
	"data-entering:opacity-0 data-exiting:opacity-0 " +
	"motion-safe:data-entering:translate-y-4 motion-safe:data-entering:scale-90 " +
	"motion-safe:data-exiting:scale-95 " +
	"data-exiting:duration-short4 data-exiting:ease-emphasized-accelerate";

/**
 * A sheet. Under the `expanded` breakpoint it is a bottom sheet and slides up from
 * the bottom edge and back down; from `expanded` it is a dialog in the middle of
 * the window and fades in growing from 95%.
 */
export const SHEET_MOTION =
	"transition duration-medium4 ease-emphasized-decelerate motion-reduce:transition-opacity motion-reduce:duration-short4 " +
	"max-expanded:motion-safe:data-entering:translate-y-full max-expanded:motion-safe:data-exiting:translate-y-full " +
	"motion-reduce:data-entering:opacity-0 motion-reduce:data-exiting:opacity-0 " +
	"expanded:data-entering:opacity-0 expanded:data-exiting:opacity-0 " +
	"expanded:motion-safe:data-entering:scale-95 expanded:motion-safe:data-exiting:scale-95 " +
	"data-exiting:duration-short4 data-exiting:ease-emphasized-accelerate";

/**
 * Dismissing with Escape is not animated (TS-114, harvest sweep S2-15). While
 * the key is down, and for the frames in which what it closed leaves and the
 * focus goes back to what opened it, the document carries `data-escaping`,
 * under which a popover (`popover-motion`) and the button it opened from
 * (`aria-haspopup`) do not transition (app/app.css). A menu, a list or a
 * picker is gone in the frame after the key, and its button takes its state
 * at once, its focus ring with it. Installed once, in the
 * browser, by the root of the application.
 */
export function settleOnEscape() {
	const root = document.documentElement;
	let frame = 0;
	const down = (event: KeyboardEvent) => {
		if (event.key !== "Escape") return;
		cancelAnimationFrame(frame);
		// A popover already on its way out, such as a menu whose item opened a
		// sheet that this Escape closes, is finished first. The mark would cut
		// its exit short, and React Aria, waiting for that exit to finish, would
		// keep the popover open with the focus given back into it.
		for (const leaving of document.querySelectorAll(".popover-motion[data-exiting]")) {
			for (const animation of leaving.getAnimations()) animation.finish();
		}
		root.dataset.escaping = "";
	};
	// React Aria gives the focus back in the frame after the overlay leaves; the mark stays one frame more.
	const up = (event: KeyboardEvent) => {
		if (event.key !== "Escape") return;
		frame = requestAnimationFrame(() => {
			frame = requestAnimationFrame(() => {
				delete root.dataset.escaping;
			});
		});
	};
	window.addEventListener("keydown", down, true);
	window.addEventListener("keyup", up, true);
	return () => {
		cancelAnimationFrame(frame);
		window.removeEventListener("keydown", down, true);
		window.removeEventListener("keyup", up, true);
		delete root.dataset.escaping;
	};
}
