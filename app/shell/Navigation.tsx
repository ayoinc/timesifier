import { type MouseEvent, ViewTransition } from "react";
import { Link } from "react-router";

import { cx } from "~/components/cx";
import { PAGE } from "~/landing/Site";

import {
	compactNavigation,
	type Destination,
	type DestinationId,
	destinationPath,
	destinations,
	navigationGroups,
} from "./destinations";
import { NavigationTimer } from "./NavigationTimer";
import { finishRunningTransition, INDICATOR_NAME, TRANSITION } from "./transitions";

// One navigation, drawn two ways by CSS alone (design rule 17), in the public
// pages' words and rules (docs/design-direction.md, "For the product screens").
//
// From 600px it is a column of every link the person is shown, beside the
// page, under the band, where it stays as the page scrolls, with the links
// grouped under their headings (docs/navigation.md). An owner's fourteen links
// are taller than a short window: the column then scrolls on its own.
//
// Under 600px it is a bar along the bottom edge: 64px of paper under a 2px ink
// rule, the headings left out. It cannot hold fifteen links (audit W03), so it
// holds those of `compactNavigation`, Timesheet, Time off, Expenses and
// Projects, each with an equal share of the width and the bar's full 64px
// height to press, and "More" last, which opens the rest under their headings
// (docs/navigation.md, "The navigation under 600px"). More is the browser's own
// popover, so it opens without script. The links More holds are the same list's
// links, hidden in the bar; the popover draws them again, outside the list.
//
// Each destination is its label in label-large (label-medium in the bar); the
// current one is marked by an ink rule, under its label in the bar and before
// it in the column, and by `aria-current`. Nothing is filled and nothing is amber.

export interface NavigationProps {
	/** The slug of the organisation whose destinations these are. */
	organisation: string;
	/** The destinations the person is shown, from the organisation's loader. */
	visible: readonly DestinationId[];
	/** The position in the whole list of the destination on screen, which is marked as the current page. */
	activeIndex: number;
	/** A number to show beside a destination's label, such as the periods waiting on Approvals; none when 0. */
	counts?: Partial<Record<DestinationId, number>>;
}

/** The id of the popover "More" opens under 600px. */
export const MORE_ID = "navigation-more";

/** The shell's navigation: the timer's control, then every destination the person is shown, as links. */
export function Navigation({ organisation, visible, activeIndex, counts = {} }: NavigationProps) {
	const active = destinations[activeIndex]?.id;
	const compact = compactNavigation(visible);
	const inMore = compact.more.flatMap((group) => group.destinations);
	const moreCurrent = inMore.find((each) => each.id === active);
	const moreCount = inMore.reduce((sum, each) => sum + (counts[each.id] ?? 0), 0);
	return (
		// From 600px the column is fixed under the band at the start of the page's
		// own column: the outer two layers place it and let presses through, as a
		// fixed element is what the browser still hit-tests while a view transition
		// runs, so a press can interrupt it (design rule 8).
		<div className="max-medium:contents medium:pointer-events-none medium:fixed medium:inset-x-0 medium:top-20 medium:bottom-0 medium:z-10 medium:pb-4">
			<div className={`${PAGE} max-medium:contents medium:h-full`}>
				<nav
					aria-label="Main"
					className={
						"z-10 bg-surface " +
						"max-medium:fixed max-medium:inset-x-0 max-medium:bottom-0 max-medium:flex max-medium:h-16 max-medium:border-t-2 max-medium:border-on-surface max-medium:px-1 " +
						"medium:pointer-events-auto medium:max-h-full medium:w-24 medium:overflow-y-auto medium:pt-6"
					}
				>
					<NavigationTimer organisation={organisation} onTimesheet={active === "timesheet"} />
					<ul className="max-medium:contents medium:flex medium:flex-col medium:gap-3">
						{navigationGroups(visible).map(({ heading, destinations: links }) => {
							const headingId = heading ? `navigation-${heading.toLowerCase()}` : undefined;
							return (
								<li key={heading ?? "none"} className="max-medium:contents">
									{heading && (
										<span
											id={headingId}
											className="block ps-4 pb-1 text-label-medium text-on-surface-variant max-medium:hidden"
										>
											{heading}
										</span>
									)}
									<ul aria-labelledby={headingId} className="max-medium:contents">
										{links.map((each) => (
											<li
												key={each.id}
												className={cx(
													"max-medium:min-w-0 max-medium:flex-1 max-medium:basis-0",
													!compact.bar.includes(each.id) && "max-medium:hidden",
												)}
											>
												<DestinationLink
													destination={each}
													to={destinationPath(organisation, each.id)}
													isActive={each.id === active}
													count={counts[each.id] ?? 0}
												/>
											</li>
										))}
									</ul>
								</li>
							);
						})}
					</ul>
					{compact.more.length > 0 && (
						<div className="min-w-0 flex-1 basis-0 medium:hidden">
							<button
								type="button"
								popoverTarget={MORE_ID}
								// Its name says what its label shows, then where the person is when
								// the page on screen is one of the destinations it holds.
								aria-label={[
									moreCount > 0 ? `More ${moreCount} pending` : "More",
									moreCurrent && `now on ${moreCurrent.label}`,
								]
									.filter(Boolean)
									.join(", ")}
								className="group relative flex h-full w-full items-center justify-center text-label-medium outline-none"
							>
								<span className="rounded-extra-small px-1 py-1 hover-underline transition-link group-hover:decoration-current group-focus-visible:focus-indicator">
									More
									{moreCount > 0 && <span className="tabular-nums"> {moreCount}</span>}
								</span>
								{moreCurrent && <Indicator />}
							</button>
							<div
								id={MORE_ID}
								popover="auto"
								className={
									"fixed inset-auto end-2 bottom-18 m-0 max-h-4/5 w-60 overflow-auto " +
									"rounded-large border-2 border-on-surface bg-surface p-2 text-on-surface shadow-level2 medium:hidden"
								}
							>
								{compact.more.map(({ heading, destinations: links }) => {
									const headingId = `${MORE_ID}-${(heading ?? "other").toLowerCase()}`;
									return (
										<div key={heading ?? "none"} className="not-first:mt-2">
											{heading && (
												<p
													id={headingId}
													className="px-3 pt-2 pb-1 text-label-medium text-on-surface-variant"
												>
													{heading}
												</p>
											)}
											<ul aria-labelledby={heading ? headingId : undefined}>
												{links.map((each) => (
													<li key={each.id}>
														<MoreLink
															destination={each}
															to={destinationPath(organisation, each.id)}
															isActive={each.id === active}
															count={counts[each.id] ?? 0}
														/>
													</li>
												))}
											</ul>
										</div>
									);
								})}
							</div>
						</div>
					)}
				</nav>
			</div>
		</div>
	);
}

/** Shown after a label when more than 0, and read out as "N pending". */
function Count({ count }: { count: number }) {
	if (count <= 0) return null;
	return (
		<>
			{" "}
			<span className="tabular-nums">{count}</span>
			<span className="sr-only"> pending</span>
		</>
	);
}

/** The rule that marks the current destination: the one part of the navigation that travels when it changes. */
function Indicator() {
	return (
		<ViewTransition name={INDICATOR_NAME} share={TRANSITION.indicator} default="none">
			<span
				aria-hidden="true"
				className="absolute bg-on-surface max-medium:start-1/2 max-medium:bottom-2 max-medium:h-1 max-medium:w-10 max-medium:-translate-x-1/2 max-medium:rounded-full medium:start-0 medium:top-2 medium:h-6 medium:w-0.5"
			/>
		</ViewTransition>
	);
}

function DestinationLink({
	destination,
	to,
	isActive,
	count,
}: {
	destination: Destination;
	/** Its address in the organisation on screen. */
	to: string;
	isActive: boolean;
	count: number;
}) {
	return (
		<Link
			to={to}
			prefetch="intent"
			aria-current={isActive ? "page" : undefined}
			onClick={finishRunningTransition}
			className="group relative flex items-center text-label-large outline-none max-medium:h-full max-medium:justify-center max-medium:whitespace-nowrap max-medium:text-label-medium medium:min-h-10 medium:ps-4"
		>
			{/* The keyboard's focus indicator is drawn around the label. */}
			<span className="rounded-extra-small py-1 hover-underline transition-link group-hover:decoration-current group-focus-visible:focus-indicator max-medium:px-1">
				{destination.barLabel ? (
					<>
						<span aria-hidden="true" className="medium:hidden">
							{destination.barLabel}
						</span>
						<span className="max-medium:sr-only">{destination.label}</span>
					</>
				) : (
					destination.label
				)}
				<Count count={count} />
			</span>
			{isActive && <Indicator />}
		</Link>
	);
}

/** A destination in the popover "More" opens: a row 48px tall. Choosing it closes the popover. */
function MoreLink({
	destination,
	to,
	isActive,
	count,
}: {
	destination: Destination;
	to: string;
	isActive: boolean;
	count: number;
}) {
	const close = (event: MouseEvent<HTMLAnchorElement>) => {
		finishRunningTransition();
		event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
	};
	return (
		<Link
			to={to}
			prefetch="intent"
			aria-current={isActive ? "page" : undefined}
			onClick={close}
			className="group flex min-h-12 items-center rounded-small px-3 text-label-large outline-none hover:bg-surface-container-high focus-visible:focus-indicator-inner"
		>
			<span
				className={cx(
					"hover-underline transition-link group-hover:decoration-current",
					isActive && "decoration-current",
				)}
			>
				{destination.label}
				<Count count={count} />
			</span>
		</Link>
	);
}
