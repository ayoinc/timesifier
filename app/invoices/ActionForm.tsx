import { type ReactNode, useEffect, useRef } from "react";
import { useFetcher } from "react-router";

import { Button, type ButtonVariant } from "~/components/Button";
import { cx } from "~/components/cx";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";

import type { TaxOption } from "./DocumentParts";
import { DESCRIPTION_MAX_LENGTH, NO_TAX } from "./line-input";

/**
 * What a billing page's action answers a form with: what was done, or why
 * nothing was and the problem of each field (`form.server.ts`).
 */
export type FormAnswer =
	| { ok: true; said: string }
	| { ok: false; problem: string; fields: Record<string, string[]> };

/** The props that mark a field invalid with its problem, for TextField and Select. */
export interface FieldState {
	name: string;
	isInvalid: boolean;
	errorMessage: string | undefined;
}

export interface ActionFormProps {
	/** Which of the page's actions the form asks for. Sent as the field `intent`. */
	intent: string;
	submitLabel: string;
	variant?: ButtonVariant;
	/** Values sent with the form that the person does not type: an id. */
	hidden?: Record<string, string>;
	/** The form's fields, given each field's state by its name. */
	children?: (field: (name: string) => FieldState) => ReactNode;
	className?: string;
	/** The submit button's accessible name, when its label alone is ambiguous on the page. */
	submitName?: string;
}

/**
 * A form of a billing page, posted to its own action without leaving the
 * page: the problem of each field shows under it, what was done or why not
 * under the button. A second press while the first is on its way does nothing.
 */
export function ActionForm({
	intent,
	submitLabel,
	variant = "filled",
	hidden = {},
	children,
	className,
	submitName,
}: ActionFormProps) {
	const fetcher = useFetcher<FormAnswer>();
	const answer = fetcher.state === "idle" ? fetcher.data : undefined;
	const fields = answer && !answer.ok ? answer.fields : {};
	const field = (name: string): FieldState => {
		const problem = fields[name]?.[0];
		return { name, isInvalid: problem !== undefined, errorMessage: problem };
	};
	// A form that was done starts again empty, ready for the next line or contact.
	const form = useRef<HTMLFormElement>(null);
	useEffect(() => {
		if (answer?.ok) form.current?.reset();
	}, [answer]);
	return (
		<fetcher.Form
			ref={form}
			method="post"
			className={cx("flex flex-col gap-4", className)}
			onSubmit={(event) => {
				if (fetcher.state !== "idle") event.preventDefault();
			}}
		>
			<input type="hidden" name="intent" value={intent} />
			{Object.entries(hidden).map(([name, value]) => (
				<input key={name} type="hidden" name={name} value={value} />
			))}
			{children?.(field)}
			<div>
				<Button type="submit" variant={variant} aria-label={submitName}>
					{submitLabel}
				</Button>
			</div>
			<p role="status" className="text-body-medium text-on-surface-variant empty:hidden">
				{answer?.ok ? answer.said : null}
			</p>
			<p role="alert" className="text-body-medium text-error empty:hidden">
				{answer && !answer.ok ? answer.problem : null}
			</p>
		</fetcher.Form>
	);
}

/** The fields of a new line, in an `ActionForm` on a page: each with its problem under it. */
export function LineFields({
	field,
	taxes,
	currency,
}: {
	field: (name: string) => FieldState;
	taxes: readonly TaxOption[];
	currency: string;
}) {
	const options = [{ id: NO_TAX, label: "No tax" }, ...taxes];
	return (
		<>
			<TextField
				label="Description"
				autoComplete="off"
				isRequired
				maxLength={DESCRIPTION_MAX_LENGTH}
				{...field("description")}
			/>
			<div className="grid grid-cols-2 gap-4">
				<TextField
					label="Quantity"
					inputMode="decimal"
					defaultValue="1"
					isRequired
					{...field("quantity")}
				/>
				<TextField
					label={`Unit price (${currency})`}
					inputMode="decimal"
					isRequired
					{...field("unitPrice")}
				/>
			</div>
			{taxes.length > 0 ? (
				<div className="grid grid-cols-2 gap-4">
					<Select label="Tax" options={options} defaultValue={NO_TAX} {...field("tax")} />
					<Select
						label="Second tax"
						options={options}
						defaultValue={NO_TAX}
						{...field("secondTax")}
					/>
				</div>
			) : (
				<>
					<input type="hidden" name="tax" value={NO_TAX} />
					<input type="hidden" name="secondTax" value={NO_TAX} />
				</>
			)}
		</>
	);
}
