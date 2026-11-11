import {
	clock,
	DAYS,
	duration,
	LOGGED_ENTRIES,
	length,
	loggedToday,
	RUNNING,
	TODAY,
} from "./example-week";

/**
 * A day as Timesifier keeps it: the timer that is running, the entries made so
 * far and their total. It is a picture made of text, not a control: nothing in
 * it can be pressed, and the square beside the time is drawn, not a button.
 */
export function DaySheet() {
	const today = DAYS[TODAY];

	return (
		// The sheet is laid out by its own width, not the window's: beside the
		// headline on a wide window it can be narrower than it is on a phone.
		<figure className="@container flex flex-col gap-3">
			<div className="overflow-hidden rounded-large border-2 border-on-sheet bg-surface text-on-surface">
				<p className="flex items-baseline justify-between gap-4 px-4 pt-4 pb-3 text-label-large @sm:px-5">
					<span>
						Today, {today.name} {today.date} November
					</span>
					<span className="text-on-surface-variant">Example</span>
				</p>

				<div className="flex items-center gap-4 bg-primary-container px-4 py-4 text-on-primary-fixed @sm:px-5">
					<div className="min-w-0 flex-1">
						<p className="text-label-medium text-on-primary-fixed-variant">
							Running since {clock(RUNNING.entry.start)}
						</p>
						<p className="text-title-medium">{RUNNING.entry.note}</p>
						<p className="text-body-medium text-on-primary-fixed-variant">
							{RUNNING.entry.project}
						</p>
					</div>
					<p className="text-headline-medium tabular-nums @sm:text-display-small">
						{RUNNING.elapsed}
					</p>
					<span
						aria-hidden="true"
						className="grid size-10 shrink-0 place-items-center rounded-full bg-on-primary-fixed"
					>
						<span className="size-3 rounded-extra-small bg-primary-container" />
					</span>
				</div>

				<ol className="divide-y divide-outline-variant px-4 @sm:px-5">
					{LOGGED_ENTRIES.map((entry) => (
						<li key={entry.start} className="flex flex-wrap items-baseline gap-x-4 py-3">
							<span className="min-w-0 flex-1">
								<span className="block text-body-large">{entry.note}</span>
								<span className="block text-body-medium text-on-surface-variant">
									{entry.project}
								</span>
							</span>
							<span className="text-title-large tabular-nums">{duration(length(entry))}</span>
							{/* The times are a column of their own where there is room for one,
							    and a line under the project where there is not. */}
							<span className="basis-full text-body-medium whitespace-nowrap text-on-surface-variant tabular-nums @sm:order-first @sm:w-24 @sm:shrink-0 @sm:basis-auto">
								{clock(entry.start)}–{clock(entry.end)}
							</span>
						</li>
					))}
				</ol>

				<p className="mx-4 flex items-baseline justify-between gap-4 border-t-2 border-on-surface py-3 @sm:mx-5">
					<span className="text-label-large">Logged so far</span>
					<span className="text-title-large tabular-nums">{duration(loggedToday)}</span>
				</p>
			</div>
			<figcaption className="text-body-small text-on-sheet-variant">
				A day in Timesifier: one timer, the entries it made, and their total.
			</figcaption>
		</figure>
	);
}
