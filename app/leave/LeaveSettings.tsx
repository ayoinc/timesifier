import { useState } from "react";
import { Link } from "react-router";

import { Button } from "~/components/Button";
import { Checkbox } from "~/components/Checkbox";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { TextField } from "~/components/TextField";
import { FormSheet } from "~/routes/app/FormSheet";
import { ACTION_LINK } from "~/shell/links";
import { Section } from "~/shell/PageHeading";

import { halfDaysLabel, type KindKey, LEAVE_NAME_MAX_LENGTH } from "./kinds";
import { heldToNotice, LONGEST_NOTICE_DAYS, noticeLabel } from "./rules";
import { spanLabel } from "./words";

// Workspace settings for leave (TS-061): the default work schedule (TS-097,
// set on its own page), the kinds of leave, and the public holidays. Only owners
// and admins are shown Workspace settings; the page's action asks again.

export interface LeaveSettingsData {
	/** The organisation's default work schedule today (TS-097), and the address of the schedules page. */
	schedule: { name: string; weekLabel: string; path: string };
	kinds: {
		id: string;
		key: KindKey;
		name: string;
		enabled: boolean;
		needsApproval: boolean;
		allowanceHalfDays: number | null;
		/** Days of notice a request should give (TS-090); always 0 for sick leave and public holidays. */
		noticeDays: number;
	}[];
	holidays: { id: string; day: string; name: string }[];
}

type Task = "kind" | "add-holiday" | "remove-holiday";

/** The notice a kind asks for, as its row reads: "14 days' notice", "No notice", "Never needs notice". */
const noticeText = (kind: { key: KindKey; noticeDays: number }) => {
	if (!heldToNotice(kind)) return "Never needs notice";
	return kind.noticeDays > 0
		? noticeLabel({ noticeDays: kind.noticeDays, shortNotice: false })
		: "No notice";
};

export function LeaveSettings({
	data,
	onDone,
}: {
	data: LeaveSettingsData;
	onDone: (said: string) => void;
}) {
	const [task, setTask] = useState<Task | null>(null);
	const [kindId, setKindId] = useState<string | null>(null);
	const [holiday, setHoliday] = useState<{ id: string; name: string } | null>(null);
	const close = () => setTask(null);
	const kind = data.kinds.find((k) => k.id === kindId);

	return (
		<>
			<Section
				id="work-schedules"
				heading="Work schedules"
				lead="The hours people are expected to work: named schedules with a start, a finish and a break on each day worked, given to people, teams and roles. Leave and public holidays are taken from them."
				className="max-w-200"
			>
				<Ledger heading={data.schedule.name} note="Default">
					<LedgerRows label="The default schedule">
						<LedgerRow title="Everyone without another schedule" detail={data.schedule.weekLabel} />
					</LedgerRows>
				</Ledger>
				<div className="mt-4">
					<Link to={data.schedule.path} className={ACTION_LINK}>
						Work schedules
					</Link>
				</div>
			</Section>

			<Section
				id="leave-kinds"
				heading="Leave kinds"
				lead="The kinds of leave people ask for. Rename one, switch it off, set its yearly allowance, the notice it needs and whether it waits for a manager's approval."
				className="max-w-200"
			>
				<Ledger heading="Kinds">
					<LedgerRows label="Leave kinds">
						{data.kinds.map((k) => (
							<LedgerRow
								key={k.id}
								title={<span className="wrap-anywhere">{k.name}</span>}
								detail={
									k.key === "holiday"
										? `${k.enabled ? "On" : "Off"}. The public holidays below, for everyone.`
										: [
												k.enabled ? "On" : "Off",
												k.needsApproval ? "Needs approval" : "Needs no approval",
												k.allowanceHalfDays === null
													? "No allowance"
													: `${halfDaysLabel(k.allowanceHalfDays)} a year`,
												noticeText(k),
											].join(" · ")
								}
								action={
									<Button
										variant="text"
										aria-label={`Change ${k.name}`}
										onPress={() => {
											setKindId(k.id);
											setTask("kind");
										}}
									>
										Change
									</Button>
								}
							/>
						))}
					</LedgerRows>
				</Ledger>
			</Section>

			<Section
				id="public-holidays"
				heading="Public holidays"
				lead="Days off for everyone in the organisation. Nobody is expected to work on them, and they take nothing from anybody's allowance."
				className="max-w-200"
			>
				{data.holidays.length === 0 ? (
					<p className="text-body-large text-on-surface-variant">No public holidays are set.</p>
				) : (
					<Ledger heading="Public holidays" note={`${data.holidays.length}`}>
						<LedgerRows label="Public holidays">
							{data.holidays.map((h) => (
								<LedgerRow
									key={h.id}
									title={<span className="wrap-anywhere">{h.name}</span>}
									detail={spanLabel({
										startsOn: h.day,
										endsOn: h.day,
										startsHalf: false,
										endsHalf: false,
									})}
									action={
										<Button
											variant="text"
											aria-label={`Remove ${h.name}, ${h.day}`}
											onPress={() => {
												setHoliday({ id: h.id, name: h.name });
												setTask("remove-holiday");
											}}
										>
											Remove
										</Button>
									}
								/>
							))}
						</LedgerRows>
					</Ledger>
				)}
				<div className="mt-4">
					<Button variant="outlined" onPress={() => setTask("add-holiday")}>
						Add public holiday
					</Button>
				</div>
			</Section>

			<FormSheet
				title={`Change ${kind?.name ?? "this kind"}`}
				intent="kind"
				submitLabel="Save"
				isOpen={task === "kind"}
				onClose={close}
				onDone={onDone}
			>
				{kind && (
					<>
						<input type="hidden" name="kindId" value={kind.id} />
						<TextField
							label="Name"
							name="name"
							defaultValue={kind.name}
							autoComplete="off"
							isRequired
							maxLength={LEAVE_NAME_MAX_LENGTH}
						/>
						<Checkbox name="enabled" value="on" defaultSelected={kind.enabled}>
							Switched on
						</Checkbox>
						{kind.key !== "holiday" && (
							<>
								<Checkbox name="needsApproval" value="on" defaultSelected={kind.needsApproval}>
									Waits for a manager's approval
								</Checkbox>
								<TextField
									label="Days a year (optional)"
									name="allowanceDays"
									defaultValue={
										kind.allowanceHalfDays === null ? "" : `${kind.allowanceHalfDays / 2}`
									}
									inputMode="decimal"
									autoComplete="off"
									maxLength={5}
									description="In whole or half days, as 25 or 12.5. Empty is no allowance: nothing is counted against it."
								/>
								{heldToNotice(kind) ? (
									<TextField
										label="Notice (days)"
										name="noticeDays"
										defaultValue={kind.noticeDays > 0 ? `${kind.noticeDays}` : ""}
										inputMode="numeric"
										autoComplete="off"
										maxLength={3}
										description={`Whole days between asking and the first day off, at most ${LONGEST_NOTICE_DAYS}. Empty or 0 is none. Asking later needs a reason, or is refused, as Timesheet rules say.`}
									/>
								) : (
									<p>Never needs notice: people ask for it when they are ill.</p>
								)}
							</>
						)}
					</>
				)}
			</FormSheet>

			<FormSheet
				title="Add a public holiday"
				intent="add-holiday"
				submitLabel="Add"
				isOpen={task === "add-holiday"}
				onClose={close}
				onDone={onDone}
			>
				<TextField label="Day" name="day" type="date" isRequired />
				<TextField
					label="Name"
					name="name"
					defaultValue="Bank holiday"
					autoComplete="off"
					isRequired
					maxLength={LEAVE_NAME_MAX_LENGTH}
				/>
			</FormSheet>

			<FormSheet
				title={`Remove ${holiday?.name ?? "this public holiday"}?`}
				intent="remove-holiday"
				submitLabel="Remove"
				isOpen={task === "remove-holiday"}
				onClose={close}
				onDone={onDone}
			>
				<input type="hidden" name="holidayId" value={holiday?.id ?? ""} />
				<p>The day becomes a working day again for everyone.</p>
			</FormSheet>
		</>
	);
}
