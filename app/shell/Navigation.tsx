import { ViewTransition } from "react";
import { Link } from "react-router";

import { PAGE } from "~/landing/Site";

import { type Destination, destinationPath, destinations } from "./destinations";
import { finishRunningTransition, INDICATOR_NAME, TRANSITION } from "./transitions";

// One navigation, drawn two ways by CSS alone (design rule 17), in the public
// pages' words and rules (docs/design-direction.md, "For the product screens").
// Under 600px it is a bar along the bottom edge: 64px of paper under a 2px ink
// rule, its destinations side by side. From 600px it is a column of the same
// links beside the page, under the band, where it stays as the page scrolls.
// Each destination is its label in label-large; the current one is marked by a
// 2px ink rule, under its label in the bar and before it in the column, and by
// `aria-current`. Nothing is filled and nothing is amber.

export interface NavigationProps {
	/** The slug of the organisation whose destinations these are. */
	organisation: string;
	/** The position of the destination on screen, which is marked as the current page. */
	activeIndex: number;
}

/** The shell's navigation: every destination of one organisation as a link. */
export function Navigation({ organisation, activeIndex }: NavigationProps) {
	return (
		// From 600px the column is fixed under the band at the start of the page's
		// own column: the outer two layers place it and let presses through, as a
		// fixed element is what the browser still hit-tests while a view transition
		// runs, so a press can interrupt it (design rule 8).
		<div className="max-medium:contents medium:pointer-events-none medium:fixed medium:inset-x-0 medium:top-20 medium:z-10">
			<div className={`${PAGE} max-medium:contents`}>
				<nav
					aria-label="Main"
					className={
						"z-10 bg-surface " +
						"max-medium:fixed max-medium:inset-x-0 max-medium:bottom-0 max-medium:h-16 max-medium:border-t-2 max-medium:border-on-surface " +
						"medium:pointer-events-auto medium:w-24 medium:pt-10"
					}
				>
					<ul className="flex max-medium:h-full medium:flex-col">
						{destinations.map((destination, index) => (
							<li key={destination.id} className="max-medium:flex-1">
								<DestinationLink
									destination={destination}
									to={destinationPath(organisation, destination.id)}
									isActive={index === activeIndex}
								/>
							</li>
						))}
					</ul>
				</nav>
			</div>
		</div>
	);
}

function DestinationLink({
	destination,
	to,
	isActive,
}: {
	destination: Destination;
	/** Its address in the organisation on screen. */
	to: string;
	isActive: boolean;
}) {
	return (
		<Link
			to={to}
			prefetch="intent"
			aria-current={isActive ? "page" : undefined}
			onClick={finishRunningTransition}
			className="group relative flex items-center text-label-large outline-none max-medium:h-full max-medium:justify-center medium:h-12 medium:ps-4"
		>
			{/* The keyboard's focus indicator is drawn around the label. */}
			<span className="rounded-extra-small py-1 underline-offset-4 group-hover:underline group-focus-visible:focus-indicator">
				{destination.label}
			</span>
			{/* The one part of the navigation that travels when the destination changes. */}
			{isActive && (
				<ViewTransition name={INDICATOR_NAME} share={TRANSITION.indicator} default="none">
					<span
						aria-hidden="true"
						className="absolute bg-on-surface max-medium:start-1/2 max-medium:bottom-3 max-medium:h-0.5 max-medium:w-6 max-medium:-translate-x-1/2 medium:start-0 medium:top-3 medium:h-6 medium:w-0.5"
					/>
				</ViewTransition>
			)}
		</Link>
	);
}
