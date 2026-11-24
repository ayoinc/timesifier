import { useEffect, useState } from "react";
import { useFetcher } from "react-router";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { Switch } from "~/components/Switch";
import type { Outcome } from "~/organisations/problems";
import { FormSheet } from "~/routes/app/FormSheet";
import { Section } from "~/shell/PageHeading";
import { type Terms, withArticle } from "~/workspace/work-model";

import { CURRENCIES } from "./billing";

/** What may have a currency of its own: "a client or a project", or under Internal work "a cost centre" (TS-115a). */
export function ownCurrencyHolders(terms: Terms): string {
	return terms.clients ? "a client or a project" : withArticle(terms.project);
}

/**
 * Workspace settings' Money (TS-067, TS-069): the organisation's currency,
 * which a client or a project may override, and whether non-billable hours
 * count against hour budgets, a switch that takes effect at once.
 */
export function MoneySettings({
	currency,
	budgetCountsNonBillable,
	terms,
	canChange,
	onDone,
}: {
	currency: string;
	budgetCountsNonBillable: boolean;
	/** The organisation's words for what time goes to. */
	terms: Terms;
	canChange: boolean;
	onDone: (said: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const fetcher = useFetcher<Outcome>();
	const asked = fetcher.formData?.get("intent") === "budget-hours";
	const counts = asked
		? fetcher.formData?.get("countNonBillable") === "on"
		: budgetCountsNonBillable;
	const answer = fetcher.state === "idle" ? fetcher.data : undefined;
	useEffect(() => {
		if (answer?.ok) onDone(answer.said);
	}, [answer, onDone]);
	const codes: readonly string[] = CURRENCIES.includes(currency as (typeof CURRENCIES)[number])
		? CURRENCIES
		: [currency, ...CURRENCIES];

	return (
		<Section
			id="money"
			heading="Money"
			lead={`The currency amounts are in unless ${ownCurrencyHolders(terms)} has its own, and what hour budgets count.`}
			className="max-w-200"
		>
			<Ledger heading="Money">
				<LedgerRows>
					<LedgerRow
						title={currency}
						detail="Currency. A rate keeps the currency it was set in; totals are never added across currencies."
						action={
							canChange && (
								<Button
									variant="text"
									aria-label="Change the currency"
									onPress={() => setOpen(true)}
								>
									Change
								</Button>
							)
						}
					/>
					<LedgerRow
						title={
							<Switch
								isSelected={counts}
								isReadOnly={!canChange}
								onChange={(selected) =>
									fetcher.submit(
										selected
											? { intent: "budget-hours", countNonBillable: "on" }
											: { intent: "budget-hours" },
										{ method: "post" },
									)
								}
							>
								Count non-billable hours against budgets
							</Switch>
						}
						detail={
							<>
								Off, an hours budget counts billable time alone.
								{answer && !answer.ok && (
									<span role="alert" className="block text-error">
										{answer.problem}
									</span>
								)}
							</>
						}
					/>
				</LedgerRows>
			</Ledger>
			<FormSheet
				title="Change the currency"
				intent="currency"
				submitLabel="Save"
				isOpen={open}
				onClose={() => setOpen(false)}
				onDone={onDone}
			>
				<p>Amounts already set keep their currency. New rates and fees are in this one.</p>
				<Select
					label="Currency"
					name="currency"
					options={codes.map((code) => ({ id: code, label: code }))}
					defaultValue={currency}
					isRequired
				/>
			</FormSheet>
		</Section>
	);
}
