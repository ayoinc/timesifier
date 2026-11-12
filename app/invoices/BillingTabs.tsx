import { LinkTabs } from "~/components/LinkTabs";

import {
	billingReportPath,
	invoicesPath,
	recurringListPath,
	retainersPath,
	uninvoicedPath,
} from "./paths";

// The pages of Invoices as a row of link tabs (TS-073 to TS-078): the
// invoices, what is still to invoice, the recurring invoices, the retainers
// and the reports. Each is an address of its own.

export type BillingTab = "invoices" | "uninvoiced" | "recurring" | "retainers" | "reports";

export function BillingTabs({ slug, current }: { slug: string; current: BillingTab }) {
	return (
		// Five tabs are wider than a phone: the row scrolls rather than squeezes.
		<div className="mt-8 max-w-200 overflow-x-auto">
			<LinkTabs
				label="Invoice pages"
				current={current}
				tabs={[
					{ id: "invoices", label: "Invoices", to: invoicesPath(slug) },
					{ id: "uninvoiced", label: "Uninvoiced", to: uninvoicedPath(slug) },
					{ id: "recurring", label: "Recurring", to: recurringListPath(slug) },
					{ id: "retainers", label: "Retainers", to: retainersPath(slug) },
					{ id: "reports", label: "Reports", to: billingReportPath(slug) },
				]}
			/>
		</div>
	);
}
