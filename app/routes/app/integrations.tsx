import { destination } from "~/shell/destinations";
import { EmptySheet, PageHeading, PageLead } from "~/shell/PageHeading";

// Integrations: API tokens, webhooks, imports and exports, calendar feeds and
// the Xero export (research B20, B21). Owners and admins are shown it.

const { label } = destination("integrations");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export default function Integrations() {
	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>Connect Timesifier to the tools you already use.</PageLead>
			<EmptySheet heading="API tokens">
				The tokens that let your own tools read and write your time will be listed here.
			</EmptySheet>
		</>
	);
}
