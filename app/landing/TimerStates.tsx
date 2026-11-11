import type { ReactNode } from "react";

import { Digits } from "~/components/Digits";
import { TimerMark } from "~/components/TimerMark";

import { clock, duration, length, RUNNING, stopwatch } from "./example-week";
import { useRunningDay } from "./RunningDay";

function State({ name, children }: { name: string; children: ReactNode }) {
	return (
		<li className="grid gap-x-6 gap-y-1 py-4 @md:grid-cols-12 @md:items-center">
			<span className="text-label-large text-on-surface-variant @md:col-span-2">{name}</span>
			<span className="flex items-center gap-4 @md:col-span-10">{children}</span>
		</li>
	);
}

/**
 * The three things a timer can be, in the order they happen: ready, running,
 * logged. The same entry is followed through all three, on the same clock as
 * the picture of the day; as the list is scrolled into view each state arrives
 * after the one before it (`timer-steps` in public.css).
 */
export function TimerStates() {
	const { day } = useRunningDay();
	const { entry } = RUNNING;

	return (
		<div className="@container">
			<ol className="timer-steps divide-y divide-outline-variant border-y-2 border-on-surface">
				<State name="Ready">
					<span className="min-w-0 flex-1 ps-3 text-body-large text-on-surface-variant">
						What are you working on?
					</span>
					<span className="text-title-large tabular-nums">0:00:00</span>
					<span className="pe-3">
						<TimerMark running={false} />
					</span>
				</State>
				<State name="Running">
					<span className="flex min-w-0 flex-1 items-center gap-4 rounded-small bg-primary-container px-3 py-2 text-on-primary-fixed">
						<span className="min-w-0 flex-1">
							<span className="block truncate text-body-large">{entry.note}</span>
							<span className="block text-body-medium text-on-primary-fixed-variant">
								{entry.project}
							</span>
						</span>
						<span className="text-title-large">
							<Digits value={stopwatch(day.elapsed)} />
						</span>
						<TimerMark running />
					</span>
				</State>
				<State name="Logged">
					<span className="min-w-0 flex-1 ps-3">
						<span className="block truncate text-body-large">{entry.note}</span>
						<span className="block text-body-medium text-on-surface-variant tabular-nums">
							{entry.project}, {clock(day.since)} to {clock(day.since + length(entry))}
						</span>
					</span>
					<span className="pe-3 text-title-large tabular-nums">{duration(length(entry))}</span>
				</State>
			</ol>
		</div>
	);
}
