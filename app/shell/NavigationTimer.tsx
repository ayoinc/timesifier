import { useEffect, useRef } from "react";
import { Button as AriaButton } from "react-aria-components";
import { useFetcher, useRouteLoaderData } from "react-router";

import { Button } from "~/components/Button";
import { cx } from "~/components/cx";
import { Digits } from "~/components/Digits";
import type { Outcome } from "~/organisations/problems";
import type { loader as organisationLoader } from "~/routes/app/organisation";
import { formatElapsed } from "~/timesheet/durations";
import { useReportAnswer } from "~/timesheet/feedback";
import { elapsedSeconds, useNow, useRefreshEvery30Seconds } from "~/timesheet/live";
import { useTrackTime } from "~/timesheet/TrackTime";
import { timerAction } from "~/timesheet/views";

import { accountPath } from "./destinations";

/**
 * The timer's control (docs/navigation.md, "The navigation, top to bottom";
 * TS-051), on every page of an organisation. With nothing running it is
 * "Track time", the Timesheet's own name for it, which opens the Track time
 * sheet over the page the person is on, at today (taste HT-C, audit W01); the
 * address does not change and closing the sheet gives the focus back here.
 * With an entry running it shows the project, the time elapsed and "Stop",
 * which stops it through the Day view's own `stop` and leaves the person on
 * the page they are on. Running, it is amber, the one thing on the page that
 * is (docs/design-direction.md, "where it is allowed", 2).
 *
 * From 600px it stands at the top of the column, before the first heading.
 * Under 600px (audit W11) it covers as little of the page as it can: with
 * nothing running it is a floating button at the bottom right, above the bar;
 * while a timer runs it is one strip just above the bar. On the Timesheet it
 * is not drawn under 600px at all, as the page has its own Track time and its
 * own running timer a few rows above; from 600px there it shows a running
 * timer alone, as the page's Track time is the one way to track (one action
 * in one place).
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
	const stop = useFetcher<Outcome>();
	useReportAnswer(stop.state === "idle" ? stop.data : undefined);
	const openTrackTime = useTrackTime();
	const running = timer?.running ?? null;
	const now = useNow(running !== null, timer?.now ?? 0);
	// While the stop is on its way the control already reads as stopped.
	const stopping = stop.state !== "idle";

	if (onTimesheet && !(running && !stopping)) return null;
	return (
		<div className={cx("medium:mb-6 medium:ps-4", onTimesheet && "max-medium:hidden")}>
			{running && !stopping ? (
				<section
					aria-label="Timer"
					className={
						"flex min-w-0 flex-1 items-center gap-3 bg-primary-container text-on-primary-fixed " +
						"max-medium:fixed max-medium:inset-x-0 max-medium:bottom-16 max-medium:h-14 max-medium:px-4 " +
						"medium:flex-col medium:items-start medium:gap-1 medium:rounded-large medium:p-3"
					}
				>
					<p className="min-w-0 flex-1 truncate text-label-medium medium:w-full">
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
				<AriaButton
					onPress={() => openTrackTime()}
					className={
						"group flex cursor-pointer items-center text-label-large outline-none " +
						"max-medium:fixed max-medium:end-4 max-medium:bottom-20 max-medium:h-14 max-medium:rounded-large max-medium:px-5 max-medium:bg-primary max-medium:text-on-primary max-medium:shadow-level3 max-medium:data-focus-visible:focus-indicator " +
						"medium:min-h-12"
					}
				>
					<span className="rounded-extra-small py-1 hover-underline transition-link group-data-hovered:decoration-current medium:group-data-focus-visible:focus-indicator">
						Track time
					</span>
				</AriaButton>
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
