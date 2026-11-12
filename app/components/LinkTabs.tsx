import type { ReactNode } from "react";
import { Link, type To } from "react-router";

import { finishRunningTransition } from "~/shell/transitions";

import { cx } from "./cx";
import { TAB, TAB_INDICATOR, TAB_ROW } from "./Tabs";

export interface LinkTab {
	/** Names the tab for `current`. */
	id: string;
	/** The tab's own address. */
	to: To;
	/** The tab's label. */
	label: ReactNode;
}

export interface LinkTabsProps {
	/** What the tabs choose between, for assistive technology: "Report period". */
	label: string;
	/** The tabs, in order. */
	tabs: LinkTab[];
	/** The `id` of the tab whose address is shown. */
	current: string;
	/** More tabs than fit a compact window: there they wrap into rows of three rather than squeeze or hide. */
	wraps?: boolean;
}

/**
 * Tabs that are links: each view has an address of its own, so it can be
 * bookmarked and reloaded. Drawn exactly like `Tabs`. A group, not a landmark:
 * the shell has one navigation landmark, the main one. The shown tab is marked
 * `aria-current="page"`. Place it below the page's heading and intro.
 */
export function LinkTabs({ label, tabs, current, wraps = false }: LinkTabsProps) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: a fieldset is for form controls; these are links named as one group.
		<div
			role="group"
			aria-label={label}
			className={cx(TAB_ROW, wraps && "max-medium:grid max-medium:grid-cols-3 max-medium:*:px-2")}
		>
			{tabs.map((tab) => {
				const isCurrent = tab.id === current;
				return (
					<Link
						key={tab.id}
						to={tab.to}
						preventScrollReset
						onClick={finishRunningTransition}
						aria-current={isCurrent ? "page" : undefined}
						className={cx(
							TAB,
							"hover:state-hover focus-visible:focus-indicator-inner active:state-pressed",
							isCurrent ? "text-primary" : "text-on-surface-variant hover:text-on-surface",
						)}
					>
						{tab.label}
						{isCurrent && <span aria-hidden="true" className={TAB_INDICATOR} />}
					</Link>
				);
			})}
		</div>
	);
}
