import { destination } from "~/shell/destinations";
import { EmptySheet, PageHeading, PageLead } from "~/shell/PageHeading";

// Tasks: the kinds of work time is tracked to on a project, each billable or
// not, and the tags that categorise entries, projects and expenses (research
// B4; tags). Owners and admins are shown it (app/shell/destinations.ts).

const { label } = destination("tasks");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export default function Tasks() {
	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>The kinds of work your projects are made of, and whether each is billed.</PageLead>
			<EmptySheet heading="Tasks">
				The tasks you create, and which projects each is on, will be listed here.
			</EmptySheet>
		</>
	);
}
