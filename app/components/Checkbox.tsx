import { type ReactNode, useRef } from "react";
import {
	type AriaCheckboxProps,
	mergeProps,
	useCheckbox,
	useFocusRing,
	useHover,
} from "react-aria";
import { useToggleState } from "react-stately";

import { cx } from "./cx";
import { CheckIcon } from "./icons/CheckIcon";
import { RemoveIcon } from "./icons/RemoveIcon";

// Built on React Aria's hooks and not on its Checkbox component: the component
// hides the native input with a `style` attribute, which the Content Security
// Policy blocks in server-rendered HTML. Here the input is hidden by a class.
//
// Material 3 checkbox: an 18px box with a 2px outline inside a 40px state layer
// and a 48px touch target. The corner is the scale's smallest step, 4px.

export interface CheckboxProps
	extends Pick<
		AriaCheckboxProps,
		| "name"
		| "value"
		| "isSelected"
		| "defaultSelected"
		| "onChange"
		| "isIndeterminate"
		| "isRequired"
		| "isDisabled"
		| "isInvalid"
		| "autoFocus"
	> {
	/** The label beside the box. */
	children: ReactNode;
}

/** A box that is ticked or not, with its label. `isIndeterminate` shows a dash for "some of these". */
export function Checkbox(props: CheckboxProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const state = useToggleState(props);
	const { labelProps, inputProps, isSelected, isPressed, isDisabled, isInvalid } = useCheckbox(
		props,
		state,
		inputRef,
	);
	const { hoverProps, isHovered } = useHover({ isDisabled });
	const { focusProps, isFocusVisible } = useFocusRing();

	const isMarked = isSelected || !!props.isIndeterminate;
	// The colour of the state layer, and of the box once it is marked.
	const tone = isDisabled
		? "text-disabled"
		: isInvalid
			? "text-error"
			: isMarked
				? "text-primary"
				: "text-on-surface";
	const box = isMarked
		? "border-current bg-current"
		: isDisabled || isInvalid
			? "border-current"
			: "border-on-surface-variant group-data-hovered:border-on-surface group-data-focus-visible:border-on-surface group-data-pressed:border-on-surface";
	const mark = isDisabled ? "text-surface" : isInvalid ? "text-on-error" : "text-on-primary";
	const Mark = props.isIndeterminate ? RemoveIcon : CheckIcon;

	return (
		<label
			{...mergeProps(labelProps, hoverProps)}
			data-selected={isSelected || undefined}
			data-indeterminate={props.isIndeterminate || undefined}
			data-hovered={isHovered || undefined}
			data-pressed={isPressed || undefined}
			data-focus-visible={isFocusVisible || undefined}
			data-disabled={isDisabled || undefined}
			data-invalid={isInvalid || undefined}
			className={cx(
				"group relative inline-flex min-h-12 select-none items-center gap-1 text-body-large",
				isDisabled ? "cursor-not-allowed text-disabled" : "cursor-pointer text-on-surface",
			)}
		>
			<input {...mergeProps(inputProps, focusProps)} ref={inputRef} className="sr-only" />
			<span
				className={cx(
					"m-1 grid size-10 shrink-0 place-items-center rounded-full state-layer transition-control",
					"group-data-hovered:state-hover group-data-focus-visible:state-focus group-data-focus-visible:focus-indicator group-data-pressed:state-pressed",
					tone,
				)}
			>
				<span
					className={cx(
						"grid size-4.5 place-items-center rounded-extra-small border-2 transition-colors",
						box,
					)}
				>
					<span
						className={cx(
							"grid transition motion-reduce:transition-opacity",
							isMarked ? "opacity-100" : "opacity-0 motion-safe:scale-50",
							mark,
						)}
					>
						<Mark size="small" />
					</span>
				</span>
			</span>
			{props.children}
		</label>
	);
}
