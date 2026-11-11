import { destination } from "~/shell/destinations";
import { EmptySheet, PageHeading } from "~/shell/PageHeading";

// Approvals: the weeks people have submitted, to approve or return. Owners and
// admins see everyone's; a manager sees those of the members of the teams they
// manage; a member is not shown it (app/shell/destinations.ts). TS-047 builds it.

const { label } = destination("approvals");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export default function Approvals() {
	return (
		<>
			<PageHeading>{label}</PageHeading>
			<EmptySheet heading="Pending">
				The weeks people submit for approval will appear here, one period at a time.
			</EmptySheet>
		</>
	);
}
