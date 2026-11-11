import { cx } from "./cx";

// What TextField and Select share: the Material 3 filled field. A 56px container
// with 4px top corners, a label that rests in the middle and floats to the top once
// there is a value or focus, and a line along the bottom that marks the state.
//
// The control inside the container (the input, or the select's button) carries
// the fill, the hover state layer and React Aria's `data-hovered` and
// `data-focused`. The label and the line read those two through the container
// (`group-has-data-…/field:`), never from the control as its sibling
// (`peer-data-…:`): WebKit does not restyle a text input's siblings for an
// attribute written during an event, which is when React Aria writes them, and
// the label then sits on top of what a person types. docs/design-system.md,
// "State from another element"; e2e/field-label.spec.ts runs in WebKit.

export interface FieldState {
	isInvalid: boolean;
	isDisabled: boolean;
	/** Drawn as focused although the control does not hold focus: a select whose list is open. */
	isActive?: boolean;
}

/** The 56px box the control, the label and the line sit in. */
export function fieldContainer({ isDisabled }: FieldState): string {
	return cx("group/field relative h-14", isDisabled ? "text-disabled" : "text-on-surface");
}

/**
 * The control itself, filling the container. A focused field shows no hover
 * layer: its label is the primary colour, which needs the plain fill behind it.
 * It is the `peer` for one thing only, which the browser keeps itself and
 * WebKit does follow: whether an input is empty (`peer-placeholder-shown:`).
 */
export const FIELD_CONTROL =
	"peer size-full rounded-t-extra-small outline-none state-layer over-surface-container-highest transition-control " +
	"data-hovered:not-data-focused:state-hover disabled:cursor-not-allowed disabled:bg-disabled-field";

/**
 * The label in its floated place, at the top of the container. Each field adds where
 * the label ends and, under a variant, the classes for its resting place. Over the
 * hover layer the label darkens, to keep its contrast.
 */
export function fieldLabel({ isInvalid, isDisabled, isActive }: FieldState): string {
	return cx(
		"pointer-events-none absolute start-4 top-2 truncate text-body-small",
		"transition-all duration-short4 ease-standard motion-reduce:transition-none",
		isDisabled
			? "text-disabled"
			: isInvalid
				? "text-error group-has-data-hovered/field:group-not-has-data-focused/field:text-on-error-container"
				: isActive
					? "text-primary"
					: "text-on-surface-variant group-has-data-focused/field:text-primary group-has-data-hovered/field:group-not-has-data-focused/field:text-on-surface",
	);
}

/** The line along the bottom: 1px at rest, 2px and the primary colour with focus. */
export function fieldIndicator({ isInvalid, isDisabled, isActive }: FieldState): string {
	return cx(
		"pointer-events-none absolute inset-x-0 bottom-0",
		isActive ? "h-0.5" : "h-px group-has-data-focused/field:h-0.5",
		isDisabled
			? "bg-current"
			: isInvalid
				? "bg-error group-has-data-hovered/field:group-not-has-data-focused/field:bg-on-error-container"
				: isActive
					? "bg-primary"
					: "bg-on-surface-variant group-has-data-focused/field:bg-primary group-has-data-hovered/field:group-not-has-data-focused/field:bg-on-surface",
	);
}

/** Supporting text under the container. */
export function fieldSupporting({ isDisabled }: FieldState): string {
	return cx("px-4 text-body-small", isDisabled ? "text-disabled" : "text-on-surface-variant");
}

/** Error text under the container. It takes the place of the supporting text. */
export const FIELD_ERROR = "px-4 text-body-small text-error";
