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
	rootOrigin,
	SiteFooter,
	SiteHeader,
	SkipLink,
} from "~/landing/Site";
import { TimerStates } from "~/landing/TimerStates";
import { WeekReport } from "~/landing/WeekReport";
import { YearStrip } from "~/landing/YearStrip";
import { SIGN_IN_PATH } from "~/routes/auth/paths";
import { requireSignedOut } from "~/routes/auth/session.server";

import type { Route } from "./+types/home";

// The home page: what Timesifier does, for someone who has not used it. The
// direction it follows is docs/design-direction.md, and what it shares with the
// other public pages is in ~/landing/Site. The server sends it whole and still.
// With script, one clock runs through it (~/landing/RunningDay); what moves as
// it is scrolled is in ~/landing/public.css.

const DESCRIPTION =
	"A timer, timesheets and reports for people and small teams who bill or account for their time, with approvals, leave, expenses and invoices. The database is in the EU.";

export function meta({ matches }: Route.MetaArgs) {
	const origin = rootOrigin(matches);
	return [
		...pageMeta({
			origin,
			path: "/",
			title: "Timesifier: track your hours, trust the total",
			description: DESCRIPTION,
		}),
		{ "script:ld+json": structuredData(origin) },
	];
}

/** The mark on its square, as the browser's install icon shows it: 512 by 512. */
const LOGO_PATH = "/icon-512.png";

/**
 * What the home page tells a search engine about who and what Timesifier is.
 * The organisation is named by its brand alone: the legal entity behind it is
 * not on any page yet (privacy notice, "Who is responsible"). The application
 * carries no price and no rating: it has neither to state. It is a data block,
 * not a script: the browser runs nothing from it, so it needs no nonce.
 */
function structuredData(origin: string) {
	return {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "Organization",
				name: "Timesifier",
				url: `${origin}/`,
				logo: `${origin}${LOGO_PATH}`,
			},
			{
				"@type": "SoftwareApplication",
				name: "Timesifier",
				url: `${origin}/`,
				description: DESCRIPTION,
				applicationCategory: "BusinessApplication",
				operatingSystem: "Web",
			},
		],
	};
}

/** A person who is signed in is sent to the application and never sees this page. */
export const middleware: Route.MiddlewareFunction[] = [requireSignedOut];

/**
 * Nothing to load. Its being here makes a move to this page from inside the
 * application ask the server, and so pass the middleware above.
 */
export function loader() {
	return null;
}

const SECTIONS = [
	{ href: "#track", label: "Track" },
	{ href: "#week", label: "The week" },
	{ href: "#accuracy", label: "Accuracy" },
	{ href: "#privacy", label: "Privacy" },
] as const;

const SECTION = `${PAGE} py-16 expanded:py-24`;
const HEADING = "text-headline-large text-balance medium:text-display-small";
const LEAD = "max-w-136 text-body-large text-on-surface-variant";

/**
 * The opening of a section that runs the width of the page: from 840px the
 * heading stands at the left and the words that lead into the section at the
 * right, on the heading's first line. They rise into place (`rise` in public.css).
 */
function SectionHead({ id, title, children }: { id: string; title: string; children: ReactNode }) {
	return (
		<div className="rise grid gap-4 expanded:grid-cols-12 expanded:items-baseline expanded:gap-8">
			<h2 id={id} className={`${HEADING} expanded:col-span-6`}>
				{title}
			</h2>
			<p className={`${LEAD} expanded:col-span-5 expanded:col-start-8`}>{children}</p>
		</div>
	);
}

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
			className="inline-flex h-12 items-center rounded-small px-6 text-title-medium text-sheet outline-none state-layer over-on-sheet press transition-control hover:state-hover focus-visible:state-focus focus-visible:focus-indicator active:state-pressed motion-safe:active:scale-97"
		>
			{PRIMARY_ACTION}
		</a>
	);
}

/**
 * What opening the action leads to, said wherever the page asks a person in.
 */
function OpenToday() {
	return (
		<p className="mt-4 max-w-120 text-body-medium text-on-sheet-variant">
			Free today. Sign in with your email address, set up your organisation and a first project, and
			start the timer.
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
			<SectionHead id="accuracy-heading" title="Numbers you can show.">
				An entry keeps its start and its end, and a total is the entries under it added together.
				When a client or a manager asks what {day.weekday} was, the answer is on the page.
			</SectionHead>
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
								Timesifier is a timer and a weekly report for people who bill or answer for their
								time. You start it when you start work, and by Friday the week is added up, by
								project and by day. Timesheets, leave, expenses and invoices sit beside it.
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
							<div className="rise">
								<h2 id="track-heading" className={HEADING}>
									One press starts the clock.
								</h2>
								<p className={`mt-4 ${LEAD}`}>
									You say what you are working on, choose the project and start. When you stop, the
									entry is on the day with its start and its end. If you forgot to start it, you add
									the entry by hand.
								</p>
							</div>
							<div className="mt-10">
								<TimerStates />
							</div>
						</div>
						<Photo
							photo={PHOTOS.workshop}
							alt="Gloved hands working a piece of metal on a workbench covered in filings."
							sizes="(min-width: 75rem) 470px, (min-width: 52.5rem) 40vw, 100vw"
							className="expanded:order-first expanded:col-span-5 expanded:row-start-1"
							frame="max-medium:aspect-square"
						/>
					</div>
				</section>

				<section id="week" aria-labelledby="week-heading" className="bg-surface-container-low">
					<div className={SECTION}>
						<SectionHead id="week-heading" title="See where the week went.">
							Every entry lands in the week, under its project and its day. In the example below,
							read across for a project, down for a day; the longest bar is where the week went.
						</SectionHead>
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
							<div className="rise">
								<h2 id="privacy-heading" className={HEADING}>
									Stored in the EU. Closed to everyone outside your organisation.
								</h2>
							</div>
							<dl className="mt-8 border-b border-outline-variant">
								<Fact term="Stored in the European Union">
									Your account and your organisation’s work, its time, leave, expenses and invoices,
									are kept in a database that runs and stores its data only inside the EU. Receipts
									are kept in storage restricted to the EU.
								</Fact>
								<Fact term="Run near the database">
									Your request reaches the Cloudflare data centre nearest to you, wherever you are,
									and is passed to Frankfurt, near the database, where the application runs.
									Cloudflare’s log of requests, its record of each email sent, and what its
									Turnstile check and Web Analytics collect are not restricted to the EU.
								</Fact>
								<Fact term="Closed to other organisations">
									A record belongs to one organisation, and nobody outside it can read it or learn
									that it exists. Inside it, owners, admins and Finance see everyone’s time; a
									manager sees their own and their teams’; everyone else sees their own.
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
						{/* From 840px the photograph stays beside the facts while they are read. */}
						<Photo
							photo={PHOTOS.platform}
							alt="An empty railway platform in the rain, with a yellow-rimmed station clock above a departure screen."
							sizes="(min-width: 75rem) 560px, (min-width: 52.5rem) 48vw, 100vw"
							className="max-medium:hidden expanded:sticky expanded:top-28 expanded:order-first expanded:col-span-6 expanded:row-start-1"
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
							<div className="rise">
								<h2
									id="start-heading"
									className="text-display-small text-balance large:text-display-medium"
								>
									The hour is passing either way. Put it on the record.
								</h2>
							</div>
							<p className="mt-8">
								<GetStarted />
							</p>
							<OpenToday />
						</div>
						<Photo
							photo={PHOTOS.departure}
							alt="A yellow underground train blurred by its speed as it passes a station clock."
							sizes="(min-width: 75rem) 660px, (min-width: 52.5rem) 55vw, 100vw"
							className="expanded:col-span-7"
						/>
					</div>
				</section>
			</main>

			<SiteFooter current="/" photos={[PHOTOS.workshop, PHOTOS.platform, PHOTOS.departure]} />
		</RunningDayProvider>
	);
}
