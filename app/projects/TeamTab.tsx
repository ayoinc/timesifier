import { useState } from "react";
import {
	Button as AriaButton,
	ComboBox,
	FieldError,
	Input,
	Label,
	ListBox,
	ListBoxItem,
	Popover,
	Text,
} from "react-aria-components";
import { Link } from "react-router";

import { ALLOCATION_UNITS, PROJECT_PARAM, UNIT_LABELS } from "~/allocations/allocations";
import type { ListedShare } from "~/allocations/allocations.server";
import { Button } from "~/components/Button";
import { cx } from "~/components/cx";
import {
	FIELD_CONTROL,
	FIELD_ERROR,
	fieldContainer,
	fieldIndicator,
	fieldLabel,
	fieldSupporting,
} from "~/components/field";
import { ArrowDropDownIcon } from "~/components/icons/ArrowDropDownIcon";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Menu, MenuItem, MenuTrigger } from "~/components/Menu";
import { POPOVER_MOTION } from "~/components/motion";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { rangeLabel } from "~/reports/format";
import { FormSheet } from "~/routes/app/FormSheet";
import { useOrganisation, useTerms } from "~/routes/app/useOrganisation";
import { TEXT_LINK } from "~/shell/links";
import { teamTabPath } from "~/teams/TeamTabs";
import type { Day } from "~/time/calendar";
import { formatDuration } from "~/time/format";
import { inTerms } from "~/workspace/work-model";

import { TEAM_ROLE_LABELS, TEAM_ROLES } from "./teams";
import type { TeamTab as TeamData, TeamStretch } from "./teams.server";

/** The Team tab's data: the team, and each person's time share (TS-116). */
type TabData = TeamData & {
	projectId: string;
	shares: ListedShare[];
	packages: { id: string; label: string }[];
};

/**
 * A project's team on its Team tab (TS-115c, decision 75): each stretch of a
 * person on it, with their role and its days, those running or still to come
 * first and the ended ones after. Those who manage the team (owners, admins,
 * the client's account managers and its delivery managers) assign people,
 * end a stretch, change its role from a day, or remove it, each in a sheet;
 * only owners, admins and account managers name a delivery manager or touch
 * a delivery manager's stretch. Anyone else who does not see the whole team
 * sees their own stretches alone.
 */
export function TeamTab({
	team,
	today,
	onSaid,
}: {
	team: TabData;
	/** The organisation's today: the first day an assignment is offered, and what has ended. */
	today: Day;
	onSaid: (said: string) => void;
}) {
	const terms = useTerms();
	const t = (text: string) => inTerms(text, terms);
	const [assigning, setAssigning] = useState(false);
	const [ending, setEnding] = useState<TeamStretch | null>(null);
	const [changing, setChanging] = useState<TeamStretch | null>(null);
	const [removing, setRemoving] = useState<TeamStretch | null>(null);
	const roles = TEAM_ROLES.filter((role) => role !== "delivery_manager" || team.namesLeads);

	return (
		<>
			<p className="max-w-160 text-body-large">
				{team.tracking === "assigned"
					? t(
							"Only the people on this project's team on a day track time to it on that day. Owners, admins and its delivery managers can add themselves.",
						)
					: t(
							"Everyone in the organisation tracks time to this project. Its team says who works on it, and who leads it.",
						)}
			</p>
			{!team.seesAll && (
				<p className="mt-2 max-w-160 text-body-medium text-on-surface-variant">
					{t("You see your own place on this project's team, not the rest of it.")}
				</p>
			)}
			{team.manages && (
				<div className="mt-6">
					<Button onPress={() => setAssigning(true)}>Assign someone</Button>
				</div>
			)}
			<div className="mt-6">
				<Ledger heading="Team" note={team.stretches.length}>
					{team.stretches.length === 0 ? (
						<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
							{team.seesAll
								? t("Nobody is on this project's team yet.")
								: t("You are not on this project's team.")}
						</p>
					) : (
						<LedgerRows label={t("The project's team")}>
							{team.stretches.map((stretch) => {
								const ended = stretch.endsOn !== null && stretch.endsOn < today;
								const days = daysText(stretch);
								return (
									<LedgerRow
										key={stretch.id}
										title={
											<span className="wrap-anywhere">
												{stretch.name}
												{ended ? " (ended)" : ""}
											</span>
										}
										detail={[
											TEAM_ROLE_LABELS[stretch.role],
											days,
											stretch.source === "import"
												? "From an import"
												: stretch.source === "contract"
													? "From a contract"
													: null,
										]
											.filter(Boolean)
											.join(" · ")}
										action={
											team.manages && (stretch.role !== "delivery_manager" || team.namesLeads) ? (
												<MenuTrigger>
													<Button
														variant="text"
														aria-label={`Actions for ${stretch.name}, ${days}`}
													>
														Actions
													</Button>
													<Menu
														align="end"
														onAction={(chosen) => {
															if (chosen === "end") setEnding(stretch);
															if (chosen === "role") setChanging(stretch);
															if (chosen === "remove") setRemoving(stretch);
														}}
													>
														<MenuItem id="end">End</MenuItem>
														{team.namesLeads ? <MenuItem id="role">Change role</MenuItem> : null}
														<MenuItem id="remove">Remove</MenuItem>
													</Menu>
												</MenuTrigger>
											) : undefined
										}
									/>
								);
							})}
						</LedgerRows>
					)}
				</Ledger>
			</div>
			<Shares team={team} today={today} onSaid={onSaid} />

			<FormSheet
				title="Assign someone"
				intent="team-assign"
				submitLabel="Assign"
				isOpen={assigning}
				onClose={() => setAssigning(false)}
				onDone={onSaid}
			>
				<p>{t("They are on this project's team from the first day to the last.")}</p>
				<PersonPicker people={team.people} />
				<Select
					label="Role"
					name="role"
					options={roles.map((role) => ({ id: role, label: TEAM_ROLE_LABELS[role] }))}
					defaultValue="member"
					isRequired
				/>
				<TextField label="First day" name="startsOn" type="date" defaultValue={today} isRequired />
				<TextField
					label="Last day"
					name="endsOn"
					type="date"
					description="Leave it empty while it runs on."
				/>
			</FormSheet>

			<FormSheet
				title={`End ${ending?.name ?? "this"}'s stretch`}
				intent="team-end"
				submitLabel="Save last day"
				isOpen={ending !== null}
				onClose={() => setEnding(null)}
				onDone={onSaid}
			>
				<input type="hidden" name="stretchId" value={ending?.id ?? ""} />
				<p>
					{ending ? stretchSentence(ending) : null}{" "}
					{t("They track no time to this project after their last day.")}
				</p>
				<TextField
					label="Last day"
					name="endsOn"
					type="date"
					defaultValue={ending?.endsOn ?? today}
					min={ending?.startsOn}
					description="Leave it empty and the stretch runs on."
				/>
			</FormSheet>

			<FormSheet
				title={`Change ${changing?.name ?? "their"}'s role`}
				intent="team-role"
				submitLabel="Change role"
				isOpen={changing !== null}
				onClose={() => setChanging(null)}
				onDone={onSaid}
			>
				<input type="hidden" name="stretchId" value={changing?.id ?? ""} />
				<p>
					{changing ? stretchSentence(changing) : null} The stretch ends the day before, and the new
					role runs from that day to its end.
				</p>
				<Select
					label="New role"
					name="role"
					options={roles.map((role) => ({ id: role, label: TEAM_ROLE_LABELS[role] }))}
					defaultValue={changing?.role === "member" ? "delivery_manager" : "member"}
					isRequired
				/>
				<TextField
					label="From"
					name="from"
					type="date"
					defaultValue={changing && changing.startsOn > today ? changing.startsOn : today}
					min={changing?.startsOn}
					isRequired
				/>
			</FormSheet>

			<FormSheet
				title={`Remove ${removing?.name ?? "this stretch"}?`}
				intent="team-remove"
				submitLabel="Remove"
				submitVariant="danger"
				isOpen={removing !== null}
				onClose={() => setRemoving(null)}
				onDone={onSaid}
			>
				<input type="hidden" name="stretchId" value={removing?.id ?? ""} />
				<p>
					{removing ? stretchSentence(removing) : null} For a stretch put there in error: it goes as
					if it had never been made. One in which they tracked time cannot go: end it instead.
				</p>
			</FormSheet>
		</>
	);
}

/**
 * Each person's time share of the project (TS-116, decision 78): so many days
 * or hours a week, or a part of their schedule, on the whole project or one of
 * its work packages, with what it plans this week. Those who manage the team
 * set a share, change it from a day, end it or remove it; anyone else who does
 * not see the whole team sees their own.
 */
function Shares({
	team,
	today,
	onSaid,
}: {
	team: TabData;
	today: Day;
	onSaid: (said: string) => void;
}) {
	const terms = useTerms();
	const t = (text: string) => inTerms(text, terms);
	const { slug } = useOrganisation();
	const [setting, setSetting] = useState(false);
	const [changing, setChanging] = useState<ListedShare | null>(null);
	const [ending, setEnding] = useState<ListedShare | null>(null);
	const [removing, setRemoving] = useState<ListedShare | null>(null);
	const units = ALLOCATION_UNITS.map((unit) => ({ id: unit, label: UNIT_LABELS[unit] }));
	const sentence = (share: ListedShare) =>
		`${share.name}: ${share.workPackage ?? t("the whole project")}, ${share.amount}, ${daysText(share).toLowerCase()}.`;

	return (
		<div className="mt-10">
			<p className="max-w-160 text-body-large">
				{t(
					"A time share plans part of a person's week on this project: days or hours a week, or a part of their schedule. Each week's plan follows their schedule, less leave and public holidays.",
				)}
			</p>
			<div className="mt-4 flex flex-wrap items-center gap-4">
				{team.manages && <Button onPress={() => setSetting(true)}>Set a time share</Button>}
				{team.manages && (
					<Link
						to={`${teamTabPath(slug, "allocation")}?${PROJECT_PARAM}=${encodeURIComponent(team.projectId)}`}
						className={TEXT_LINK}
					>
						Allocation by week
					</Link>
				)}
			</div>
			<div className="mt-6">
				<Ledger heading="Time share" note={team.shares.length}>
					{team.shares.length === 0 ? (
						<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
							{team.seesAll
								? t("Nobody has a time share of this project yet.")
								: t("You have no time share of this project.")}
						</p>
					) : (
						<LedgerRows label={t("Time shares of the project")}>
							{team.shares.map((share) => {
								const ended = share.endsOn !== null && share.endsOn < today;
								const days = daysText(share);
								return (
									<LedgerRow
										key={share.id}
										title={
											<span className="wrap-anywhere">
												{share.name}
												{ended ? " (ended)" : ""}
											</span>
										}
										detail={[
											share.workPackage ?? t("Whole project"),
											share.amount,
											days,
											ended ? null : `This week ${formatDuration(share.weekPlanned * 60)} planned`,
										]
											.filter(Boolean)
											.join(" · ")}
										action={
											team.manages ? (
												<MenuTrigger>
													<Button
														variant="text"
														aria-label={`Actions for ${share.name}'s time share, ${share.workPackage ?? t("whole project")}, ${days}`}
													>
														Actions
													</Button>
													<Menu
														align="end"
														onAction={(chosen) => {
															if (chosen === "change") setChanging(share);
															if (chosen === "end") setEnding(share);
															if (chosen === "remove") setRemoving(share);
														}}
													>
														<MenuItem id="change">Change from a day</MenuItem>
														<MenuItem id="end">End</MenuItem>
														<MenuItem id="remove">Remove</MenuItem>
													</Menu>
												</MenuTrigger>
											) : undefined
										}
									/>
								);
							})}
						</LedgerRows>
					)}
				</Ledger>
			</div>

			<FormSheet
				title="Set a time share"
				intent="share-set"
				submitLabel="Set time share"
				isOpen={setting}
				onClose={() => setSetting(false)}
				onDone={onSaid}
			>
				<p>
					{t(
						"From the first day to the last, this part of their week is planned on this project. A day is that day's length in their schedule.",
					)}
				</p>
				<PersonPicker people={team.people} />
				{team.packages.length > 0 && (
					<Select
						label="Work package"
						name="workPackageId"
						options={[{ id: "", label: t("Whole project") }, ...team.packages]}
						defaultValue=""
					/>
				)}
				<TextField
					label="Amount"
					name="amount"
					inputMode="decimal"
					description="Such as 2.5 days, 22:30 hours or 50%."
					isRequired
				/>
				<Select label="Unit" name="unit" options={units} defaultValue="days" isRequired />
				<TextField label="First day" name="startsOn" type="date" defaultValue={today} isRequired />
				<TextField
					label="Last day"
					name="endsOn"
					type="date"
					description="Leave it empty while it runs on."
				/>
			</FormSheet>

			<FormSheet
				title={`Change ${changing?.name ?? "their"}'s time share`}
				intent="share-change"
				submitLabel="Change time share"
				isOpen={changing !== null}
				onClose={() => setChanging(null)}
				onDone={onSaid}
			>
				<input type="hidden" name="shareId" value={changing?.id ?? ""} />
				<p>
					{changing ? sentence(changing) : null} The share ends the day before, and the new amount
					runs from that day to its end, so the weeks before keep their plan.
				</p>
				<TextField
					label="New amount"
					name="amount"
					inputMode="decimal"
					defaultValue={changing?.field}
					description="Such as 2.5 days, 22:30 hours or 50%."
					isRequired
				/>
				<Select
					label="Unit"
					name="unit"
					options={units}
					defaultValue={changing?.unit ?? "days"}
					isRequired
				/>
				<TextField
					label="From"
					name="from"
					type="date"
					defaultValue={changing && changing.startsOn > today ? changing.startsOn : today}
					min={changing?.startsOn}
					isRequired
				/>
			</FormSheet>

			<FormSheet
				title={`End ${ending?.name ?? "their"}'s time share`}
				intent="share-end"
				submitLabel="Save last day"
				isOpen={ending !== null}
				onClose={() => setEnding(null)}
				onDone={onSaid}
			>
				<input type="hidden" name="shareId" value={ending?.id ?? ""} />
				<p>{ending ? sentence(ending) : null}</p>
				<TextField
					label="Last day"
					name="endsOn"
					type="date"
					defaultValue={ending?.endsOn ?? today}
					min={ending?.startsOn}
					description="Leave it empty and the share runs on."
				/>
			</FormSheet>

			<FormSheet
				title={`Remove ${removing?.name ?? "this"}'s time share?`}
				intent="share-remove"
				submitLabel="Remove"
				submitVariant="danger"
				isOpen={removing !== null}
				onClose={() => setRemoving(null)}
				onDone={onSaid}
			>
				<input type="hidden" name="shareId" value={removing?.id ?? ""} />
				<p>
					{removing ? sentence(removing) : null} For a share set in error: every week it planned
					goes. To stop planning from a day, end it instead.
				</p>
			</FormSheet>
		</div>
	);
}

/** A stretch's days as its row says them: "From 2 November 2026", "2–30 November 2026". */
function daysText(stretch: Pick<TeamStretch, "startsOn" | "endsOn">): string {
	return stretch.endsOn === null
		? `From ${rangeLabel(stretch.startsOn, stretch.startsOn)}`
		: rangeLabel(stretch.startsOn, stretch.endsOn);
}

/** A stretch as a sheet's sentence says it: "Member from 2 November 2026.", "Member, 2–30 November 2026." */
function stretchSentence(stretch: TeamStretch): string {
	const role = TEAM_ROLE_LABELS[stretch.role];
	return stretch.endsOn === null
		? `${role} from ${rangeLabel(stretch.startsOn, stretch.startsOn)}.`
		: `${role}, ${rangeLabel(stretch.startsOn, stretch.endsOn)}.`;
}

/** What the person picker says when what is typed is no one's name. */
const NO_PERSON = "Nobody of that name";

/**
 * The person to assign, chosen by typing part of their name: the Material 3
 * filled field of ProjectPicker over React Aria's ComboBox. The form gets
 * the person's id from a hidden input, never the text typed; text that is no
 * one's name is refused before the form is sent.
 */
function PersonPicker({ people }: { people: TabData["people"] }) {
	const [chosen, setChosen] = useState<string | null>(null);
	return (
		<ComboBox
			defaultItems={people}
			selectedKey={chosen}
			onSelectionChange={(key) => setChosen(key === null ? null : `${key}`)}
			allowsEmptyCollection
			isRequired
			validate={({ selectedKey }) =>
				selectedKey === null ? "Choose someone from the list." : null
			}
			className="relative flex flex-col gap-1"
		>
			{({ isInvalid, isDisabled, isOpen, isRequired: required }) => {
				const field = { isInvalid, isDisabled, isActive: isOpen };
				return (
					<>
						<input type="hidden" name="userId" value={chosen ?? ""} />
						<div className={fieldContainer(field)}>
							{/* The one-space placeholder lets the label tell an empty input from a filled one. */}
							<Input
								placeholder=" "
								className={cx(
									FIELD_CONTROL,
									"ps-4 pe-12 pt-6 pb-2 text-body-large",
									isInvalid ? "caret-error" : "caret-primary",
								)}
							/>
							<Label
								className={cx(
									fieldLabel(field),
									"end-12",
									!isOpen &&
										"peer-placeholder-shown:group-not-has-data-focused/field:top-4 peer-placeholder-shown:group-not-has-data-focused/field:text-body-large",
								)}
							>
								Person
								{required && <span aria-hidden="true"> *</span>}
							</Label>
							<AriaButton className="absolute inset-y-0 end-0 flex w-12 cursor-pointer items-center justify-center pt-2 outline-none disabled:cursor-not-allowed">
								<ArrowDropDownIcon
									className={cx(
										"transition motion-reduce:transition-none",
										isOpen && "rotate-180",
										!isDisabled && (isInvalid ? "text-error" : "text-on-surface-variant"),
									)}
								/>
							</AriaButton>
							<span className={fieldIndicator(field)} />
						</div>
						{!isInvalid && (
							<Text slot="description" className={fieldSupporting(field)}>
								Type part of their name.
							</Text>
						)}
						<FieldError className={FIELD_ERROR} />
						<Popover
							placement="bottom start"
							offset={4}
							className={cx(
								POPOVER_MOTION,
								"w-(--trigger-width) overflow-auto rounded-large bg-surface-container-low shadow-level2 outline-none",
							)}
						>
							<ListBox<TabData["people"][number]>
								className="flex flex-col gap-0.5 p-1 outline-none"
								renderEmptyState={() => (
									<p className="flex min-h-12 items-center px-4 text-body-large text-on-surface-variant">
										{NO_PERSON}
									</p>
								)}
							>
								{(person) => (
									<ListBoxItem
										id={person.id}
										textValue={person.name}
										className={({ isSelected }) =>
											cx(
												"flex min-h-12 cursor-pointer select-none items-center px-4 py-1 text-label-large outline-none state-layer transition-control",
												"data-focused:state-hover data-focus-visible:state-focus data-focus-visible:focus-indicator-inner data-pressed:state-pressed",
												isSelected
													? "rounded-medium over-tertiary-container text-on-tertiary-container"
													: "rounded-extra-small text-on-surface",
											)
										}
									>
										<span className="truncate">{person.name}</span>
									</ListBoxItem>
								)}
							</ListBox>
						</Popover>
					</>
				);
			}}
		</ComboBox>
	);
}
