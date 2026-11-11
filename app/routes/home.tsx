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
import { TimerStates } from "~/landing/TimerStates";
import { WeekReport } from "~/landing/WeekReport";
import { SIGN_IN_PATH, SIGN_UP_PATH } from "~/routes/auth/paths";

import type { Route } from "./+types/home";

// The home page: what Timesifier does, for someone who has not used it. The
// direction it follows is docs/design-direction.md. It is plain HTML and CSS:
// nothing on it needs script, and every link is an ordinary one, because the
// pages it leads to carry a different Content Security Policy (docs/security.md).

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

const MAIN_ID = "main";

const SECTIONS = [
	{ id: "track", label: "Track" },
	{ id: "week", label: "The week" },
	{ id: "accuracy", label: "Accuracy" },
	{ id: "privacy", label: "Privacy" },
] as const;

const PAGE = "mx-auto w-full max-w-300 px-5 medium:px-8";
const SECTION = `${PAGE} scroll-mt-8 py-16 expanded:py-24`;
const HEADING = "text-headline-large text-balance medium:text-display-small";
const LEAD = "mt-4 max-w-136 text-body-large text-on-surface-variant";
const LINK =
	"rounded-extra-small underline decoration-1 underline-offset-4 outline-none hover:decoration-2 focus-visible:focus-indicator";

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
			<a
				href={`#${MAIN_ID}`}
				className="fixed start-4 top-4 z-20 -translate-y-20 rounded-small bg-inverse-surface px-4 py-2.5 text-label-large text-inverse-on-surface outline-none focus:translate-y-0 focus-visible:focus-indicator-inverse"
			>
				Skip to main content
			</a>

			<header className="bg-sheet text-on-sheet">
				<div className={`${PAGE} flex items-center justify-between gap-6 py-5`}>
					<a
						href="/"
						aria-current="page"
						className="rounded-extra-small text-headline-small outline-none focus-visible:focus-indicator"
					>
						Timesifier
					</a>
					<nav aria-label="On this page" className="max-medium:hidden">
						<ul className="flex gap-8 text-label-large">
							{SECTIONS.map(({ id, label }) => (
								<li key={id}>
									<a
										href={`#${id}`}
										className="inline-block rounded-extra-small py-2 underline-offset-4 outline-none hover:underline focus-visible:focus-indicator"
									>
										{label}
									</a>
								</li>
							))}
						</ul>
					</nav>
				</div>
			</header>

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

			<footer className={`${PAGE} grid gap-8 py-12 text-body-medium medium:grid-cols-12`}>
				<div className="medium:col-span-5">
					<p className="text-headline-small">Timesifier</p>
					<p className="mt-2 max-w-80 text-on-surface-variant">
						Time tracking for people and small teams who bill or account for their hours.
					</p>
				</div>
				<ul className="flex flex-col gap-1 medium:col-span-3">
					{SECTIONS.map(({ id, label }) => (
						<li key={id}>
							<a href={`#${id}`} className={`${LINK} inline-block py-1`}>
								{label}
							</a>
						</li>
					))}
					<li>
						<a href={SIGN_IN_PATH} className={`${LINK} inline-block py-1`}>
							Sign in
						</a>
					</li>
				</ul>
				<div className="text-on-surface-variant medium:col-span-4">
					<p>
						Photographs by Karri Heiskanen, Bob van Aubel, vũ tuấn and Nikolai Kolosov, from
						Unsplash.
					</p>
					<p className="mt-2">© 2026 Timesifier</p>
				</div>
			</footer>
		</>
	);
}
