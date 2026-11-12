import { useState } from "react";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { TextField } from "~/components/TextField";
import { Section } from "~/shell/PageHeading";
import type { Day } from "~/time/calendar";

import { LEAVE_TEXT_MAX_LENGTH, type LeaveStatus } from "./kinds";
import { MOST_WORK_MINUTES_A_DAY, type WorkKind } from "./rules";

// Requests for overtime and weekend work on Time off (TS-090): the sheet's
// fields, the person's own requests, and the requests their approver decides.

/** One of the person's own requests, as Time off lists it. */
export interface MyWorkItem {
	id: string;
	kind: WorkKind;
	label: string;
	days: string;
	/** Hours a day: "2:00". */
	hours: string;
	status: LeaveStatus;
	statusLabel: string;
	reason: string | null;
	comment: string | null;
}

/** Somebody's request, as the Requests tab lists it for whoever decides it. */
export interface WorkItemToDecide {
	id: string;
	person: string;
	kind: WorkKind;
	label: string;
	days: string;
	hours: string;
	reason: string | null;
	cancellable: boolean;
}

/** What a button on a request asks the page to open, with what it acts on. */
export type WorkTask = "withdraw" | "approve" | "refuse" | "cancel";
export type WorkTarget = { id: string; name: string; work: true };

/** The fields of the sheet that asks for overtime or weekend work. */
export function WorkFields({ kind, today }: { kind: WorkKind; today: Day }) {
	const [startsOn, setStartsOn] = useState(today);
	const [endsOn, setEndsOn] = useState(today);
	return (
		<>
			<input type="hidden" name="kind" value={kind} />
			<div className="grid grid-cols-2 gap-4">
				<TextField
					label="First day"
					name="startsOn"
					type="date"
					value={startsOn}
					onChange={(value) => {
						setStartsOn(value);
						if (endsOn < value) setEndsOn(value);
					}}
					isRequired
				/>
				<TextField
					label="Last day"
					name="endsOn"
					type="date"
					value={endsOn}
					onChange={setEndsOn}
					isRequired
				/>
			</div>
			<TextField
				label="Hours a day"
				name="hours"
				inputMode="decimal"
				isRequired
				description={
					kind === "overtime"
						? `Beyond the day's expected hours, as 2 or 1:30, at most ${MOST_WORK_MINUTES_A_DAY / 60}. Counted on working days only.`
						: `As 4 or 3:30, at most ${MOST_WORK_MINUTES_A_DAY / 60}. Counted on days the working week does not work.`
				}
			/>
			<TextField
				label="Reason (optional)"
				name="reason"
				maxLength={LEAVE_TEXT_MAX_LENGTH}
				description="Your approver reads this with the request."
			/>
		</>
	);
}

/** The person's own requests for overtime and weekend work, with Withdraw on those waiting. */
export function MyWork({
	work,
	open,
}: {
	work: readonly MyWorkItem[];
	open: (task: WorkTask, on: WorkTarget) => void;
}) {
	return (
		<Section id="work" heading="Overtime and weekend work" className="max-w-200">
			{work.length === 0 ? (
				<p className="text-body-large text-on-surface-variant">
					You have not asked for overtime or weekend work. What you ask for is listed here.
				</p>
			) : (
				<Ledger heading="Requests" note={`${work.length}`}>
					<LedgerRows label="Your requests for overtime and weekend work">
						{work.map((w) => (
							<LedgerRow
								key={w.id}
								title={
									<>
										{w.label} <span className="text-on-surface-variant">· {w.statusLabel}</span>
									</>
								}
								detail={
									<>
										{w.days} · {w.hours} a day
										{w.reason && (
											<span className="block wrap-anywhere">Your reason: “{w.reason}”</span>
										)}
										{w.comment && <span className="block wrap-anywhere">“{w.comment}”</span>}
									</>
								}
								action={
									w.status === "pending" && (
										<Button
											variant="text"
											aria-label={`Withdraw ${w.label.toLowerCase()}, ${w.days}`}
											onPress={() =>
												open("withdraw", { id: w.id, name: w.label.toLowerCase(), work: true })
											}
										>
											Withdraw
										</Button>
									)
								}
							/>
						))}
					</LedgerRows>
				</Ledger>
			)}
		</Section>
	);
}

/**
 * The requests for overtime and weekend work an approver decides: those
 * waiting, with Approve and Refuse, and those approved that have not begun,
 * with Cancel for an owner or admin. Not shown while there are none.
 */
export function WorkToDecideSection({
	pending,
	upcoming,
	open,
}: {
	pending: readonly WorkItemToDecide[];
	upcoming: readonly WorkItemToDecide[];
	open: (task: WorkTask, on: WorkTarget) => void;
}) {
	if (pending.length === 0 && upcoming.length === 0) return null;
	const targetOf = (w: WorkItemToDecide): WorkTarget => ({
		id: w.id,
		name: `${w.person}'s ${w.label.toLowerCase()}`,
		work: true,
	});
	const detail = (w: WorkItemToDecide) => (
		<>
			{w.days} · {w.hours} a day
			{w.reason && <span className="block wrap-anywhere">“{w.reason}”</span>}
		</>
	);
	const title = (w: WorkItemToDecide) => (
		<span className="wrap-anywhere">
			{w.person} <span className="text-on-surface-variant">· {w.label}</span>
		</span>
	);
	return (
		<Section id="work-requests" heading="Overtime and weekend work" className="max-w-200">
			<div className="flex flex-col gap-6">
				{pending.length > 0 && (
					<Ledger heading="Waiting for you" note={`${pending.length}`}>
						<LedgerRows label="Overtime and weekend work waiting for you">
							{pending.map((w) => {
								const on = targetOf(w);
								return (
									<LedgerRow
										key={w.id}
										title={title(w)}
										detail={detail(w)}
										action={
											<span className="flex gap-1">
												<Button
													variant="text"
													aria-label={`Approve ${on.name}`}
													onPress={() => open("approve", on)}
												>
													Approve
												</Button>
												<Button
													variant="text"
													aria-label={`Refuse ${on.name}`}
													onPress={() => open("refuse", on)}
												>
													Refuse
												</Button>
											</span>
										}
									/>
								);
							})}
						</LedgerRows>
					</Ledger>
				)}
				{upcoming.length > 0 && (
					<Ledger heading="Approved, to come" note={`${upcoming.length}`}>
						<LedgerRows label="Approved overtime and weekend work to come">
							{upcoming.map((w) => {
								const on = targetOf(w);
								return (
									<LedgerRow
										key={w.id}
										title={title(w)}
										detail={detail(w)}
										action={
											w.cancellable && (
												<Button
													variant="text"
													aria-label={`Cancel ${on.name}`}
													onPress={() => open("cancel", on)}
												>
													Cancel
												</Button>
											)
										}
									/>
								);
							})}
						</LedgerRows>
					</Ledger>
				)}
			</div>
		</Section>
	);
}
