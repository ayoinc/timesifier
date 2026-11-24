import { LinkTabs } from "~/components/LinkTabs";
import { contractPath, destinationPath } from "~/shell/destinations";

import { WEEK_PARAM } from "./words";

// One person's pages of Team as a row of tabs (TS-098a): their Week, and their
// Contract. A tab the viewer may not open is left out: Finance, who reads
// contracts but is not shown Team, has no Week; a manager of a person sees both.

/** The query of Team's address that opens one person's week. */
export const PERSON_PARAM = "person";

export type PersonTab = "week" | "contract";

/** The address of `personId`'s week on Team, in the week starting `week` when given. */
export function personWeekPath(slug: string, personId: string, week?: string): string {
	const query = new URLSearchParams(week ? { [WEEK_PARAM]: week } : {});
	query.set(PERSON_PARAM, personId);
	return `${destinationPath(slug, "team")}?${query}`;
}

export function PersonTabs({
	slug,
	personId,
	current,
	tabs,
}: {
	slug: string;
	personId: string;
	current: PersonTab;
	/** The tabs the viewer may open. */
	tabs: readonly PersonTab[];
}) {
	const all = [
		{ id: "week", to: personWeekPath(slug, personId), label: "Week" },
		{ id: "contract", to: contractPath(slug, personId), label: "Contract" },
	] as const;
	return (
		<div className="mt-6 max-w-200">
			<LinkTabs
				label="Their pages"
				tabs={all.filter((tab) => tabs.includes(tab.id))}
				current={current}
			/>
		</div>
	);
}
