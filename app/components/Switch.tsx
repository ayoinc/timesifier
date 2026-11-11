import { type ReactNode, useRef } from "react";
import { type AriaSwitchProps, mergeProps, useFocusRing, useHover, useSwitch } from "react-aria";
import { useToggleState } from "react-stately";

import { cx } from "./cx";

// Built on React Aria's hooks and not on its Switch component, for the reason
// given in Checkbox.tsx: the native input is hidden by a class, not a `style` attribute.
//
// Material 3 switch: a 52 by 32px track with a 2px outline. The handle is 16px
// when off, 24px when on and 28px while pressed, inside a 40px state layer.

export interface SwitchProps
	extends Pick<
		AriaSwitchProps,
		| "name"
		| "value"
		| "isSelected"
		| "defaultSelected"
		| "onChange"
		| "isDisabled"
		| "isReadOnly"
		| "autoFocus"
	> {
	/** The label beside the switch: the setting it turns on. */
	children: ReactNode;
}

/** A setting that is on or off and takes effect at once. */
export function Switch(props: SwitchProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const state = useToggleState(props);
	const { labelProps, inputProps, isSelected, isPressed, isDisabled } = useSwitch(
		props,
		state,
		inputRef,
	);
	const { hoverProps, isHovered } = useHover({ isDisabled });
	const { focusProps, isFocusVisible } = useFocusRing();

	const track = isDisabled
		? isSelected
			? "border-transparent bg-disabled"
			: "border-disabled bg-disabled-field"
		: isSelected
			? "border-primary bg-primary"
			: "border-outline bg-surface-container-highest";
	// The colour of the state layer around the handle.
	const tone = isDisabled ? "text-disabled" : isSelected ? "text-primary" : "text-on-surface";
	// Material turns a selected handle to `primary-container` under the pointer. Here
	// `primary` is that same yellow in the dark scheme, so the handle keeps its colour
	// and the state shows in its size and in the layer around it.
	const handle = isDisabled
		? isSelected
			? "bg-surface"
			: "bg-current"
		: isSelected
			? "bg-on-primary"
			: "bg-outline group-data-hovered:bg-on-surface-variant group-data-focus-visible:bg-on-surface-variant group-data-pressed:bg-on-surface-variant";

	return (
		<label
			{...mergeProps(labelProps, hoverProps)}
			data-selected={isSelected || undefined}
			data-hovered={isHovered || undefined}
			data-pressed={isPressed || undefined}
			data-focus-visible={isFocusVisible || undefined}
			data-disabled={isDisabled || undefined}
			className={cx(
				"group relative inline-flex min-h-12 select-none items-center gap-4 text-body-large",
				isDisabled ? "cursor-not-allowed text-disabled" : "cursor-pointer text-on-surface",
			)}
		>
			<input {...mergeProps(inputProps, focusProps)} ref={inputRef} className="sr-only" />
			<span
				className={cx(
					"relative h-8 w-13 shrink-0 rounded-full border-2 transition-colors",
					"group-data-focus-visible:focus-indicator",
					track,
				)}
			>
				{/* The state layer carries the handle from one end of the track to the other. */}
				<span
					className={cx(
						"absolute -start-1.5 -top-1.5 grid size-10 place-items-center rounded-full state-layer",
						"transition duration-spring ease-spring motion-reduce:transition-colors",
						"group-data-hovered:state-hover group-data-focus-visible:state-focus group-data-pressed:state-pressed",
						isSelected && "translate-x-5 rtl:-translate-x-5",
						tone,
					)}
				>
					<span
						className={cx(
							"rounded-full transition-all duration-spring ease-spring motion-reduce:transition-colors",
							isSelected ? "size-6" : "size-4",
							"group-data-pressed:size-7",
							handle,
						)}
					/>
				</span>
			</span>
			{props.children}
		</label>
	);
}
