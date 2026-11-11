import { type ReactNode, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

import { Button, type ButtonVariant } from "~/components/Button";
import { Dialog } from "~/components/Dialog";
import type { Outcome } from "~/organisations/problems";

import type { PeriodSubmission } from "./timesheet.server";

/**
 * A period's one submission action, at the foot of the Week view and of the
 * Day view (TS-046, TS-056): "Submit week", with a confirmation, or "Withdraw
 * submission" while nobody has decided it. `heading` is what stands above it:
 * the Day view says there which period this is and where it stands. "Submit
 * week" is filled where it is the view's primary action, and steps down where
 * the view has another.
 */
export function Submission({
	submission,
	onSaid,
	heading,
	variant = "filled",
}: {
	submission: PeriodSubmission;
	onSaid: (said: string) => void;
	heading?: ReactNode;
	variant?: ButtonVariant;
}) {
	const fetcher = useFetcher<Outcome>();
	const [confirming, setConfirming] = useState(false);
	const answer = fetcher.state === "idle" ? fetcher.data : undefined;
	const handled = useRef<Outcome | undefined>(undefined);
	useEffect(() => {
		if (!answer || handled.current === answer) return;
		handled.current = answer;
		if (answer.ok) onSaid(answer.said);
	}, [answer, onSaid]);
	const { status, period, runsInWeek, started } = submission;
	const submittable = status === null || status === "withdrawn" || status === "returned";
	const send = (intent: "submit" | "withdraw") =>
		fetcher.submit({ intent, startsOn: period.startsOn }, { method: "post" });

	let note: string | null = null;
	if (submittable && !started) note = "This week can be submitted once it has begun.";
	else if (submittable && runsInWeek) note = "Stop the timer before you submit the week.";
	else if (status === "submitted") note = "Submitted. Its entries are locked until it is decided.";
	else if (status === "approved") note = "Approved. Its entries are locked.";

	return (
		<div className="mt-10 flex flex-col items-start gap-3 border-t-2 border-on-surface pt-6">
			{heading}
			{note && <p className="text-body-large text-on-surface-variant">{note}</p>}
			{submittable && started && !runsInWeek && (
				<Button variant={variant} onPress={() => setConfirming(true)}>
					Submit week
				</Button>
			)}
			{status === "submitted" && (
				<Button variant="outlined" onPress={() => send("withdraw")}>
					Withdraw submission
				</Button>
			)}
			<p role="alert" className="text-body-medium text-error empty:hidden">
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
