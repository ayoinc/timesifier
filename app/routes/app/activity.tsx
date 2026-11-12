import { destination } from "~/shell/destinations";
import { EmptySheet, PageHeading, PageLead } from "~/shell/PageHeading";

// Activity log: who changed what and when, append-only and kept two years
// (research B17; app/activity/). Owners, admins and Finance read everyone's;
// a team manager their own and their teams' (activityScopeOf).

const { label } = destination("activity");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export default function Activity() {
	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>
				Who changed what, and when, for the time and work you can see. Records are kept for two
				years.
			</PageLead>
			<EmptySheet heading="Recent changes">
				Changes to time, periods, projects, clients and members will be listed here, newest first.
			</EmptySheet>
		</>
	);
}
