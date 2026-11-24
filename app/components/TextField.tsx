import {
	TextField as AriaTextField,
	type TextFieldProps as AriaTextFieldProps,
	FieldError,
	Input,
	Label,
	Text,
	TextArea,
} from "react-aria-components";

import { cx } from "./cx";
import {
	FIELD_CONTROL,
	FIELD_ERROR,
	fieldContainer,
	fieldIndicator,
	fieldLabel,
	fieldSupporting,
} from "./field";

export interface TextFieldProps
	extends Pick<
		AriaTextFieldProps,
		| "name"
		| "value"
		| "defaultValue"
		| "onChange"
		| "onKeyDown"
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
	/** The earliest value, for a date, a time or a number. */
	min?: string;
	/** The latest value, for a date, a time or a number. */
	max?: string;
	/**
	 * Error text under the field, shown while the field is invalid. Leave it out
	 * to show the browser's own message for `isRequired`, `type` and `pattern`.
	 */
	errorMessage?: string;
	/**
	 * Lines shown at once, for a value of several lines: the field is then a text area,
	 * at least `rows` lines tall, that grows with what it holds up to `MOST_LINES` and
	 * then scrolls, and that the person can make taller. One of `ROWS_SHOWN`'s keys.
	 */
	rows?: keyof typeof ROWS_SHOWN;
}

// A text area grows with its value (`field-sizing: content`), which sets aside the
// `rows` attribute, so its least height is a class (`min-lines-*` in app/app.css).
// Tailwind sees only whole class names, hence one per supported number of lines.
const ROWS_SHOWN = {
	2: "min-lines-2",
	3: "min-lines-3",
	4: "min-lines-4",
	6: "min-lines-6",
	8: "min-lines-8",
	10: "min-lines-10",
} as const;

/** The tallest a text area grows by itself before its lines scroll. */
const MOST_LINES = "max-lines-16";

/**
 * A text input in the Material 3 filled style, with its label, supporting
 * text and error text: one line, or `rows` lines. A required field is marked
 * with an asterisk.
 */
export function TextField({
	label,
	description,
	errorMessage,
	min,
	max,
	rows,
	...props
}: TextFieldProps) {
	return (
		<AriaTextField {...props} className="flex flex-col gap-1">
			{(field) => (
				<>
					<div className={fieldContainer(field, rows ? "min-h-14" : "h-14")}>
						{rows ? (
							// The room for the label is a border, not padding: a text area's lines scroll
							// within its padding, so they would pass under the label; never under a border.
							<TextArea
								rows={rows}
								className={cx(
									FIELD_CONTROL,
									// Its height is the container's, which is its own: `size-full` resolves to auto.
									"block resize-y field-sizing-content border-t-28 border-transparent px-4 pb-2 text-body-large",
									ROWS_SHOWN[rows],
									MOST_LINES,
									field.isInvalid ? "caret-error" : "caret-primary",
								)}
							/>
						) : (
							// The one-space placeholder lets the label tell an empty input from a filled one.
							<Input
								placeholder=" "
								min={min}
								max={max}
								className={cx(
									FIELD_CONTROL,
									"px-4 pt-6 pb-2 text-body-large",
									field.isInvalid ? "caret-error" : "caret-primary",
								)}
							/>
						)}
						<Label
							className={cx(
								fieldLabel(field),
								"end-4",
								// A text area's label stays above its lines, where nothing it holds can cover it.
								!rows &&
									"peer-placeholder-shown:group-not-has-data-focused/field:top-4 peer-placeholder-shown:group-not-has-data-focused/field:text-body-large",
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
