import { destination } from "~/shell/destinations";
import { EmptySheet, PageHeading, PageLead } from "~/shell/PageHeading";

// Expenses: a person's own costs to be reimbursed or billed, by project and
// category, with a receipt (research B9). Everyone is shown it; a person adds
// and changes their own, and owners, admins, Finance and the managers of their
// teams see theirs (app/organisations/access.ts). Built by its own card after
// TS-064; until then it says what will be here.

const { label } = destination("expenses");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export default function Expenses() {
	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>Costs you spend on a project, to be paid back or billed to its client.</PageLead>
			<EmptySheet heading="Your expenses">
				Expenses you record, each with its project, category, amount and receipt, will be listed
				here.
			</EmptySheet>
		</>
	);
}
