import type { ReactNode } from "react";

import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";

import { DESCRIPTION_MAX_LENGTH, NO_TAX } from "./line-input";
import type { PrintedDocument } from "./pdf";

// What the pages of an invoice, an estimate and a recurring invoice share: the
// document drawn from the same words its PDF is printed from, and the fields
// of a line. Each page puts them in its own sheets.

/** A tax a line may bear, as the fields offer it. */
export interface TaxOption {
	id: string;
	label: string;
}

/** A line's values as its fields start. */
export interface LineDefaults {
	description: string;
	quantity: string;
	unitPrice: string;
	tax: string;
	secondTax: string;
}

export const NEW_LINE: LineDefaults = {
	description: "",
	quantity: "1",
	unitPrice: "",
	tax: NO_TAX,
	secondTax: NO_TAX,
};

/** The fields of a line, in a sheet's form. */
export function LineFieldsInSheet({
	defaults,
	taxes,
	currency,
}: {
	defaults: LineDefaults;
	taxes: readonly TaxOption[];
	currency: string;
}) {
	const options = [{ id: NO_TAX, label: "No tax" }, ...taxes];
	return (
		<>
			<TextField
				label="Description"
				name="description"
				defaultValue={defaults.description}
				autoComplete="off"
				autoFocus
				isRequired
				maxLength={DESCRIPTION_MAX_LENGTH}
			/>
			<div className="grid grid-cols-2 gap-4">
				<TextField
					label="Quantity"
					name="quantity"
					inputMode="decimal"
					defaultValue={defaults.quantity}
					isRequired
				/>
				<TextField
					label={`Unit price (${currency})`}
					name="unitPrice"
					inputMode="decimal"
					defaultValue={defaults.unitPrice}
					isRequired
				/>
			</div>
			{taxes.length > 0 ? (
				<div className="grid grid-cols-2 gap-4">
					<Select label="Tax" name="tax" options={options} defaultValue={defaults.tax} />
					<Select
						label="Second tax"
						name="secondTax"
						options={options}
						defaultValue={defaults.secondTax}
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

/**
 * A document as its PDF prints it: its facts, its lines and its totals, each
 * value the very string the PDF holds. `lineAction` adds a control to each
 * line of a draft.
 */
export function PrintedSheet({
	printed,
	lineAction,
}: {
	printed: PrintedDocument;
	lineAction?: (index: number) => ReactNode;
}) {
	return (
		<div className="max-w-200">
			<dl className="flex flex-col gap-y-1 text-body-large">
				{[
					["From", printed.from.join(", ")] as const,
					["For", printed.to.join(", ")] as const,
					...printed.facts,
				].map(([label, value]) => (
					<div key={label} className="flex gap-x-6">
						<dt className="w-28 shrink-0 text-on-surface-variant">{label}</dt>
						<dd className="min-w-0 wrap-anywhere">{value}</dd>
					</div>
				))}
			</dl>
			{printed.subject && <p className="mt-4 text-title-medium wrap-anywhere">{printed.subject}</p>}
			<div className="mt-6">
				<Ledger heading="Lines" note={printed.lines.length}>
					{printed.lines.length === 0 ? (
						<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
							No lines yet.
						</p>
					) : (
						<LedgerRows label="Lines">
							{printed.lines.map((line, index) => (
								<LedgerRow
									// The lines are in their stored order; a line's place is its key.
									// biome-ignore lint/suspicious/noArrayIndexKey: a line's position is its identity here
									key={index}
									title={<span className="wrap-anywhere">{line.description}</span>}
									detail={`${line.quantity} × ${line.unitPrice}`}
									value={line.amount}
									action={lineAction?.(index)}
								/>
							))}
						</LedgerRows>
					)}
					{printed.totals.map(([label, value]) => (
						<LedgerTotal key={label} label={label} value={value} />
					))}
				</Ledger>
			</div>
			{printed.notes && (
				<p className="mt-4 max-w-160 whitespace-pre-line text-body-medium text-on-surface-variant wrap-anywhere">
					{printed.notes}
				</p>
			)}
		</div>
	);
}
