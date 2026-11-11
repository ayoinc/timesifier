import { Digits } from "~/components/Digits";

import { duration, EXAMPLE_NOTE, length, stopwatch } from "./example-week";
import { useRunningDay } from "./RunningDay";

/**
 * The day added up in the open: each finished entry, the one still running, and
 * their total. It is the sum the picture of the day shows, on the same clock, so
 * the last term and the total move together. Scrolled into view, the terms
 * arrive one after another and the total last (`day-sum` in public.css).
 */
export function DaySum() {
	const { day } = useRunningDay();

	return (
		<figure className="mt-8 border-y-2 border-on-surface py-4">
			<p className="flex items-baseline justify-between gap-4 text-label-large text-on-surface-variant">
				<span>{day.date}</span>
				<span>{EXAMPLE_NOTE}</span>
			</p>
			<p className="day-sum mt-1 flex flex-wrap items-baseline gap-x-3 text-headline-small tabular-nums">
				{day.logged.map((entry, index) => (
					<span key={entry.note}>
						{index > 0 && <span className="pe-3 text-on-surface-variant">+</span>}
						{duration(length(entry))}
					</span>
				))}
				<span>
					<span className="pe-3 text-on-surface-variant">+</span>
					<Digits value={stopwatch(day.elapsed)} />
				</span>
				<span>
					<span className="pe-3 text-on-surface-variant">=</span>
					<span className="text-headline-large">
						<Digits value={stopwatch(day.total)} />
					</span>
				</span>
			</p>
		</figure>
	);
}
