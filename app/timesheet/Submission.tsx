import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useFetcher } from "react-router";

import { PART_STATUS_LABELS } from "~/approvals/parts";
import { Button } from "~/components/Button";
import { Dialog } from "~/components/Dialog";
import { MORE_THAN_A_DAY, overLabel } from "~/leave/rules";
import type { Outcome } from "~/organisations/problems";
import { formatDay } from "~/time/format";

import { PERIOD_STATE_LABELS } from "./sheets";
import type { PeriodSubmission } from "./timesheet.server";

/**
 * The period's header row, the same on the Day, Week and Calendar views
 * (TS-046, TS-056, audit W29): the period's name and where it stands on the
 * left, and its one submission action at the right end, "Submit week" with a
 * confirmation, or "Withdraw submission" while nobody has decided it. "Submit
 * week" is tonal in every view, so that each view keeps one filled primary of
 * its own (the Day view's is Track time). While a day of the week is over its
 * limit it stays disabled, and the days to correct are named (TS-090).
 *
 * `submission` is null where the view shows no one period: the month
 * calendar. `aside` stands beside the status (a total), `tools` before the
 * action (the calendar's zoom).
 */
export function PeriodHeader({
	title,
	submission,
	aside,
	tools,
	onSaid,
}: {
	/** The period's name, or the month's, written by app/time/format.ts: `9–15 November 2026`. */
	title: string;
	submission: PeriodSubmission | null;
	aside?: ReactNode;
	tools?: ReactNode;
	onSaid: (said: string) => void;
}) {
	const fetcher = useFetcher<Outcome>();
	const [confirming, setConfirming] = useState(false);
	const answer = fetcher.state === "idle" ? fetcher.data : undefined;
	const sending = fetcher.state === "idle" ? null : fetcher.formData?.get("intent");
	const handled = useRef<Outcome | undefined>(undefined);
	const noteId = useId();
	useEffect(() => {
		if (!answer || handled.current === answer) return;
		handled.current = answer;
		if (answer.ok) onSaid(answer.said);
	}, [answer, onSaid]);

	const status = submission?.status ?? null;
	const submittable =
		submission !== null && (status === null || status === "withdrawn" || status === "returned");
	// A returned week the lock date has reached is held by it: nothing can be done here (TR-07).
	const held = submission?.heldByLock === true;
	const offered = submittable && submission.started && !submission.runsInWeek && !held;
	const over = submission?.over ?? [];
	const send = (intent: "submit" | "withdraw") =>
		submission &&
		fetcher.submit({ intent, startsOn: submission.period.startsOn }, { method: "post" });

	const notes: string[] = [];
	if (submittable && !held && !submission.started)
		notes.push("This week can be submitted once it has begun.");
	else if (submittable && !held && submission.runsInWeek)
		notes.push("Stop the timer before you submit the week.");
	if (submittable && !held && over.length > 0) {
		const days = new Intl.ListFormat("en-GB", { type: "conjunction" }).format(
			over.map(
				(d) =>
					`${formatDay(d.day, "short")} (${overLabel(d.overMinutes, d.moreThanADay).toLowerCase()})`,
			),
		);
		notes.push(`Correct ${days} before you submit.`);
		if (over.some((d) => d.moreThanADay)) notes.push(MORE_THAN_A_DAY);
	}
	const parts = submission?.parts ?? null;
	// A week held in parts (TS-117) is withdrawn only while no part of it is approved.
	const withdrawable = status === "submitted" && !parts?.some((p) => p.status === "approved");
	if (status === "submitted") {
		notes.push(
			parts
				? "Submitted in parts, each approved by its own approver. Each part's entries are locked until it is decided."
				: "Submitted. Its entries are locked until it is decided.",
		);
	} else if (status === "approved") notes.push("Approved. Its entries are locked.");

	return (
		<div>
			<div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
				<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
					<h2 className="text-title-large">{title}</h2>
					{submission && (
						<p className="text-label-large text-on-surface-variant">
							<span className="sr-only">Status: </span>
							{PERIOD_STATE_LABELS[submission.state]}
						</p>
					)}
					{aside}
				</div>
				{(tools || offered || withdrawable) && (
					<div className="flex flex-wrap items-center gap-4">
						{tools}
						{offered && (
							<Button
								variant="tonal"
								isDisabled={over.length > 0}
								isPending={sending === "submit"}
								aria-describedby={notes.length > 0 ? noteId : undefined}
								onPress={() => setConfirming(true)}
							>
								Submit week
							</Button>
						)}
						{withdrawable && (
							<Button
								variant="outlined"
								isPending={sending === "withdraw"}
								onPress={() => send("withdraw")}
							>
								Withdraw submission
							</Button>
						)}
					</div>
				)}
			</div>
			{submission?.state === "returned" && (
				<p className="mt-2 max-w-160 text-body-large">
					{parts
						? "Part of it was returned."
						: `Returned${submission.comment ? `: ${submission.comment}` : "."}`}{" "}
					{held
						? "The lock date holds this week, so it cannot be changed or submitted until an owner or admin moves the date back."
						: parts
							? "Correct what was returned and submit the week again. The parts approved or still waiting stay locked."
							: "Correct the week and submit it again."}
				</p>
			)}
			{parts && (
				<ul aria-label="Parts of this week" className="mt-2 max-w-160 text-body-medium">
					{parts.map((part) => (
						<li key={part.project ?? ""} className="wrap-anywhere">
							{part.project === null ? "The rest of the week" : `Time on ${part.project}`}:{" "}
							{PART_STATUS_LABELS[part.status]}
							{part.comment ? `, “${part.comment}”` : ""}
						</li>
					))}
				</ul>
			)}
			{notes.length > 0 && (
				<p id={noteId} className="mt-2 max-w-160 text-body-medium text-on-surface-variant">
					{notes.join(" ")}
				</p>
			)}
			<p role="alert" className="mt-2 text-body-medium text-error empty:hidden">
				{answer && !answer.ok ? answer.problem : null}
			</p>
			<Dialog
				title="Submit this week?"
				isOpen={confirming}
				onOpenChange={setConfirming}
				actions={
					<>
						<Button variant="text" slot="close">
							Cancel
						</Button>
						<Button
							onPress={() => {
								setConfirming(false);
								send("submit");
							}}
						>
							Submit week
						</Button>
					</>
				}
			>
				Its entries are locked until it is approved or returned. You can withdraw it until then.
			</Dialog>
		</div>
	);
}
