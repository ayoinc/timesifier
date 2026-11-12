import { destination } from "~/shell/destinations";
import { EmptySheet, PageHeading, PageLead } from "~/shell/PageHeading";

// Invoices: what the organisation charges its clients, made from tracked time
// and expenses, with taxes and payments, and recurring invoices and retainers
// (research B10, B11, B13, B14). Owners, admins and Finance are shown it.

const { label } = destination("invoices");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export default function Invoices() {
	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>
				What you charge your clients, from the time and expenses tracked for them.
			</PageLead>
			<EmptySheet heading="Open invoices">
				The invoices you make, with what is owed and what has been paid, will be listed here.
			</EmptySheet>
		</>
	);
}
