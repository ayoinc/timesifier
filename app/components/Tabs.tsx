import type { ReactNode } from "react";
import {
	Tab as AriaTab,
	TabList as AriaTabList,
	TabPanel as AriaTabPanel,
	Tabs as AriaTabs,
	type TabsProps as AriaTabsProps,
	SelectionIndicator,
} from "react-aria-components";

// Material 3 primary tabs: a 48px row of equal-width tabs on the surface with a
// 1px divider under it. Labels are title-small. The selected tab's label is the
// primary colour, over a 3px rule across the tab, 16px in from either side; the
// rule slides to the tab that becomes selected. The focus indicator sits inside
// the tab. `LinkTabs` draws the same row with links, from the classes below.

/** The row: equal-width tabs over a 1px divider. */
export const TAB_ROW = "flex border-outline-variant border-b";

/** One tab, drawn the same whether it is a React Aria tab or a link. */
export const TAB =
	"relative flex h-12 flex-1 cursor-pointer select-none items-center justify-center px-4 text-title-small outline-none state-layer transition-control";

/** The 3px rule under the selected tab. */
export const TAB_INDICATOR = "absolute inset-x-4 bottom-0 h-0.75 rounded-t-full bg-primary";

export interface TabsProps
	extends Pick<AriaTabsProps, "selectedKey" | "defaultSelectedKey" | "onSelectionChange"> {
	/** One `TabList`, then one `TabPanel` for each tab. */
	children: ReactNode;
}

/**
 * Views of the same thing, one shown at a time. Left and Right move between tabs
 * and select as they go; Home and End jump to the first and last; Tab moves into the panel.
 */
export function Tabs(props: TabsProps) {
	return <AriaTabs {...props} className="flex flex-col" />;
}

export interface TabListProps {
	/** What the tabs choose between, for assistive technology: "Report period". */
	label: string;
	/** The `Tab`s. */
	children: ReactNode;
}

/** The row of tabs. */
export function TabList({ label, children }: TabListProps) {
	return (
		<AriaTabList aria-label={label} className={TAB_ROW}>
			{children}
		</AriaTabList>
	);
}

export interface TabProps {
	/** Matches the `id` of the panel this tab shows. */
	id: string;
	/** The tab's label. */
	children: ReactNode;
	/** Shown, but cannot be selected. */
	isDisabled?: boolean;
}

/** One tab. */
export function Tab({ id, children, isDisabled }: TabProps) {
	return (
		<AriaTab
			id={id}
			isDisabled={isDisabled}
			className={
				`${TAB} text-on-surface-variant ` +
				"data-hovered:not-data-selected:text-on-surface data-hovered:state-hover data-focus-visible:state-focus data-focus-visible:focus-indicator-inner data-pressed:state-pressed " +
				"data-selected:text-primary data-disabled:cursor-not-allowed data-disabled:text-disabled"
			}
		>
			{children}
			<SelectionIndicator
				className={`${TAB_INDICATOR} transition-indicator duration-spring ease-spring motion-reduce:transition-none`}
			/>
		</AriaTab>
	);
}

export interface TabPanelProps {
	/** Matches the `id` of the tab that shows this panel. */
	id: string;
	/** The panel's content. */
	children: ReactNode;
}

/**
 * The content one tab shows. It has space above and below but none at the
 * sides, so a list in it lines up with the tabs and the page's column.
 */
export function TabPanel({ id, children }: TabPanelProps) {
	return (
		<AriaTabPanel
			id={id}
			className="py-4 text-body-medium text-on-surface outline-none data-focus-visible:focus-indicator-inner"
		>
			{children}
		</AriaTabPanel>
	);
}
