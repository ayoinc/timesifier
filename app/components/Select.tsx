import { useRef } from "react";
import {
	type AriaListBoxOptions,
	mergeProps,
	useButton,
	useFocusRing,
	useHiddenSelect,
	useHover,
	useListBox,
	useOption,
	useSelect,
} from "react-aria";
import { Popover } from "react-aria-components";
import { Item, type Node, type SelectState, useSelectState } from "react-stately";

import { cx } from "./cx";
import { FIELD_ERROR, fieldContainer, fieldIndicator, fieldLabel, fieldSupporting } from "./field";
import { ArrowDropDownIcon } from "./icons/ArrowDropDownIcon";
import { POPOVER_MOTION } from "./motion";

// Built on React Aria's hooks and not on its Select component. The component
// renders a native <select> for form submission and autofill, and hides it with a
// `style` attribute, which the Content Security Policy blocks in server-rendered
// HTML. `useHiddenSelect` gives the same element; here a class hides it.
//
// The field is the Material 3 filled field (see field.ts); the list is the
// Material 3 Expressive menu (see Menu.tsx).

export interface SelectOption {
	/** The value submitted with a form and passed to `onChange`. */
	id: string;
	/** What the person reads. Typing its first letters moves to it. */
	label: string;
	/** Shown, but cannot be chosen. */
	isDisabled?: boolean;
}

export interface SelectProps {
	/** Names the field. */
	label: string;
	/** The choices, in the order shown. */
	options: SelectOption[];
	/** The field's name when submitted with a form. */
	name?: string;
	/** The chosen option's id, when the parent holds the value. */
	value?: string | null;
	/** The option chosen at first, when the field holds its own value. */
	defaultValue?: string | null;
	/** Called with the id of the option the person chose. */
	onChange?: (id: string | null) => void;
	/** Supporting text under the field. */
	description?: string;
	/** Error text under the field, shown while the field is invalid. */
	errorMessage?: string;
	isRequired?: boolean;
	isDisabled?: boolean;
	isInvalid?: boolean;
	/** Opens the list at once. For the component gallery; a person opens it themselves. */
	defaultOpen?: boolean;
}

/**
 * A field that offers one choice from a list. Arrow keys, Home, End and typing
 * move through the list; Enter chooses; Escape closes without choosing.
 */
export function Select({ options, onChange, description, errorMessage, ...props }: SelectProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const selectRef = useRef<HTMLSelectElement>(null);
	const ariaProps = {
		...props,
		description,
		errorMessage,
		items: options,
		disabledKeys: options.filter((option) => option.isDisabled).map((option) => option.id),
		onChange:
			onChange && ((key: string | number | null) => onChange(key === null ? null : `${key}`)),
		children: (option: SelectOption) => <Item textValue={option.label}>{option.label}</Item>,
	};
	const state = useSelectState(ariaProps);
	const {
		labelProps,
		triggerProps,
		valueProps,
		menuProps,
		descriptionProps,
		errorMessageProps,
		isInvalid,
		validationErrors,
	} = useSelect(ariaProps, state, triggerRef);
	const { buttonProps, isPressed } = useButton(triggerProps, triggerRef);
	const { hoverProps, isHovered } = useHover({ isDisabled: props.isDisabled });
	const { focusProps, isFocused, isFocusVisible } = useFocusRing();
	const { selectProps } = useHiddenSelect({ ...props, selectRef }, state, triggerRef);

	const error = errorMessage ?? validationErrors.join(" ");
	const hasValue = state.selectedItem !== null;
	const field = { isInvalid, isDisabled: !!props.isDisabled, isActive: state.isOpen };

	return (
		<div
			className="relative flex flex-col gap-1"
			data-open={state.isOpen || undefined}
			data-disabled={props.isDisabled || undefined}
			data-invalid={isInvalid || undefined}
			data-required={props.isRequired || undefined}
		>
			<div
				className={cx(
					fieldContainer(field),
					"has-data-hovered:state-hover has-data-pressed:state-pressed",
				)}
			>
				<button
					{...mergeProps(buttonProps, hoverProps, focusProps)}
					ref={triggerRef}
					data-hovered={isHovered || undefined}
					data-pressed={isPressed || undefined}
					data-focused={isFocused || undefined}
					data-focus-visible={isFocusVisible || undefined}
					className="peer flex size-full cursor-pointer items-center rounded-t-extra-small ps-4 pe-3 pt-6 pb-2 text-start text-body-large outline-none data-focus-visible:focus-indicator-inner disabled:cursor-not-allowed"
				>
					<span {...valueProps} className="min-w-0 flex-1 truncate">
						{state.selectedItem?.rendered}
					</span>
					<ArrowDropDownIcon
						className={cx(
							"-mt-4 transition motion-reduce:transition-none",
							state.isOpen && "rotate-180",
							!field.isDisabled && (isInvalid ? "text-error" : "text-on-surface-variant"),
						)}
					/>
				</button>
				<span
					{...labelProps}
					className={cx(
						fieldLabel(field),
						"end-12",
						!hasValue &&
							!state.isOpen &&
							"peer-not-data-focused:top-4 peer-not-data-focused:text-body-large",
					)}
				>
					{props.label}
					{props.isRequired && <span aria-hidden="true"> *</span>}
				</span>
				<span className={fieldIndicator(field)} />
			</div>
			{description && !isInvalid && (
				<span {...descriptionProps} className={fieldSupporting(field)}>
					{description}
				</span>
			)}
			{isInvalid && error && (
				<span {...errorMessageProps} className={FIELD_ERROR}>
					{error}
				</span>
			)}

			{/* The native select behind the field: what a form submits and a browser autofills. */}
			<div aria-hidden="true" data-react-aria-prevent-focus className="sr-only">
				<label>
					{props.label}
					<select {...selectProps} ref={selectRef}>
						<option value="" />
						{options.map((option) => (
							<option key={option.id} value={option.id}>
								{option.label}
							</option>
						))}
					</select>
				</label>
			</div>

			<Popover
				trigger="Select"
				triggerRef={triggerRef}
				isOpen={state.isOpen}
				onOpenChange={state.setOpen}
				placement="bottom start"
				offset={4}
				aria-labelledby={labelProps.id}
				className={cx(
					POPOVER_MOTION,
					"min-w-(--trigger-width) overflow-auto rounded-large bg-surface-container-low shadow-level2 outline-none",
				)}
			>
				<ListBox {...menuProps} state={state} />
			</Popover>
		</div>
	);
}

interface ListBoxProps extends AriaListBoxOptions<SelectOption> {
	state: SelectState<SelectOption>;
}

function ListBox({ state, ...props }: ListBoxProps) {
	const ref = useRef<HTMLUListElement>(null);
	const { listBoxProps } = useListBox(props, state, ref);
	return (
		<ul {...listBoxProps} ref={ref} className="flex flex-col gap-0.5 p-1 outline-none">
			{[...state.collection].map((item) => (
				<Option key={item.key} item={item} state={state} />
			))}
		</ul>
	);
}

function Option({ item, state }: { item: Node<SelectOption>; state: SelectState<SelectOption> }) {
	const ref = useRef<HTMLLIElement>(null);
	const { optionProps, isSelected, isFocused, isFocusVisible, isPressed, isDisabled } = useOption(
		{ key: item.key },
		state,
		ref,
	);
	return (
		<li
			{...optionProps}
			ref={ref}
			data-selected={isSelected || undefined}
			data-focused={isFocused || undefined}
			data-focus-visible={isFocusVisible || undefined}
			data-pressed={isPressed || undefined}
			data-disabled={isDisabled || undefined}
			className={cx(
				"flex min-h-11 cursor-pointer select-none items-center px-4 text-label-large outline-none state-layer transition-control",
				"data-focused:state-hover data-focus-visible:state-focus data-focus-visible:focus-indicator-inner data-pressed:state-pressed",
				"data-disabled:cursor-not-allowed data-disabled:text-disabled",
				isSelected
					? "rounded-medium bg-tertiary-container text-on-tertiary-container"
					: "rounded-extra-small text-on-surface",
			)}
		>
			{item.rendered}
		</li>
	);
}
