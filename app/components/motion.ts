// How overlays enter and leave. React Aria marks an overlay with `data-entering`
// on its first frame and `data-exiting` while it leaves, and waits for the
// transition to end before removing it. These are CSS transitions, so opening and
// closing in quick succession turns the movement around from where it is.
//
// With reduced motion requested only opacity changes: the `motion-safe` classes
// that move or scale do not apply, and `motion-reduce:transition-opacity` leaves
// opacity as the one property that transitions.

/** A menu, a select list: grows from 90% out of its trigger on the spring, fades as it goes. */
export const POPOVER_MOTION =
	"transition duration-spring ease-spring motion-reduce:transition-opacity motion-reduce:duration-short4 motion-reduce:ease-standard " +
	"data-entering:opacity-0 data-exiting:opacity-0 " +
	"motion-safe:data-entering:scale-90 motion-safe:data-exiting:scale-90 " +
	"data-exiting:duration-short3 data-exiting:ease-emphasized-accelerate " +
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
 * A sheet. Under the `medium` breakpoint it is a bottom sheet and slides up from
 * the bottom edge and back down; from `medium` it is a dialog in the middle of
 * the window and fades in growing from 95%.
 */
export const SHEET_MOTION =
	"transition duration-medium4 ease-emphasized-decelerate motion-reduce:transition-opacity motion-reduce:duration-short4 " +
	"max-medium:motion-safe:data-entering:translate-y-full max-medium:motion-safe:data-exiting:translate-y-full " +
	"motion-reduce:data-entering:opacity-0 motion-reduce:data-exiting:opacity-0 " +
	"medium:data-entering:opacity-0 medium:data-exiting:opacity-0 " +
	"medium:motion-safe:data-entering:scale-95 medium:motion-safe:data-exiting:scale-95 " +
	"data-exiting:duration-short4 data-exiting:ease-emphasized-accelerate";
