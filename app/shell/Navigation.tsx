import { type ComponentType, ViewTransition } from "react";
import { Link } from "react-router";

import { cx } from "~/components/cx";
import { BarChartIcon } from "~/components/icons/BarChartIcon";
import { FolderFilledIcon } from "~/components/icons/FolderFilledIcon";
import { FolderIcon } from "~/components/icons/FolderIcon";
import type { IconProps } from "~/components/icons/Icon";
import { SettingsFilledIcon } from "~/components/icons/SettingsFilledIcon";
import { SettingsIcon } from "~/components/icons/SettingsIcon";
import { TodayFilledIcon } from "~/components/icons/TodayFilledIcon";
import { TodayIcon } from "~/components/icons/TodayIcon";

import { type Destination, type DestinationIcon, destinations } from "./destinations";
import { finishRunningTransition, INDICATOR_NAME, TRANSITION } from "./transitions";

// One navigation, drawn two ways by CSS alone (design rule 17). Under 600px it is
// a Material 3 navigation bar: 64px tall along the bottom edge, on
// surface-container at elevation 2. From 600px it is a navigation rail: 96px wide
// along the start edge, on surface, its first item 44px down. An item is the same
// in both: a 56 by 32px active indicator around a 24px icon, 4px, a label-medium
// label, 64px tall in all. Values from `md-comp-nav-bar`, `-nav-bar-item-vertical`,
// `-nav-rail-collapsed` and `-nav-rail-item-vertical`.

/** The drawing of each symbol the list names: outlined at rest, filled when its destination is active. */
const ICONS: Record<
	DestinationIcon,
	{ rest: ComponentType<IconProps>; active: ComponentType<IconProps> }
> = {
	today: { rest: TodayIcon, active: TodayFilledIcon },
	// Material draws this symbol the same filled and outlined.
	bar_chart: { rest: BarChartIcon, active: BarChartIcon },
	folder: { rest: FolderIcon, active: FolderFilledIcon },
	settings: { rest: SettingsIcon, active: SettingsFilledIcon },
};

/** The shell's navigation: every destination as a link, the one at `activeIndex` marked as the current page. */
export function Navigation({ activeIndex }: { activeIndex: number }) {
	return (
		<nav
			aria-label="Main"
			className={cx(
				"fixed z-10",
				"max-medium:inset-x-0 max-medium:bottom-0 max-medium:h-16 max-medium:bg-surface-container max-medium:shadow-level2",
				"medium:inset-y-0 medium:start-0 medium:w-24 medium:bg-surface",
			)}
		>
			<ul className="flex max-medium:h-full medium:flex-col medium:gap-1 medium:pt-11">
				{destinations.map((destination, index) => (
					<li key={destination.id} className="max-medium:flex-1">
						<DestinationLink destination={destination} isActive={index === activeIndex} />
					</li>
				))}
			</ul>
		</nav>
	);
}

function DestinationLink({
	destination,
	isActive,
}: {
	destination: Destination;
	isActive: boolean;
}) {
	const Icon = ICONS[destination.icon][isActive ? "active" : "rest"];

	return (
		<Link
			to={destination.path}
			prefetch="intent"
			aria-current={isActive ? "page" : undefined}
			onClick={finishRunningTransition}
			className="group flex h-16 flex-col items-center justify-center gap-1 outline-none"
		>
			<span className="relative grid h-8 w-14 place-items-center rounded-full group-focus-visible:focus-indicator">
				{isActive && (
					<ViewTransition name={INDICATOR_NAME} share={TRANSITION.indicator} default="none">
						<span className="absolute inset-0 rounded-full bg-secondary-container" />
					</ViewTransition>
				)}
				<span className="absolute inset-0 rounded-full text-on-secondary-container state-layer transition-control group-hover:state-hover group-focus-visible:state-focus group-active:state-pressed" />
				{/* A part of a transition is drawn above the page, so the travelling
				    indicator would cover an icon that stayed in the page. The icon is a
				    part too: the old drawing fades out and the new one fades in, above
				    the indicator. */}
				<ViewTransition key={isActive ? "active" : "rest"} default="none" enter="auto" exit="auto">
					<Icon
						className={cx(
							"relative",
							isActive ? "text-on-secondary-container" : "text-on-surface-variant",
						)}
					/>
				</ViewTransition>
			</span>
			<span
				className={cx(
					"text-label-medium transition-colors",
					isActive ? "text-secondary" : "text-on-surface-variant",
				)}
			>
				{destination.label}
			</span>
		</Link>
	);
}
