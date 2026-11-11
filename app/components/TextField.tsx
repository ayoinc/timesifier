import {
	TextField as AriaTextField,
	type TextFieldProps as AriaTextFieldProps,
	FieldError,
	Input,
	Label,
	Text,
} from "react-aria-components";

import { cx } from "./cx";
import { FIELD_ERROR, fieldContainer, fieldIndicator, fieldLabel, fieldSupporting } from "./field";

export interface TextFieldProps
	extends Pick<
		AriaTextFieldProps,
		| "name"
		| "value"
		| "defaultValue"
		| "onChange"
		| "type"
		| "inputMode"
		| "autoComplete"
		| "autoFocus"
		| "isRequired"
		| "isDisabled"
		| "isReadOnly"
		| "isInvalid"
		| "minLength"
		| "maxLength"
		| "pattern"
		| "validate"
	> {
	/** Names the field. Always shown: it floats above the value and is never replaced by it. */
	label: string;
	/** Supporting text under the field: a hint about what to enter. */
	description?: string;
	/**
	 * Error text under the field, shown while the field is invalid. Leave it out
	 * to show the browser's own message for `isRequired`, `type` and `pattern`.
	 */
	errorMessage?: string;
}

/**
 * A single-line text input in the Material 3 filled style, with its label,
 * supporting text and error text. A required field is marked with an asterisk.
 */
export function TextField({ label, description, errorMessage, ...props }: TextFieldProps) {
	return (
		<AriaTextField {...props} className="flex flex-col gap-1">
			{(field) => (
				<>
					<div className={cx(fieldContainer(field), "has-data-hovered:state-hover")}>
						{/* The one-space placeholder lets the label tell an empty input from a filled one. */}
						<Input
							placeholder=" "
							className={cx(
								"peer size-full rounded-t-extra-small bg-transparent px-4 pt-6 pb-2 text-body-large outline-none data-disabled:cursor-not-allowed",
								field.isInvalid ? "caret-error" : "caret-primary",
							)}
						/>
						<Label
							className={cx(
								fieldLabel(field),
								"end-4 peer-placeholder-shown:peer-not-data-focused:top-4 peer-placeholder-shown:peer-not-data-focused:text-body-large",
							)}
						>
							{label}
							{field.isRequired && <span aria-hidden="true"> *</span>}
						</Label>
						<span className={fieldIndicator(field)} />
					</div>
					{description && !field.isInvalid && (
						<Text slot="description" className={fieldSupporting(field)}>
							{description}
						</Text>
					)}
					<FieldError className={FIELD_ERROR}>{errorMessage}</FieldError>
				</>
			)}
		</AriaTextField>
	);
}
