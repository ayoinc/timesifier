import { useEffect, useRef } from "react";
import { Link, useFetcher, useRouteLoaderData } from "react-router";

import { Button } from "~/components/Button";
import { Digits } from "~/components/Digits";
import type { loader as organisationLoader } from "~/routes/app/organisation";
import { formatElapsed } from "~/timesheet/durations";
import { elapsedSeconds, useNow, useRefreshEvery30Seconds } from "~/timesheet/live";
import { dayPath, TIMER_ANCHOR, timerAction } from "~/timesheet/views";

import { accountPath } from "./destinations";
import { finishRunningTransition } from "./transitions";

/**
 * The timer's control at the top of the navigation, before its first heading
 * (docs/navigation.md, "The navigation, top to bottom"; TS-051), on every page
 * of an organisation. With nothing running it is "Start timer", a link to
 * today's Day view that opens its "Track time" sheet (TS-056); with an entry
 * running it shows the project, the time
 * elapsed and "Stop", which stops it through the Day view's own `stop` and
 * leaves the person on the page they are on.
 *
 * The elapsed time is the clock's now minus the stored start, as on the Day
 * view, so the two read the same to the second. What runs is read again when
 * the window gains focus and every 30 seconds, which refreshes the page under
 * it too. From 600px it stands at the top of the column; under it, in a strip
 * just above the bar.
 *
 * It also gives a person who has no zone of their own the one their browser
 * reports, once, the first time they open a page of an organisation (TS-012a).
 */
export function NavigationTimer({ organisation }: { organisation: string }) {
	const timer = useRouteLoaderData<typeof organisationLoader>("routes/app/organisation")?.timer;
	useRefreshEvery30Seconds();
	useDetectedTimeZone(organisation, timer?.hasTimeZone ?? true);
	const stop = useFetcher();
	const running = timer?.running ?? null;
	const now = useNow(running !== null, timer?.now ?? 0);
	// While the stop is on its way the control already reads as stopped.
	const stopping = stop.state !== "idle";

	return (
		<div
			className={
				"bg-surface " +
				"max-medium:fixed max-medium:inset-x-0 max-medium:bottom-16 max-medium:flex max-medium:h-12 max-medium:items-center max-medium:border-t max-medium:border-outline-variant max-medium:px-4 " +
				"medium:mb-6 medium:ps-4"
			}
		>
			{running && !stopping ? (
				<section
					aria-label="Timer"
					className="flex min-w-0 flex-1 items-center gap-3 medium:flex-col medium:items-start medium:gap-1"
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
					className="group flex min-h-12 items-center text-label-large outline-none"
				>
					<span className="rounded-extra-small py-1 underline-offset-4 group-hover:underline group-focus-visible:focus-indicator">
						Start timer
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
