import { useEffect, useRef } from "react";
import { Button as AriaButton } from "react-aria-components";
import { Link, useFetcher } from "react-router";

import { Button } from "~/components/Button";
import { cx } from "~/components/cx";
import { CheckIcon } from "~/components/icons/CheckIcon";
import type { Outcome } from "~/organisations/problems";
import { destinationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";

import { useTrackTime } from "./TrackTime";
import { weekPath } from "./views";

/** The steps of getting started on Timesheet, and whether each is done (TS-056). */
export interface GettingStarted {
	/** The organisation has an active project. */
	project: boolean;
	/** The person has an entry in this organisation, by the timer or by hand. */
	entry: boolean;
	/** The person has opened the Week view. */
	week: boolean;
}

const STEPS = ["project", "entry", "week"] as const satisfies readonly (keyof GettingStarted)[];

const LABELS: Record<keyof GettingStarted, string> = {
	project: "Add a project",
	entry: "Track an entry",
	week: "Open the week",
};

/** The fetcher of "Put away": the list and the view it stands in read the same one. */
const PUT_AWAY = "getting-started-put-away";

/**
 * What "Put away" did, for the view that holds the list. The list is gone by
 * the time the answer is read, with the button that had the focus: the view
 * says what happened, and the focus goes to the page's heading.
 */
export function usePutAwayAnswer(onSaid: (said: string) => void) {
	const fetcher = useFetcher<Outcome>({ key: PUT_AWAY });
	const answer = fetcher.state === "idle" ? fetcher.data : undefined;
	const handled = useRef<Outcome | undefined>(undefined);
	useEffect(() => {
		if (!answer || handled.current === answer) return;
		handled.current = answer;
		if (!answer.ok) return;
		onSaid(answer.said);
		if (document.activeElement === document.body) {
			document.querySelector<HTMLElement>("main h1")?.focus();
		}
	}, [answer, onSaid]);
}

/**
 * Getting started, at the top of the Day view while a step is left (TS-056):
 * each step a link to where it is done, ticked once the server finds it done,
 * how many are done, and "Put away", which hides the list for this person.
 */
export function GettingStartedList({ steps, slug }: { steps: GettingStarted; slug: string }) {
	const fetcher = useFetcher<Outcome>({ key: PUT_AWAY });
	const answer = fetcher.state === "idle" ? fetcher.data : undefined;

	const openTrackTime = useTrackTime();
	// Tracking an entry is done here: the step opens the Track time sheet (taste HT-C).
	const targets: Record<Exclude<keyof GettingStarted, "entry">, string> = {
		project: destinationPath(slug, "projects"),
		week: weekPath(slug),
	};
	const doneCount = STEPS.filter((step) => steps[step]).length;

	return (
		<section
			aria-labelledby="getting-started-heading"
			className="mt-6 max-w-200 rounded-large border border-outline-variant p-4"
		>
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<h2 id="getting-started-heading" className="text-title-medium">
					Getting started
				</h2>
				<p className="text-label-large text-on-surface-variant">
					{doneCount} of {STEPS.length}
				</p>
			</div>
			<ol className="mt-3 flex flex-col gap-2">
				{STEPS.map((step) => (
					<li key={step} className="flex min-h-10 items-center gap-3">
						<span
							aria-hidden="true"
							className={cx(
								"grid size-6 shrink-0 place-items-center rounded-full",
								steps[step]
									? "bg-primary text-on-primary"
									: "border-2 border-outline text-on-surface-variant",
							)}
						>
							{steps[step] && <CheckIcon size="small" />}
						</span>
						{steps[step] ? (
							<span className="text-body-large text-on-surface-variant">
								{LABELS[step]}
								<span className="sr-only"> (done)</span>
							</span>
						) : step === "entry" ? (
							<AriaButton
								onPress={() => openTrackTime()}
								className={cx(TEXT_LINK, "cursor-pointer text-start")}
							>
								{LABELS[step]}
							</AriaButton>
						) : (
							<Link to={targets[step]} className={TEXT_LINK}>
								{LABELS[step]}
							</Link>
						)}
					</li>
				))}
			</ol>
			<fetcher.Form method="post" className="mt-2">
				<input type="hidden" name="intent" value="put-away" />
				<Button type="submit" variant="text" aria-label="Put away getting started">
					Put away
				</Button>
			</fetcher.Form>
			<p role="alert" className="text-body-medium text-error empty:hidden">
				{answer && !answer.ok ? answer.problem : null}
			</p>
		</section>
	);
}
