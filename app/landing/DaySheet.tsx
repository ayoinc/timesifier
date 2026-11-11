import { Digits } from "~/components/Digits";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { TimerMark } from "~/components/TimerMark";

import { clock, duration, EXAMPLE_NOTE, length, RUNNING, stopwatch } from "./example-week";
import { useRunningDay } from "./RunningDay";

/**
 * A day as Timesifier keeps it: the timer that is running, the entries made so
 * far and the day's total. The server sends the still example. Once script has
 * the page, the timer runs on the visitor's own clock and its control stops and
 * starts it; without script the control is a drawing and the sheet stays still.
 */
export function DaySheet() {
	const { day, isRunning, status, toggle } = useRunningDay();

	return (
		<figure className="flex flex-col gap-3">
			<Ledger heading={`Today, ${day.date}`} note={EXAMPLE_NOTE} on="sheet">
				<div className="flex items-center gap-4 bg-primary-container px-4 py-4 text-on-primary-fixed @sm:px-5">
					<div className="min-w-0 flex-1">
						<p className="text-label-medium text-on-primary-fixed-variant tabular-nums">{status}</p>
						<p className="text-title-medium">{RUNNING.entry.note}</p>
						<p className="text-body-medium text-on-primary-fixed-variant">
							{RUNNING.entry.project}
						</p>
					</div>
					{/* A timer is not announced as it changes: its role says so. */}
					<p
						role="timer"
						aria-label="Time on the running entry"
						className="text-headline-medium @sm:text-display-small"
					>
						<Digits value={stopwatch(day.elapsed)} />
					</p>
					{toggle ? (
						<button
							type="button"
							onClick={toggle}
							aria-label={isRunning ? "Stop the timer" : "Start the timer"}
							className="relative shrink-0 cursor-pointer rounded-full outline-none before:absolute before:-inset-1 focus-visible:focus-indicator motion-safe:transition-transform motion-safe:duration-short2 motion-safe:ease-standard motion-safe:active:scale-95"
						>
							<TimerMark running={isRunning} tone="filled" size="large" />
						</button>
					) : (
						<TimerMark running tone="filled" size="large" />
					)}
				</div>

				<LedgerRows>
					{day.logged.map((entry) => (
						<LedgerRow
							key={entry.note}
							className="sheet-arrive"
							title={entry.note}
							detail={entry.project}
							value={duration(length(entry))}
							aside={`${clock(entry.start)}–${clock(entry.end)}`}
						/>
					))}
				</LedgerRows>

				<LedgerTotal
					className="sheet-arrive"
					label="Today so far"
					value={<Digits value={stopwatch(day.total)} />}
				/>
			</Ledger>
			<figcaption className="text-body-small text-on-sheet-variant">
				A day as Timesifier will keep it: one timer, the entries it made, and their total.
			</figcaption>
		</figure>
	);
}
