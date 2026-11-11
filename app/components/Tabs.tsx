import type { ReactNode } from "react";
import {
	Tab as AriaTab,
	TabList as AriaTabList,
	TabPanel as AriaTabPanel,
	Tabs as AriaTabs,
	type TabsProps as AriaTabsProps,
	SelectionIndicator,
} from "react-aria-components";

// Material 3 primary tabs: a 48px row on the surface with a 1px divider under it.
// Labels are title-small. The selected tab's label is the primary colour, with a
// 3px indicator under it as wide as the label; the indicator slides to the tab
// that becomes selected. The focus indicator sits inside the tab.

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
		<AriaTabList aria-label={label} className="flex border-outline-variant border-b">
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
				"flex h-12 flex-1 cursor-pointer select-none justify-center px-4 text-on-surface-variant text-title-small outline-none state-layer transition-control " +
				"data-hovered:not-data-selected:text-on-surface data-hovered:state-hover data-focus-visible:state-focus data-focus-visible:focus-indicator-inner data-pressed:state-pressed " +
				"data-selected:text-primary data-disabled:cursor-not-allowed data-disabled:text-disabled"
			}
		>
			<span className="relative flex h-full items-center">
				{children}
				<SelectionIndicator className="absolute inset-x-0 bottom-0 h-0.75 rounded-t-full bg-primary transition-indicator duration-spring ease-spring motion-reduce:transition-none" />
			</span>
		</AriaTab>
	);
}

export interface TabPanelProps {
	/** Matches the `id` of the tab that shows this panel. */
	id: string;
	/** The panel's content. */
	children: ReactNode;
}

/** The content one tab shows. */
export function TabPanel({ id, children }: TabPanelProps) {
	return (
		<AriaTabPanel
			id={id}
			className="p-4 text-body-medium text-on-surface outline-none data-focus-visible:focus-indicator-inner"
		>
			{children}
		</AriaTabPanel>
	);
}
