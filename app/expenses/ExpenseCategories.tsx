import { useState } from "react";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { TextField } from "~/components/TextField";
import { RECORD_NAME_MAX_LENGTH } from "~/lib/names";
import { formatMoney } from "~/money/money";
import { FormSheet } from "~/routes/app/FormSheet";
import { Section } from "~/shell/PageHeading";
import { dayLabel } from "~/teams/words";

import { amountText, type DatedPrice, UNIT_NAME_MAX_LENGTH } from "./expenses";

// Workspace settings for expenses (TS-070, B9): the categories people record
// expenses in. Owners and admins add, rename, archive and restore them; a
// unit-priced category, such as mileage, has a unit and a price per unit from
// a day on. A new price applies to expenses dated from its day; those before
// keep the price they had.

export interface ExpenseCategoriesData {
	/** The organisation's currency, which unit prices are in. */
	currency: string;
	/** Today in the organisation's zone: the day a new price is from unless another is given. */
	today: string;
	categories: {
		id: string;
		name: string;
		unitName: string | null;
		prices: DatedPrice[];
		archived: boolean;
	}[];
}

type Task = "add" | "change" | "archive" | "restore";
type Category = ExpenseCategoriesData["categories"][number];

export function ExpenseCategories({
	data,
	onDone,
}: {
	data: ExpenseCategoriesData;
	onDone: (said: string) => void;
}) {
	const [task, setTask] = useState<Task | null>(null);
	const [target, setTarget] = useState<Category | null>(null);
	const close = () => setTask(null);
	const open = (next: Task, on: Category | null) => {
		setTarget(on);
		setTask(next);
	};
	const money = (minor: number) => formatMoney(minor, data.currency, "en-GB");
	const latest = (c: Category) => c.prices.at(-1);

	return (
		<>
			<Section
				id="expense-categories"
				heading="Expense categories"
				lead="The kinds of expense people record. A category with a unit price, such as mileage, is recorded as a quantity at the price in force on the expense's day."
				className="max-w-200"
			>
				{data.categories.length === 0 ? (
					<p className="text-body-large text-on-surface-variant">
						No categories yet. Add one, such as Travel, Meals or Mileage, and people can record
						expenses in it.
					</p>
				) : (
					<Ledger heading="Categories" note={`${data.categories.length}`}>
						<LedgerRows label="Expense categories">
							{data.categories.map((c) => {
								const price = latest(c);
								return (
									<LedgerRow
										key={c.id}
										title={<span className="wrap-anywhere">{c.name}</span>}
										detail={[
											c.archived ? "Archived" : null,
											c.unitName && price
												? `${money(price.unitPriceMinor)} per ${c.unitName} from ${dayLabel(price.effectiveFrom)}`
												: "An amount each time",
											...c.prices
												.slice(0, -1)
												.reverse()
												.map((p) => `${money(p.unitPriceMinor)} from ${dayLabel(p.effectiveFrom)}`),
										]
											.filter(Boolean)
											.join(" · ")}
										action={
											<span className="flex gap-1">
												{!c.archived && (
													<Button
														variant="text"
														aria-label={`Change ${c.name}`}
														onPress={() => open("change", c)}
													>
														Change
													</Button>
												)}
												<Button
													variant="text"
													aria-label={`${c.archived ? "Restore" : "Archive"} ${c.name}`}
													onPress={() => open(c.archived ? "restore" : "archive", c)}
												>
													{c.archived ? "Restore" : "Archive"}
												</Button>
											</span>
										}
									/>
								);
							})}
						</LedgerRows>
					</Ledger>
				)}
				<div className="mt-4">
					<Button variant="outlined" onPress={() => open("add", null)}>
						Add category
					</Button>
				</div>
			</Section>

			<FormSheet
				title="Add an expense category"
				intent="add-category"
				submitLabel="Add"
				isOpen={task === "add"}
				onClose={close}
				onDone={onDone}
			>
				<TextField
					label="Name"
					name="name"
					autoComplete="off"
					maxLength={RECORD_NAME_MAX_LENGTH}
					isRequired
				/>
				<p className="text-body-medium text-on-surface-variant">
					For a category priced per unit, such as mileage, give the unit and its price. Leave both
					empty for one recorded as an amount.
				</p>
				<UnitFields currency={data.currency} today={data.today} unitName="" price="" />
			</FormSheet>

			<FormSheet
				title={`Change ${target?.name ?? "the category"}`}
				intent="change-category"
				submitLabel="Save"
				isOpen={task === "change"}
				onClose={close}
				onDone={onDone}
			>
				{target && (
					<>
						<input type="hidden" name="categoryId" value={target.id} />
						<TextField
							label="Name"
							name="name"
							defaultValue={target.name}
							autoComplete="off"
							maxLength={RECORD_NAME_MAX_LENGTH}
							isRequired
						/>
						{target.unitName !== null && (
							<>
								<p className="text-body-medium text-on-surface-variant">
									A new price applies to expenses dated from its day on. Expenses before it keep
									their price.
								</p>
								<UnitFields
									currency={data.currency}
									today={data.today}
									unitName={target.unitName}
									price={amountText(latest(target)?.unitPriceMinor ?? 0, data.currency)}
								/>
							</>
						)}
					</>
				)}
			</FormSheet>

			<FormSheet
				title={`Archive ${target?.name ?? "the category"}?`}
				intent="archive-category"
				submitLabel="Archive"
				isOpen={task === "archive"}
				onClose={close}
				onDone={onDone}
			>
				{target && <input type="hidden" name="categoryId" value={target.id} />}
				<p>It is no longer offered for new expenses. The expenses in it keep it.</p>
			</FormSheet>

			<FormSheet
				title={`Restore ${target?.name ?? "the category"}?`}
				intent="restore-category"
				submitLabel="Restore"
				isOpen={task === "restore"}
				onClose={close}
				onDone={onDone}
			>
				{target && <input type="hidden" name="categoryId" value={target.id} />}
				<p>It is offered for new expenses again.</p>
			</FormSheet>
		</>
	);
}

/** The unit, its price and the day the price is from. */
function UnitFields({
	currency,
	today,
	unitName,
	price,
}: {
	currency: string;
	today: string;
	unitName: string;
	price: string;
}) {
	return (
		<>
			<div className="grid grid-cols-2 gap-4">
				<TextField
					label="Unit"
					name="unitName"
					defaultValue={unitName}
					description="Such as mile"
					autoComplete="off"
					maxLength={UNIT_NAME_MAX_LENGTH}
				/>
				<TextField
					label={`Price per unit (${currency})`}
					name="unitPrice"
					defaultValue={price}
					inputMode="decimal"
					autoComplete="off"
					maxLength={20}
				/>
			</div>
			<TextField label="Price from" name="from" type="date" defaultValue={today} />
		</>
	);
}
