import { createContext, type ReactNode, useContext, useRef } from "react";
import {
	type AriaRadioGroupProps,
	type AriaRadioProps,
	mergeProps,
	useFocusRing,
	useHover,
	useRadio,
	useRadioGroup,
} from "react-aria";
import { type RadioGroupState, useRadioGroupState } from "react-stately";

import { cx } from "./cx";

// Built on React Aria's hooks and not on its RadioGroup and Radio components, for
// the reason given in Checkbox.tsx: the native input is hidden by a class, not a
// `style` attribute. The inputs are real radio buttons that share a name, so the
// group is submitted by a form with or without script.
//
// Material 3 radio button: a 20px ring with a 2px outline and a 10px dot, inside
// a 40px state layer and a 48px touch target.

const RadioGroupContext = createContext<RadioGroupState | null>(null);

export interface RadioGroupProps
	extends Pick<
		AriaRadioGroupProps,
		"name" | "value" | "defaultValue" | "onChange" | "isDisabled" | "isRequired"
	> {
	/** The question the group answers, shown above the choices. It is the group's accessible name. */
	label: string;
	/** The `Radio` choices. */
	children: ReactNode;
}

/** One choice out of a few that are all worth seeing at once. Holds `Radio` children. */
export function RadioGroup({ label, children, ...props }: RadioGroupProps) {
	const state = useRadioGroupState(props);
	const { radioGroupProps, labelProps } = useRadioGroup({ ...props, label }, state);

	return (
		<div {...radioGroupProps} className="flex flex-col">
			<span {...labelProps} className="pb-1 text-title-medium text-on-surface">
				{label}
			</span>
			<RadioGroupContext value={state}>{children}</RadioGroupContext>
		</div>
	);
}

export interface RadioProps extends Pick<AriaRadioProps, "value" | "isDisabled" | "autoFocus"> {
	/** The label beside the ring. */
	children: ReactNode;
}

/** One choice of a `RadioGroup`. `value` is what the group holds and submits when this is chosen. */
export function Radio(props: RadioProps) {
	const state = useContext(RadioGroupContext);
	if (!state) throw new Error("A Radio must be inside a RadioGroup.");

	const inputRef = useRef<HTMLInputElement>(null);
	const { labelProps, inputProps, isSelected, isPressed, isDisabled } = useRadio(
		props,
		state,
		inputRef,
	);
	const { hoverProps, isHovered } = useHover({ isDisabled });
	const { focusProps, isFocusVisible } = useFocusRing();

	// The colour of the state layer, and of the ring and the dot once chosen.
	const tone = isDisabled ? "text-disabled" : isSelected ? "text-primary" : "text-on-surface";
	const ring =
		isSelected || isDisabled
			? "border-current"
			: "border-on-surface-variant group-data-hovered:border-on-surface group-data-focus-visible:border-on-surface group-data-pressed:border-on-surface";

	return (
		<label
			{...mergeProps(labelProps, hoverProps)}
			data-selected={isSelected || undefined}
			data-hovered={isHovered || undefined}
			data-pressed={isPressed || undefined}
			data-focus-visible={isFocusVisible || undefined}
			data-disabled={isDisabled || undefined}
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
						"grid size-5 place-items-center rounded-full border-2 transition-colors",
						ring,
					)}
				>
					<span
						className={cx(
							"size-2.5 rounded-full bg-current transition motion-reduce:transition-opacity",
							isSelected ? "opacity-100" : "opacity-0 motion-safe:scale-0",
						)}
					/>
				</span>
			</span>
			{props.children}
		</label>
	);
}
