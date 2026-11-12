import { LinkTabs } from "~/components/LinkTabs";
import { destinationPath, invitationsPath, membersPath } from "~/shell/destinations";

// The pages of Team as a row of tabs (TS-045): This week, Teams, Members and
// Invitations. Each is an address of its own, so a tab is a link. The row sits
// under the page's heading and the sentence under it, as every page's tabs do,
// and is drawn as every row of tabs is (TS-091, W20).

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
		<div className="mt-6 max-w-200">
			<LinkTabs
				label="Team pages"
				tabs={TABS.map(({ id, label }) => ({ id, to: teamTabPath(slug, id), label }))}
				current={current}
			/>
		</div>
	);
}
