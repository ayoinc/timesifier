import type { ReactNode } from "react";
import { useSearchParams } from "react-router";

import { Tab, TabList, TabPanel, Tabs } from "~/components/Tabs";

import { ACTIVE, ARCHIVED, SHOW_PARAM, type Shown, shownIn } from "./projects";

export interface ArchiveTabsProps {
	/** What the tabs choose between, for assistive technology: "Projects". */
	label: string;
	/** The active records. */
	active: ReactNode;
	/** The archived records. */
	archived: ReactNode;
}

/**
 * The two lists of something an organisation archives and never deletes:
 * Active, and Archived (TS-011a, TS-011b). The tab chosen is kept in the
 * address, `?show=archived`, so the archived list can be reloaded and linked
 * to; moving between the tabs replaces the address, keeps the rest of it (a
 * search, TS-057), and reads nothing again.
 */
export function ArchiveTabs({ label, active, archived }: ArchiveTabsProps) {
	const [search, setSearch] = useSearchParams();
	return (
		<Tabs
			selectedKey={shownIn(search)}
			onSelectionChange={(key) =>
				setSearch(
					(current) => {
						const next = new URLSearchParams(current);
						if (key === ARCHIVED) next.set(SHOW_PARAM, ARCHIVED);
						else next.delete(SHOW_PARAM);
						return next;
					},
					{ replace: true, preventScrollReset: true },
				)
			}
		>
			<TabList label={label}>
				<Tab id={ACTIVE satisfies Shown}>Active</Tab>
				<Tab id={ARCHIVED satisfies Shown}>Archived</Tab>
			</TabList>
			<TabPanel id={ACTIVE}>{active}</TabPanel>
			<TabPanel id={ARCHIVED}>{archived}</TabPanel>
		</Tabs>
	);
}
