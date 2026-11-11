import type { ReactNode } from "react";

import { DaySheet } from "~/landing/DaySheet";
import {
	clock,
	DAYS,
	dayTotals,
	duration,
	length,
	TODAY,
	TODAY_ENTRIES,
} from "~/landing/example-week";
import { Photo } from "~/landing/Photo";
import { PHOTOS } from "~/landing/photos";
import {
	LINK,
	MAIN_ID,
	PAGE,
	PRIVACY_PATH,
	SiteFooter,
	SiteHeader,
	SkipLink,
} from "~/landing/Site";
import { TimerStates } from "~/landing/TimerStates";
import { WeekReport } from "~/landing/WeekReport";
import { SIGN_IN_PATH, SIGN_UP_PATH } from "~/routes/auth/paths";

import type { Route } from "./+types/home";

// The home page: what Timesifier does, for someone who has not used it. The
// direction it follows is docs/design-direction.md, and what it shares with the
// other public pages is in ~/landing/Site.

export function meta(_: Route.MetaArgs) {
	return [
		{ title: "Timesifier: track your hours, trust the total" },
		{
			name: "description",
			content:
				"A timer and a weekly report for people and small teams who bill or account for their time. Kept in the EU.",
		},
	];
}

const SECTIONS = [
	{ href: "#track", label: "Track" },
	{ href: "#week", label: "The week" },
	{ href: "#accuracy", label: "Accuracy" },
	{ href: "#privacy", label: "Privacy" },
] as const;

const SECTION = `${PAGE} scroll-mt-8 py-16 expanded:py-24`;
const HEADING = "text-headline-large text-balance medium:text-display-small";
const LEAD = "mt-4 max-w-136 text-body-large text-on-surface-variant";

/** The page's one primary action. It stands on the sheet, in the sheet's two colours swapped. */
function CreateAccount() {
	return (
		<a
			href={SIGN_UP_PATH}
			className="inline-flex h-12 items-center rounded-small px-6 text-title-medium text-sheet outline-none state-layer over-on-sheet transition-control hover:state-hover focus-visible:state-focus focus-visible:focus-indicator active:state-pressed"
		>
			Create an account
		</a>
	);
}

/**
 * What a person gets by creating an account today, said wherever the page asks
 * them to. The sections describe the product being built; this line is where it stands.
 */
function OpenToday() {
	return (
		<p className="mt-4 max-w-120 text-body-medium text-on-sheet-variant">
			Open today: accounts and organisations. The timer and the weekly report are being built.
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

export default function Home() {
	const today = DAYS[TODAY];

	return (
		<>
			<SkipLink />
			<SiteHeader isHome label="On this page" links={SECTIONS} />

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
								time. Start it when you start work. By Friday the week is already added up, by
								project and by day.
							</p>
							<p className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
								<CreateAccount />
								<a href={SIGN_IN_PATH} className={`${LINK} py-2 text-title-medium`}>
									Sign in
								</a>
							</p>
							<OpenToday />
						</div>
						<div className="min-w-0 expanded:col-span-6 large:col-span-5">
							<DaySheet />
						</div>
					</div>
				</div>

				<section id="track" aria-labelledby="track-heading" className={SECTION}>
					<div className="grid gap-10 expanded:grid-cols-12 expanded:items-center expanded:gap-8">
						<Photo
							photo={PHOTOS.workshop}
							alt="Gloved hands working a piece of metal on a workbench covered in filings."
							sizes="(min-width: 75rem) 400px, (min-width: 52.5rem) 33vw, 100vw"
							caption="A workshop in Utrecht. Photograph: Bob van Aubel."
							className="expanded:col-span-4"
						/>
						<div className="min-w-0 expanded:col-span-7 expanded:col-start-6">
							<h2 id="track-heading" className={HEADING}>
								Start the clock in one press.
							</h2>
							<p className={LEAD}>
								Say what you are working on, choose the project and start. When you stop, the entry
								is on the day with its start and its end. If you forgot to start it, add the entry
								by hand with the times you worked.
							</p>
							<div className="mt-10">
								<TimerStates />
							</div>
						</div>
					</div>
				</section>

				<section id="week" aria-labelledby="week-heading" className="bg-surface-container-low">
					<div className={SECTION}>
						<h2 id="week-heading" className={HEADING}>
							See where the week went.
						</h2>
						<p className={LEAD}>
							Every entry lands in the week, under its project and its day. Read across for a
							project, down for a day. The longest bar is where the week went.
						</p>
						<div className="mt-10">
							<WeekReport />
						</div>
					</div>
				</section>

				<section id="accuracy" aria-labelledby="accuracy-heading" className={SECTION}>
					<div className="grid gap-10 expanded:grid-cols-12 expanded:items-center expanded:gap-8">
						<div className="min-w-0 expanded:col-span-5">
							<h2 id="accuracy-heading" className={HEADING}>
								Bill from numbers you can show.
							</h2>
							<p className={LEAD}>
								An entry keeps its start and its end, and a total is the entries under it added
								together, to the minute. When a client or a manager asks what {today.name} was, the
								answer is on the page.
							</p>
							<p className="mt-8 border-y-2 border-on-surface py-4">
								<span className="block text-label-large text-on-surface-variant">
									{today.name} {today.date} November
								</span>
								<span className="mt-1 flex flex-wrap items-baseline gap-x-3 text-headline-small tabular-nums">
									{TODAY_ENTRIES.map((entry, index) => (
										<span key={entry.start}>
											{index > 0 && <span className="pe-3 text-on-surface-variant">+</span>}
											<span className="sr-only">
												{clock(entry.start)} to {clock(entry.end)}:{" "}
											</span>
											{duration(length(entry))}
										</span>
									))}
									<span className="text-on-surface-variant">=</span>
									<span className="text-headline-large">{duration(dayTotals[TODAY] ?? 0)}</span>
								</span>
							</p>
						</div>
						<Photo
							photo={PHOTOS.desk}
							alt="A hand on a mouse at a wooden desk, beside a sheet of drawings, a pen and a calculator."
							sizes="(min-width: 75rem) 660px, (min-width: 52.5rem) 55vw, 100vw"
							caption="Drawings, a pen and a calculator. Photograph: vũ tuấn."
							className="expanded:col-span-7"
						/>
					</div>
				</section>

				<section
					id="privacy"
					aria-labelledby="privacy-heading"
					className="bg-surface-container-low"
				>
					<div
						className={`${SECTION} grid gap-10 expanded:grid-cols-12 expanded:items-start expanded:gap-8`}
					>
						<Photo
							photo={PHOTOS.platform}
							alt="An empty railway platform in the rain, with a yellow-rimmed station clock above a departure screen."
							sizes="(min-width: 75rem) 560px, (min-width: 52.5rem) 48vw, 100vw"
							caption="Amsterdam Sloterdijk. Photograph: Nikolai Kolosov."
							className="expanded:col-span-6"
						/>
						<div className="min-w-0 expanded:col-span-5 expanded:col-start-8">
							<h2 id="privacy-heading" className={HEADING}>
								Kept in the EU. Private by default.
							</h2>
							<dl className="mt-8 border-b border-outline-variant">
								<Fact term="Stored in the European Union">
									Your entries are kept in a database that runs and stores its data only inside the
									EU.
								</Fact>
								<Fact term="Read by your organisation only">
									A record belongs to one organisation. Only the people you have invited into it can
									read it.
								</Fact>
								<Fact term="No password to lose">
									Timesifier never asks for one. You sign in with a code sent to your email address.
								</Fact>
							</dl>
							<p className="mt-6 text-body-large">
								<a href={PRIVACY_PATH} className={LINK}>
									Read exactly what is stored
								</a>
							</p>
						</div>
					</div>
				</section>

				<section aria-labelledby="start-heading" className="bg-sheet text-on-sheet">
					<div
						className={`${PAGE} grid gap-10 py-16 expanded:grid-cols-12 expanded:items-center expanded:gap-8 expanded:py-24`}
					>
						<div className="min-w-0 expanded:col-span-5">
							<h2
								id="start-heading"
								className="text-display-small text-balance large:text-display-medium"
							>
								The hour is passing either way. Put it on the record.
							</h2>
							<p className="mt-8">
								<CreateAccount />
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

			<SiteFooter links={SECTIONS}>
				<p>
					Photographs by Karri Heiskanen, Bob van Aubel, vũ tuấn and Nikolai Kolosov, from Unsplash.
				</p>
			</SiteFooter>
		</>
	);
}
