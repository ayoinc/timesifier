import type { ReactNode } from "react";

import type { Operator } from "./operator";
import { GetStarted, OpenToday } from "./Section";
import { MAIN_ID, PAGE, SiteFooter, SiteHeader, SkipLink } from "./Site";

// The frame of the pages a buyer reads (TS-106): features, pricing,
// integrations, the API reference and contact. Like the home page they open on
// the departure sheet and end on it, with the one way in; what is between is
// on the page's surface. Plain HTML and CSS: nothing on them needs script.

export interface BuyerPageProps {
	/** The page's address, which the band and the foot mark as the current page. */
	path: string;
	title: string;
	/** What the page says, in a sentence or two. */
	lead: ReactNode;
	/** The company that runs this deployment, which the foot names. */
	operator: Operator;
	/** Whether the page ends with the way in. The contact page and the API reference do not. */
	invite?: boolean;
	children: ReactNode;
}

export function BuyerPage({
	path,
	title,
	lead,
	operator,
	invite = true,
	children,
}: BuyerPageProps) {
	return (
		<>
			<SkipLink />
			<SiteHeader current={path} />

			<main id={MAIN_ID} tabIndex={-1} className="outline-none">
				<div className="bg-sheet text-on-sheet">
					<div className={`${PAGE} pt-8 pb-12 expanded:pt-16 expanded:pb-20`}>
						<h1 className="max-w-240 text-display-small text-balance medium:text-display-medium">
							{title}
						</h1>
						<div className="mt-6 max-w-136 text-body-large text-on-sheet-variant">{lead}</div>
					</div>
				</div>

				{children}

				{invite && (
					<section aria-labelledby="start-heading" className="bg-sheet text-on-sheet">
						<div
							className={`${PAGE} grid gap-8 py-16 expanded:grid-cols-12 expanded:items-end expanded:py-24`}
						>
							<div className="rise expanded:col-span-7">
								<h2
									id="start-heading"
									className="text-display-small text-balance large:text-display-medium"
								>
									The hour is passing either way. Put it on the record.
								</h2>
							</div>
							<div className="expanded:col-span-5">
								<p>
									<GetStarted />
								</p>
								<OpenToday />
							</div>
						</div>
					</section>
				)}
			</main>

			<SiteFooter current={path} operator={operator} />
		</>
	);
}
