import { destination } from "~/shell/destinations";
import { EmptySheet, PageHeading, PageLead } from "~/shell/PageHeading";

// Estimates: quotes to a client that become an invoice once accepted
// (research B12). Owners, admins and Finance are shown it.

const { label } = destination("estimates");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export default function Estimates() {
	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>Quotes for your clients, which become invoices once accepted.</PageLead>
			<EmptySheet heading="Open estimates">
				The estimates you send, and whether each was accepted or declined, will be listed here.
			</EmptySheet>
		</>
	);
}
