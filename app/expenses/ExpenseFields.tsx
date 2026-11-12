import { useId, useState } from "react";

import { Checkbox } from "~/components/Checkbox";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { formatMoney } from "~/money/money";
import { TagPicker } from "~/tags/TagPicker";
import type { TagChoice } from "~/tags/tags";

import {
	type DatedPrice,
	EXPENSE_NOTES_MAX_LENGTH,
	priceOn,
	RECEIPT_ACCEPT,
	UNIT_NAME_MAX_LENGTH,
} from "./expenses";

// The fields of an expense (TS-070, B9), in the sheet that records one and the
// one that changes it: its day, project and category, an amount in the
// project's currency or, for a unit-priced category, a quantity at the price
// in force on the day, a note, whether it is billable and whether the person
// asks to be paid back, and a receipt. Billable starts as the project says and
// is set again whenever another project is chosen; a non-billable project's
// expense is never billable.

/** A project an expense can be on. */
export interface ProjectChoice {
	id: string;
	name: string;
	/** The currency its expenses are in. */
	currency: string;
	/** Whether the project bills its client at all. */
	billable: boolean;
}

/** A category an expense can be in. */
export interface CategoryChoice {
	id: string;
	name: string;
	unitName: string | null;
	prices: DatedPrice[];
}

/** An expense as the fields show it before a change. */
export interface ExpenseValues {
	spentOn: string;
	projectId: string;
	categoryId: string;
	amount: string;
	quantity: string;
	notes: string;
	billable: boolean;
	reimbursable: boolean;
	receiptName: string | null;
	tagIds: string[];
}

export function ExpenseFields({
	projects,
	categories,
	tags,
	currency,
	values,
}: {
	projects: ProjectChoice[];
	categories: CategoryChoice[];
	/** Every tag of the organisation; the picker offers the active ones and any the expense has. */
	tags: readonly TagChoice[];
	/** The organisation's currency, which unit prices are in. */
	currency: string;
	values: ExpenseValues;
}) {
	const [spentOn, setSpentOn] = useState(values.spentOn);
	const [projectId, setProjectId] = useState(values.projectId);
	const [categoryId, setCategoryId] = useState(values.categoryId);
	const [billable, setBillable] = useState(values.billable);
	const receiptId = useId();
	const receiptHint = useId();

	const project = projects.find((p) => p.id === projectId);
	const category = categories.find((c) => c.id === categoryId);
	const price = category?.unitName ? priceOn(category.prices, spentOn || values.spentOn) : null;

	return (
		<>
			<TextField
				label="Date"
				name="spentOn"
				type="date"
				value={spentOn}
				onChange={setSpentOn}
				isRequired
			/>
			<Select
				label="Project"
				name="projectId"
				options={projects.map(({ id, name }) => ({ id, label: name }))}
				value={projectId}
				onChange={(id) => {
					if (id === null) return;
					setProjectId(id);
					setBillable(projects.find((p) => p.id === id)?.billable ?? false);
				}}
				isRequired
			/>
			<Select
				label="Category"
				name="categoryId"
				options={categories.map(({ id, name }) => ({ id, label: name }))}
				value={categoryId}
				onChange={(id) => id !== null && setCategoryId(id)}
				isRequired
			/>
			{category?.unitName ? (
				<TextField
					key="quantity"
					label={`Quantity (${category.unitName.slice(0, UNIT_NAME_MAX_LENGTH)})`}
					name="quantity"
					defaultValue={values.quantity}
					inputMode="decimal"
					autoComplete="off"
					maxLength={16}
					description={
						price === null
							? undefined
							: project && project.currency !== currency
								? `Priced in ${currency}; ${project.name} is billed in ${project.currency}, so this cannot be recorded here.`
								: `${formatMoney(price, currency, "en-GB")} per ${category.unitName} on that day.`
					}
					isRequired
				/>
			) : (
				<TextField
					key="amount"
					label={`Amount (${project?.currency ?? currency})`}
					name="amount"
					defaultValue={values.amount}
					inputMode="decimal"
					autoComplete="off"
					maxLength={20}
					description="Such as 12.50."
					isRequired
				/>
			)}
			<TextField
				label="Notes (optional)"
				name="notes"
				defaultValue={values.notes}
				maxLength={EXPENSE_NOTES_MAX_LENGTH}
			/>
			<Checkbox
				name="billable"
				value="on"
				isSelected={billable && (project?.billable ?? false)}
				onChange={setBillable}
				isDisabled={!project?.billable}
			>
				{project?.billable === false
					? "Not billable: the project bills nobody"
					: "Billable to the project's client"}
			</Checkbox>
			<Checkbox name="reimbursable" value="on" defaultSelected={values.reimbursable}>
				Reimburse me
			</Checkbox>
			<TagPicker tags={tags} selected={values.tagIds} />
			<div className="flex flex-col gap-1">
				<label htmlFor={receiptId} className="text-body-medium text-on-surface">
					{values.receiptName ? "Replace the receipt (optional)" : "Receipt (optional)"}
				</label>
				<input
					id={receiptId}
					type="file"
					name="receipt"
					accept={RECEIPT_ACCEPT}
					aria-describedby={receiptHint}
					className="rounded-extra-small text-body-medium text-on-surface-variant outline-none focus-visible:focus-indicator file:me-4 file:h-10 file:cursor-pointer file:rounded-large-increased file:border file:border-outline-variant file:border-solid file:bg-transparent file:px-4 file:text-label-large file:text-primary"
				/>
				<span id={receiptHint} className="text-body-small text-on-surface-variant">
					A PDF, PNG or JPEG of up to 10 MB.
					{values.receiptName && ` It has ${values.receiptName} now.`}
				</span>
			</div>
			{values.receiptName && (
				<Checkbox name="removeReceipt" value="on">
					Remove the receipt it has
				</Checkbox>
			)}
		</>
	);
}
