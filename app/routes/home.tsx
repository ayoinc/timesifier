import type { ReactNode } from "react";
import { DayAnatomy } from "~/landing/DayAnatomy";
import { DaySheet } from "~/landing/DaySheet";
import { DaySum } from "~/landing/DaySum";
import { Photo } from "~/landing/Photo";
import { PHOTOS } from "~/landing/photos";
import { RunningDayProvider, useRunningDay } from "~/landing/RunningDay";
import {
	LINK,
	MAIN_ID,
	PAGE,
	PRIMARY_ACTION,
	PRIVACY_PATH,
	pageMeta,
	SiteFooter,
	SiteHeader,
	SkipLink,
} from "~/landing/Site";
import { TimerStates } from "~/landing/TimerStates";
import { WeekReport } from "~/landing/WeekReport";
import { YearStrip } from "~/landing/YearStrip";
import { SIGN_IN_PATH } from "~/routes/auth/paths";

import type { Route } from "./+types/home";

// The home page: what Timesifier does, for someone who has not used it. The
// direction it follows is docs/design-direction.md, and what it shares with the
// other public pages is in ~/landing/Site. The server sends it whole and still.
// With script, one clock runs through it (~/landing/RunningDay); what moves as
// it is scrolled is in ~/landing/public.css.

export function meta(_: Route.MetaArgs) {
	return pageMeta({
		path: "/",
		title: "Timesifier: a timer and a weekly report, being built",
		description:
			"A timer and a weekly report for people and small teams who bill or account for their time. In development: today you can sign in and set up your organisation. The database is in the EU.",
	});
}

const SECTIONS = [
	{ href: "#track", label: "Track" },
	{ href: "#week", label: "The week" },
	{ href: "#accuracy", label: "Accuracy" },
	{ href: "#privacy", label: "Privacy" },
] as const;

const SECTION = `${PAGE} py-16 expanded:py-24`;
const HEADING = "text-headline-large text-balance medium:text-display-small";
const LEAD = "mt-4 max-w-136 text-body-large text-on-surface-variant";

/**
 * The page's one primary action, and the one way in: the sign-in page takes a
 * person who is new and a person coming back alike. Its words promise only what
 * the next page does (`PRIMARY_ACTION` in ~/landing/Site). It stands on the
 * sheet, in the sheet's two colours swapped.
 */
function GetStarted() {
	return (
		<a
			href={SIGN_IN_PATH}
			className="inline-flex h-12 items-center rounded-small px-6 text-title-medium text-sheet outline-none state-layer over-on-sheet transition-control hover:state-hover focus-visible:state-focus focus-visible:focus-indicator active:state-pressed"
		>
			{PRIMARY_ACTION}
		</a>
	);
}

/**
 * Where the product stands today, said wherever the page asks a person in. The
 * sections describe the product being built; this line is what the action opens.
 */
function OpenToday() {
	return (
		<p className="mt-4 max-w-120 text-body-medium text-on-sheet-variant">
			Open today: sign in with your email address and set up your organisation. The timer and the
			weekly report are being built.
		</p>
	);
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
	return (
		<div className="border-t border-outline-variant py-4">
			<dt className="text-title-medium">{term}</dt>
			<dd className="mt-1 text-body-large text-on-surface-variant">{children}</dd>
		</div>
	);
}

/**
 * The accuracy section: its words, the anatomy of a working day, and under the figure
 * the day's sum as its reading. The words name the day the clock is on.
 */
function Accuracy() {
	const { day } = useRunningDay();

	return (
		<>
			<h2 id="accuracy-heading" className={HEADING}>
				Numbers you can show.
			</h2>
			<p className={LEAD}>
				An entry will keep its start and its end, and a total will be the entries under it added
				together, to the second while the timer runs. When a client or a manager asks what{" "}
				{day.weekday} was, the answer will be on the page.
			</p>
			<div className="mt-10">
				<DayAnatomy />
			</div>
			<DaySum />
		</>
	);
}

export default function Home() {
	return (
		<RunningDayProvider>
			<SkipLink />
			<SiteHeader current="/" sections={SECTIONS} />

			<main id={MAIN_ID} tabIndex={-1} className="outline-none">
				<div className="bg-sheet text-on-sheet">
					<div
						className={`${PAGE} grid gap-12 pt-8 pb-16 expanded:grid-cols-12 expanded:items-end expanded:gap-8 expanded:pt-16 expanded:pb-24`}
					>
						<div className="min-w-0 expanded:col-span-6 expanded:pb-8 large:col-span-7">
							<h1 className="text-display-small text-balance medium:text-display-medium large:text-display-large">
								Track your hours. Trust the total.
							</h1>
							<p className="mt-6 max-w-120 text-body-large text-on-sheet-variant">
								Timesifier is being built: a timer and a weekly report for people who bill or answer
								for their time. You will start it when you start work, and by Friday the week will
								be added up, by project and by day.
							</p>
							<p className="mt-8">
								<GetStarted />
							</p>
							<OpenToday />
						</div>
						<div className="min-w-0 expanded:col-span-6 large:col-span-5">
							<DaySheet />
						</div>
					</div>
				</div>

				{/* In each section the words come first in the markup, and first on a
				    narrow window. From 840px a photograph may stand before them. */}
				<section id="track" aria-labelledby="track-heading" className={SECTION}>
					<div className="grid gap-10 expanded:grid-cols-12 expanded:items-center expanded:gap-8">
						<div className="min-w-0 expanded:col-span-6 expanded:col-start-7">
							<h2 id="track-heading" className={HEADING}>
								One press will start the clock.
							</h2>
							<p className={LEAD}>
								You will say what you are working on, choose the project and start. When you stop,
								the entry will be on the day with its start and its end. If you forgot to start it,
								you will add the entry by hand.
							</p>
							<div className="mt-10">
								<TimerStates />
							</div>
						</div>
						<Photo
							photo={PHOTOS.workshop}
							alt="Gloved hands working a piece of metal on a workbench covered in filings."
							sizes="(min-width: 75rem) 470px, (min-width: 52.5rem) 40vw, 100vw"
							caption="A workshop in Utrecht. Photograph: Bob van Aubel."
							className="expanded:order-first expanded:col-span-5 expanded:row-start-1"
							frame="max-medium:aspect-square"
						/>
					</div>
				</section>

				<section id="week" aria-labelledby="week-heading" className="bg-surface-container-low">
					<div className={SECTION}>
						<h2 id="week-heading" className={HEADING}>
							See where the week went.
						</h2>
						<p className={LEAD}>
							Every entry will land in the week, under its project and its day. In the example
							below, read across for a project, down for a day; the longest bar is where the week
							went.
						</p>
						<div className="mt-10">
							<WeekReport />
						</div>
					</div>
				</section>

				<section id="accuracy" aria-labelledby="accuracy-heading" className={SECTION}>
					<Accuracy />
				</section>

				<section
					id="privacy"
					aria-labelledby="privacy-heading"
					className="bg-surface-container-low"
				>
					<div
						className={`${SECTION} grid gap-10 expanded:grid-cols-12 expanded:items-start expanded:gap-8`}
					>
						<div className="min-w-0 expanded:col-span-5 expanded:col-start-8">
							<h2 id="privacy-heading" className={HEADING}>
								Stored in the EU. Closed to everyone outside your organisation.
							</h2>
							<dl className="mt-8 border-b border-outline-variant">
								<Fact term="Stored in the European Union">
									Your account and your organisation are kept in a database that runs and stores its
									data only inside the EU. Your time entries will be kept there too.
								</Fact>
								<Fact term="Answered from the nearest data centre">
									A request is answered by the Cloudflare data centre nearest to you, wherever you
									are. Cloudflare’s log of requests, its record of each email sent, and what its
									Turnstile check and Web Analytics collect are not restricted to the EU.
								</Fact>
								<Fact term="Closed to other organisations">
									A record belongs to one organisation, and nobody outside it can read it or learn
									that it exists. Inside it, owners and admins will be able to see every member’s
									time; members will see their own.
								</Fact>
								<Fact term="No password to lose">
									Timesifier never asks for one. You sign in with a code sent to your email address.
								</Fact>
							</dl>
							<p className="mt-6 text-body-large">
								<a href={PRIVACY_PATH} className={LINK}>
									Read what is stored
								</a>
							</p>
						</div>
						<Photo
							photo={PHOTOS.platform}
							alt="An empty railway platform in the rain, with a yellow-rimmed station clock above a departure screen."
							sizes="(min-width: 75rem) 560px, (min-width: 52.5rem) 48vw, 100vw"
							caption="Amsterdam Sloterdijk. Photograph: Nikolai Kolosov."
							className="max-medium:hidden expanded:order-first expanded:col-span-6 expanded:row-start-1"
						/>
					</div>
				</section>

				<section aria-labelledby="start-heading" className="bg-sheet text-on-sheet">
					<div className={`${PAGE} pt-16 expanded:pt-24`}>
						<YearStrip />
					</div>
					<div
						className={`${PAGE} grid gap-10 pt-12 pb-16 expanded:grid-cols-12 expanded:items-center expanded:gap-8 expanded:pt-16 expanded:pb-24`}
					>
						<div className="min-w-0 expanded:col-span-5">
							<h2
								id="start-heading"
								className="text-display-small text-balance large:text-display-medium"
							>
								The hour is passing either way. Soon you can put it on the record.
							</h2>
							<p className="mt-8">
								<GetStarted />
							</p>
							<OpenToday />
						</div>
						<Photo
							photo={PHOTOS.departure}
							alt="A yellow underground train blurred by its speed as it passes a station clock."
							sizes="(min-width: 75rem) 660px, (min-width: 52.5rem) 55vw, 100vw"
							caption="U-Bahn, Berlin-Tempelhof. Photograph: Karri Heiskanen."
							className="expanded:col-span-7"
						/>
					</div>
				</section>
			</main>

			<SiteFooter current="/">
				<p>Photographs by Karri Heiskanen, Bob van Aubel and Nikolai Kolosov, from Unsplash.</p>
			</SiteFooter>
		</RunningDayProvider>
	);
}
