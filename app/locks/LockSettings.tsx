import { useState } from "react";

import { Button } from "~/components/Button";
import { Checkbox } from "~/components/Checkbox";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Radio, RadioGroup } from "~/components/Radio";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { FormSheet } from "~/routes/app/FormSheet";
import { Section } from "~/shell/PageHeading";
import { formatRange } from "~/time/format";
import { WEEKDAYS } from "~/workspace/general";

import { type Deadline, type DeadlineKind, LONGEST_AUTO_LOCK_DAYS } from "./deadline";
import { autoLockLabel, deadlineLabel, monthDayLabel } from "./words";

// Workspace settings, "Timesheet locking" (TS-065): the lock date, which binds
// everyone, owners included; the timesheet deadline; and auto-lock and
// auto-submit, which wait on the deadline. Only owners and admins are shown
// Workspace settings; the page's action asks again.

export interface LockSettingsData {
	lockedThrough: string | null;
	lockReason: string | null;
	deadline: Deadline;
	autoLockDays: number | null;
	autoSubmitAtLock: boolean;
	/** Today in the organisation's zone: the latest lock date that may be set. */
	today: string;
}

type Task = "lock" | "remove" | "deadline";

const KINDS: { id: DeadlineKind; label: string }[] = [
	{ id: "none", label: "No deadline" },
	{ id: "weekly", label: "Weekly" },
	{ id: "monthly", label: "Monthly" },
];

const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => ({
	id: `${index + 1}`,
	label: index === 30 ? "Last day of the month" : `The ${monthDayLabel(index + 1).slice(4)}`,
}));

export function LockSettings({
	data,
	onDone,
}: {
	data: LockSettingsData;
	onDone: (said: string) => void;
}) {
	const [task, setTask] = useState<Task | null>(null);
	const close = () => setTask(null);
	const { deadline } = data;
	const [kind, setKind] = useState<DeadlineKind>(deadline.kind);

	return (
		<>
			<Section
				id="timesheet-locking"
				heading="Timesheet locking"
				lead="A lock date closes past time for everyone, you included: nothing on or before it can be tracked, changed or deleted, and no leave asked for, until it is moved back."
				className="max-w-200"
			>
				<Ledger heading="Lock date">
					<LedgerRows label="Timesheet locking">
						<LedgerRow
							title={
								data.lockedThrough === null
									? "No lock date"
									: `Locked through ${formatRange(data.lockedThrough, data.lockedThrough)}`
							}
							detail={
								data.lockedThrough === null
									? "All past time can still change."
									: data.lockReason
										? `Reason: ${data.lockReason}`
										: "Set by auto-lock, or with no reason given."
							}
							action={
								<span className="flex flex-wrap gap-2">
									<Button
										variant="text"
										aria-label={
											data.lockedThrough === null ? "Set the lock date" : "Change the lock date"
										}
										onPress={() => setTask("lock")}
									>
										{data.lockedThrough === null ? "Set" : "Change"}
									</Button>
									{data.lockedThrough !== null && (
										<Button
											variant="text"
											aria-label="Remove the lock date"
											onPress={() => setTask("remove")}
										>
											Remove
										</Button>
									)}
								</span>
							}
						/>
						<LedgerRow
							title={deadlineLabel(deadline)}
							detail="Timesheet deadline, in the organisation's time zone."
							action={
								<Button
									variant="text"
									aria-label="Change the timesheet deadline"
									onPress={() => {
										setKind(deadline.kind);
										setTask("deadline");
									}}
								>
									Change
								</Button>
							}
						/>
						<LedgerRow
							title={`Auto-lock: ${deadline.kind === "none" ? "Off" : autoLockLabel(data.autoLockDays)}`}
							detail={
								deadline.kind === "none"
									? "Auto-lock waits on a deadline."
									: `After each deadline, the lock date moves up to the deadline's day. It never moves back. Auto-submit is ${data.autoSubmitAtLock ? "on" : "off"}.`
							}
						/>
					</LedgerRows>
				</Ledger>
			</Section>

			<FormSheet
				title={data.lockedThrough === null ? "Set the lock date" : "Change the lock date"}
				intent="lock-date"
				submitLabel="Lock"
				isOpen={task === "lock"}
				onClose={close}
				onDone={onDone}
			>
				<p>
					Nothing on or before this day can be tracked, changed or deleted by anyone, you included.
					Moving it back later needs a reason, which the activity log keeps.
				</p>
				<TextField
					label="Locked through"
					name="lockedThrough"
					type="date"
					defaultValue={data.lockedThrough ?? ""}
					isRequired
					validate={(typed) =>
						typed > data.today ? "The lock date can be today at the latest." : null
					}
				/>
				<TextField
					label="Reason"
					name="reason"
					autoComplete="off"
					maxLength={200}
					description="Needed when the date moves back. Shown to everyone the date stops."
				/>
				<Checkbox name="autoSubmit" value="on">
					Submit every unsubmitted week up to it, as the system
				</Checkbox>
			</FormSheet>

			<FormSheet
				title="Remove the lock date?"
				intent="remove-lock-date"
				submitLabel="Remove"
				isOpen={task === "remove"}
				onClose={close}
				onDone={onDone}
			>
				<p>Past time can change again, except weeks that are submitted or approved.</p>
				<TextField
					label="Reason"
					name="reason"
					autoComplete="off"
					maxLength={200}
					isRequired
					autoFocus
					description="Kept in the activity log."
				/>
			</FormSheet>

			<FormSheet
				title="Change the timesheet deadline"
				intent="deadline"
				submitLabel="Save"
				isOpen={task === "deadline"}
				onClose={close}
				onDone={onDone}
			>
				<RadioGroup
					label="Deadline"
					name="deadlineKind"
					value={kind}
					onChange={(value) => setKind(value as DeadlineKind)}
				>
					{KINDS.map(({ id, label }) => (
						<Radio key={id} value={id}>
							{label}
						</Radio>
					))}
				</RadioGroup>
				{kind === "weekly" && (
					<Select
						label="Day"
						name="weekday"
						options={[...WEEKDAYS]}
						defaultValue={deadline.kind === "weekly" ? `${deadline.weekday}` : "5"}
						isRequired
					/>
				)}
				{kind === "monthly" && (
					<Select
						label="Day of the month"
						name="monthDay"
						options={MONTH_DAYS}
						defaultValue={deadline.kind === "monthly" ? `${deadline.day}` : "31"}
						isRequired
					/>
				)}
				{kind !== "none" && (
					<>
						<TextField
							label="Time"
							name="time"
							type="time"
							defaultValue={deadline.kind === "none" ? "17:00" : deadline.time}
							isRequired
						/>
						<TextField
							label="Auto-lock after (days, optional)"
							name="autoLockDays"
							inputMode="numeric"
							autoComplete="off"
							maxLength={2}
							defaultValue={data.autoLockDays === null ? "" : `${data.autoLockDays}`}
							description={`Days after each deadline, 0 to ${LONGEST_AUTO_LOCK_DAYS}, when the lock date moves up to it. Empty is off.`}
						/>
						<Checkbox name="autoSubmitAtLock" value="on" defaultSelected={data.autoSubmitAtLock}>
							When auto-lock moves the date, submit every unsubmitted week up to it, as the system
						</Checkbox>
					</>
				)}
			</FormSheet>
		</>
	);
}
