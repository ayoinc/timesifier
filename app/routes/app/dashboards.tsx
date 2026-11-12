import { destination } from "~/shell/destinations";
import { EmptySheet, PageHeading, PageLead } from "~/shell/PageHeading";

// Dashboards: utilisation, budgets and, for those who see rates, profitability
// (research B7, B8, B19). Owners, admins, Finance and team managers are shown
// it; amounts only reach owners, admins and Finance (maySeeRates).

const { label } = destination("dashboards");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export default function Dashboards() {
	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>
				How full your people are, how your projects stand against their budgets, and what they earn.
			</PageLead>
			<EmptySheet heading="This month">
				Utilisation, budgets and profitability for the people and projects you look after will be
				shown here.
			</EmptySheet>
		</>
	);
}
