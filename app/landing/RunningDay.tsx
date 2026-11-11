import { createContext, type ReactNode, use, useEffect, useState } from "react";

import { clock as clockTime } from "./example-week";
import {
	begin,
	type Clock,
	dayAt,
	EXAMPLE_DAY,
	EXAMPLE_WEEK,
	type RunningDay,
	timeOfDay,
	toggled,
	weekAt,
	type YearWeek,
} from "./running-day";

// Keeps the time for the home page. One clock: the picture of the day, the
// timer's three states and the day's sum all read it, so they agree to the second.

export interface Running {
	day: RunningDay;
	/** The week the day is in, and the year that week is in. */
	week: YearWeek;
	isRunning: boolean;
	/** What the timer is doing and since when, by the clock: "Running since 10:45". */
	status: string;
	/**
	 * Stops and starts the timer. Missing until script has taken the page over:
	 * before that, and without script, there is nothing to press.
	 */
	toggle?: () => void;
}

const STILL: Running = {
	day: EXAMPLE_DAY,
	week: EXAMPLE_WEEK,
	isRunning: true,
	status: `Running since ${clockTime(EXAMPLE_DAY.since)}`,
};

function statusOf(clock: Clock): string {
	if (clock.pausedAt !== null) return `Stopped at ${clockTime(timeOfDay(clock.pausedAt))}`;
	if (clock.resumedAt !== null) {
		return `Running again since ${clockTime(timeOfDay(clock.resumedAt))}`;
	}
	return `Running since ${clockTime(clock.placed.since)}`;
}

const RunningContext = createContext<Running>(STILL);

/** The day and its timer, as they stand this second. */
export function useRunningDay(): Running {
	return use(RunningContext);
}

/**
 * The server and the first render in the browser show the still example, so the
 * two are the same markup. Then the clock starts from the visitor's own time.
 */
export function RunningDayProvider({ children }: { children: ReactNode }) {
	const [clock, setClock] = useState<Clock | null>(null);
	const [now, setNow] = useState(0);

	useEffect(() => {
		const opened = Date.now();
		setNow(opened);
		setClock(begin(opened));
	}, []);

	useEffect(() => {
		if (!clock || clock.pausedAt !== null) return;
		// Wakes at the entry's next whole second: the digits change when a clock's
		// would, and a late timer never makes the time drift, because the time is
		// read again and not counted.
		const untilNextSecond = 1000 - ((now - clock.startedAt) % 1000);
		const timer = setTimeout(() => setNow(Date.now()), untilNextSecond);
		return () => clearTimeout(timer);
	}, [clock, now]);

	const running: Running = clock
		? {
				day: dayAt(clock, now),
				week: weekAt(clock, now),
				isRunning: clock.pausedAt === null,
				status: statusOf(clock),
				toggle: () => {
					const pressed = Date.now();
					setNow(pressed);
					setClock(toggled(clock, pressed));
				},
			}
		: STILL;

	return <RunningContext value={running}>{children}</RunningContext>;
}
