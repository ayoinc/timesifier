import { Link } from "react-router";

import { destination, invitationsPath, membersPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { EmptySheet, PageHeading, PageLead } from "~/shell/PageHeading";

import { useOrganisation } from "./useOrganisation";

// Team: the people whose time the person looks after. Owners and admins see
// everyone; a manager sees the members of the teams they manage; a member is
// not shown it (app/shell/destinations.ts). TS-045 builds This week, TS-038
// the teams; the members and invitations of TS-009 are its pages.

const { label } = destination("team");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export default function Team() {
	const organisation = useOrganisation();
	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>The people in {organisation.name} and their week.</PageLead>
			<ul className="mt-6 flex flex-col items-start gap-3">
				<li>
					<Link to={membersPath(organisation.slug)} className={TEXT_LINK}>
						Members
					</Link>
				</li>
				<li>
					<Link to={invitationsPath(organisation.slug)} className={TEXT_LINK}>
						Invitations
					</Link>
				</li>
			</ul>
			<EmptySheet heading="This week">
				Each person's hours this week, whether their timer is running and whether their week is
				submitted will appear here.
			</EmptySheet>
		</>
	);
}
