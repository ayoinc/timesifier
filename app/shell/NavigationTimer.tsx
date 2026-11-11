import { useEffect, useRef } from "react";
import { Link, useFetcher, useRouteLoaderData } from "react-router";

import { Button } from "~/components/Button";
import { cx } from "~/components/cx";
import { Digits } from "~/components/Digits";
import type { loader as organisationLoader } from "~/routes/app/organisation";
import { formatElapsed } from "~/timesheet/durations";
import { elapsedSeconds, useNow, useRefreshEvery30Seconds } from "~/timesheet/live";
import { dayPath, TIMER_ANCHOR, timerAction } from "~/timesheet/views";

import { accountPath } from "./destinations";
import { finishRunningTransition } from "./transitions";

/**
 * The timer's control (docs/navigation.md, "The navigation, top to bottom";
 * TS-051), on every page of an organisation. With nothing running it is
 * "Track time", the Timesheet's own name for it, a link to today's Day view
 * that opens its "Track time" sheet (TS-056); with an entry running it shows
 * the project, the time elapsed and "Stop", which stops it through the Day
 * view's own `stop` and leaves the person on the page they are on.
 *
 * From 600px it stands at the top of the column, before the first heading.
 * Under 600px (audit W11) it covers as little of the page as it can: with
 * nothing running it is a floating button at the bottom right, above the bar;
 * while a timer runs it is one strip just above the bar. On the Timesheet it
 * is not drawn under 600px at all, as the page has its own Track time and its
 * own running timer a few rows above.
 *
 * The elapsed time is the clock's now minus the stored start, as on the Day
 * view, so the two read the same to the second. What runs is read again when
 * the window gains focus and every 30 seconds, which refreshes the page under
 * it too.
 *
 * It also gives a person who has no zone of their own the one their browser
 * reports, once, the first time they open a page of an organisation (TS-012a).
 */
export function NavigationTimer({
	organisation,
	onTimesheet,
}: {
	organisation: string;
	/** Whether the page on screen is the Timesheet, which has its own control under 600px. */
	onTimesheet: boolean;
}) {
	const timer = useRouteLoaderData<typeof organisationLoader>("routes/app/organisation")?.timer;
	useRefreshEvery30Seconds();
	useDetectedTimeZone(organisation, timer?.hasTimeZone ?? true);
	const stop = useFetcher();
	const running = timer?.running ?? null;
	const now = useNow(running !== null, timer?.now ?? 0);
	// While the stop is on its way the control already reads as stopped.
	const stopping = stop.state !== "idle";

	return (
		<div className={cx("medium:mb-6 medium:ps-4", onTimesheet && "max-medium:hidden")}>
			{running && !stopping ? (
				<section
					aria-label="Timer"
					className={
						"flex min-w-0 flex-1 items-center gap-3 bg-surface " +
						"max-medium:fixed max-medium:inset-x-0 max-medium:bottom-16 max-medium:h-14 max-medium:border-t max-medium:border-outline-variant max-medium:px-4 " +
						"medium:flex-col medium:items-start medium:gap-1"
					}
				>
					<p className="min-w-0 flex-1 truncate text-label-medium text-on-surface-variant medium:w-full">
						<span className="sr-only">Running: </span>
						{running.projectName}
					</p>
					<p role="timer" aria-label="Elapsed" className="text-title-medium">
						<Digits value={formatElapsed(elapsedSeconds(running.startedAt, now))} />
					</p>
					<stop.Form method="post" action={timerAction(organisation)}>
						<input type="hidden" name="intent" value="stop" />
						<Button
							type="submit"
							variant="tonal"
							aria-label={`Stop timer for ${running.projectName}`}
						>
							Stop
						</Button>
					</stop.Form>
				</section>
			) : (
				<Link
					to={`${dayPath(organisation)}#${TIMER_ANCHOR}`}
					onClick={finishRunningTransition}
					className={
						"group flex items-center text-label-large outline-none " +
						"max-medium:fixed max-medium:end-4 max-medium:bottom-20 max-medium:h-14 max-medium:rounded-large max-medium:px-5 max-medium:bg-primary max-medium:text-on-primary max-medium:shadow-level3 max-medium:focus-visible:focus-indicator " +
						"medium:min-h-12"
					}
				>
					<span className="rounded-extra-small py-1 underline-offset-4 group-hover:underline medium:group-focus-visible:focus-indicator">
						Track time
					</span>
				</Link>
			)}
		</div>
	);
}

/** Sends the browser's zone once, while the person has none of their own. */
function useDetectedTimeZone(organisation: string, hasTimeZone: boolean) {
	const fetcher = useFetcher();
	const sent = useRef(false);
	const { submit } = fetcher;
	useEffect(() => {
		if (hasTimeZone || sent.current) return;
		sent.current = true;
		const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		submit(
			{ intent: "time-zone-detected", timeZone },
			{ method: "post", action: accountPath(organisation) },
		);
	}, [hasTimeZone, organisation, submit]);
}
