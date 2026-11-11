import { Link } from "react-router";

import { cx } from "~/components/cx";
import { destinationPath, invitationsPath, membersPath } from "~/shell/destinations";

// The pages of Team as a row of tabs (TS-045): This week, Teams, Members and
// Invitations. Each is an address of its own, so a tab is a link and the one on
// screen is marked by `aria-current`, drawn as the Tabs component draws a
// selected tab: the label in primary over a 3px rule.

export type TeamTab = "week" | "teams" | "members" | "invitations";

export function teamTabPath(slug: string, tab: TeamTab): string {
	switch (tab) {
		case "week":
			return destinationPath(slug, "team");
		case "teams":
			return `${destinationPath(slug, "team")}?show=teams`;
		case "members":
			return membersPath(slug);
		case "invitations":
			return invitationsPath(slug);
	}
}

const TABS: { id: TeamTab; label: string }[] = [
	{ id: "week", label: "This week" },
	{ id: "teams", label: "Teams" },
	{ id: "members", label: "Members" },
	{ id: "invitations", label: "Invitations" },
];

export function TeamTabs({ slug, current }: { slug: string; current: TeamTab }) {
	return (
		<ul aria-label="Team pages" className="flex max-w-200 border-outline-variant border-b">
			{TABS.map(({ id, label }) => {
				const isCurrent = id === current;
				return (
					<li key={id} className="flex-1">
						<Link
							to={teamTabPath(slug, id)}
							aria-current={isCurrent ? "page" : undefined}
							className={cx(
								"relative flex h-12 items-center justify-center px-2 text-center text-title-small outline-none hover:text-on-surface focus-visible:focus-indicator-inner",
								isCurrent ? "text-primary" : "text-on-surface-variant",
							)}
						>
							{label}
							{isCurrent && (
								<span
									aria-hidden="true"
									className="absolute inset-x-2 bottom-0 h-0.75 rounded-t-full bg-primary"
								/>
							)}
						</Link>
					</li>
				);
			})}
		</ul>
	);
}
