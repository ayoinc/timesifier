import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";

import type { BillableSplit as Split } from "./amounts.server";

/**
 * A report's billable and non-billable time and their sum (TS-066), and for
 * those who see rates its billable amount in each currency, with how many
 * entries lack a rate (TS-067).
 */
export function BillableSplit({ split, range }: { split: Split; range: string }) {
	return (
		<div className="mt-6">
			<Ledger heading="Billable" note={range}>
				<LedgerRows label="Billable and non-billable time">
					<LedgerRow title="Billable hours" value={split.billable} />
					<LedgerRow title="Non-billable hours" value={split.nonBillable} />
					{split.amounts?.map(({ currency, amount }) => (
						<LedgerRow key={currency} title={`Billable amount, ${currency}`} value={amount} />
					))}
				</LedgerRows>
				<LedgerTotal label="Total hours" value={split.total} />
			</Ledger>
			{split.missingRates !== null && split.missingRates > 0 && (
				<p className="mt-4 max-w-160 text-body-medium text-on-surface-variant">
					{split.missingRates === 1
						? "1 billable entry has no rate. It counts 0 in the amount; give its project a rate on the project's page."
						: `${split.missingRates} billable entries have no rate. They count 0 in the amount; give their projects a rate on each project's page.`}
				</p>
			)}
		</div>
	);
}
