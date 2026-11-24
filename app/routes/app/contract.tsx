import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { useEffect, useRef, useState } from "react";
import { Link, type ShouldRevalidateFunctionArgs, useFetcher } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Radio, RadioGroup } from "~/components/Radio";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import {
	CHOSEN_END_REASONS,
	END_REASON_LABELS,
	EndReason,
	JOB_TITLE_MAX_LENGTH,
	KIND_LABELS,
	MULTIPLIER_LABELS,
	MULTIPLIERS,
	OFFERED_KINDS,
	OVERTIME_PAY_LABELS,
	OVERTIME_PAYS,
	type OvertimePay,
	PAY_BASES,
	PAY_BASIS_LABELS,
	PRIOR_DAYS,
	PRIOR_DAYS_LABELS,
	type PriorDays,
	priorDaysQuestion,
	WORKS_NUMBER_MAX_LENGTH,
} from "~/contracts/contracts";
import {
	type ContractChange,
	changeContract,
	endContract,
	giveContract,
	otherAdministrators,
	previewedContracts,
} from "~/contracts/contracts.server";
import { ContractFields } from "~/contracts/forms";
import { contractsOf, joinedOnOf } from "~/contracts/read.server";
import { type ContractDefaults, contractsView, defaultsOf } from "~/contracts/view";
import { type OrganisationScope, organisationScope, users } from "~/db";
import {
	ADJUSTMENT_REASON_MAX_LENGTH,
	BELOW_STATUTORY,
	belowStatutoryFloor,
	contractBalance,
	contractBalanceWords,
	holidayMinutesOn,
	LONGEST_ADJUSTMENT_MINUTES,
	leaveAmount,
	minutesFrom,
	USUAL_SETTINGS,
} from "~/leave/entitlement";
import { addAdjustment, adjustmentsOf } from "~/leave/entitlement.server";
import { annualLeaveOf, annualLeftWords } from "~/leave/leave.server";
import { leaveYear, leaveYearLabel, leaveYearOf } from "~/leave/years";
import { parseRequest } from "~/lib/validate";
import { mayChangeContractOf, maySeeContractOf, maySeePayOf } from "~/organisations/access";
import { accessOf } from "~/organisations/access.server";
import { membershipContext, notFound, viewerOf } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { shownName } from "~/organisations/people";
import { NOT_ALLOWED, type Outcome } from "~/organisations/problems";
import { organisationMoney } from "~/projects/money.server";
import { type ScheduleWeek, versionOn } from "~/schedules/schedules";
import { scheduleBookOf } from "~/schedules/schedules.server";
import { CONTRACT_PERSON_PARAM, canSee, destinationPath } from "~/shell/destinations";
import { ACTION_LINK } from "~/shell/links";
import { EmptySheet, PageHeading, PageLead } from "~/shell/PageHeading";
import { type PersonTab, PersonTabs } from "~/teams/PersonTabs";
import { peopleOf } from "~/teams/people.server";
import { addDays, Day, dayOf } from "~/time/calendar";
import { formatDayWithYear } from "~/time/format";
import { zoneOfMember } from "~/time/zones.server";

import type { Route } from "./+types/contract";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

/** What the adjustment sheet's answer says to an adjustment of a year no contract gives. */
const ADJUST_NEEDS_CONTRACT =
	"Only annual leave a contract gives is adjusted here: give that leave year a contract with its own days of annual leave first.";

// One person's contracts, a page of Team beside their Week (TS-098a,
// research/contracts-model.md sections 6 and 7). Owners, admins and Finance
// read anybody's, a manager the people of their teams, and a person their own;
// anybody else gets the organisation's 404, as if there were nobody. What a
// viewer may not read (pay, multipliers, the works number) is left out on the
// server. Owners and admins give, change and end contracts in sheets, never
// their own while another owner or admin could.

const TITLE = "Contract";

/** The Give sheet's preview reads; it changes nothing the page shows. */
export function shouldRevalidate({
	formData,
	defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
	if (formData?.get("intent") === "preview") return false;
	return defaultShouldRevalidate;
}

export function meta({ loaderData }: Route.MetaArgs) {
	return [{ title: `${loaderData?.person.name ?? TITLE} · ${TITLE} · Timesifier` }];
}

/** The person whose contracts the address names, a member or somebody who left with a contract here; null for anybody else. */
async function personOf(
	scope: OrganisationScope,
	organisation: { timeZone: string },
	personId: string,
	hasContracts: boolean,
) {
	const [member] = await peopleOf(scope, organisation, [personId]);
	if (member) return { id: member.id, name: member.name, isMember: true };
	if (!hasContracts) return null;
	// A leaver's contracts are kept (contracts-model.md section 6), and so is who they were.
	const [user] = await drizzle(env.DB)
		.select({ name: users.name, email: users.email })
		.from(users)
		.where(eq(users.id, personId))
		.limit(1);
	return { id: personId, name: user ? shownName(user) : "A former member", isMember: false };
}

export async function loader({ params, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const { organisation } = membership;
	const personId = params[CONTRACT_PERSON_PARAM];
	const access = await accessOf(membership);
	// Somebody this person may not read the contracts of is as absent as somebody who does not exist.
	if (!maySeeContractOf(access, personId)) throw notFound();
	const scope = organisationScope(env.DB, organisation.id);
	const [contracts, book, zone, others, money, annualLeave] = await Promise.all([
		contractsOf(scope, [personId]),
		scheduleBookOf(scope),
		zoneOfMember(membership),
		otherAdministrators(scope, personId),
		organisationMoney(organisation.id),
		annualLeaveOf(scope, personId),
	]);
	const theirs = contracts.get(personId) ?? [];
	const person = await personOf(scope, organisation, personId, theirs.length > 0);
	if (!person) throw notFound();
	const today = dayOf(Date.now(), zone);
	const seesPay = maySeePayOf(access, personId);
	const canChange = mayChangeContractOf(access, personId, others);
	const settings = annualLeave?.settings ?? USUAL_SETTINGS;
	const {
		current,
		others: earlier,
		currentContract,
	} = contractsView(theirs, book, today, seesPay, settings.holidaysFromAllowance);
	// Their annual leave this leave year, where a contract gives it (TS-098b); a leaver's went with their membership.
	const year = leaveYearOf(settings.leaveYearStarts, today);
	const counted = annualLeave && person.isMember ? contractBalance(annualLeave.leave, year) : null;
	const adjustments =
		annualLeave && counted ? await adjustmentsOf(scope, personId, annualLeave.annual.id) : [];
	// The public holidays of this leave year and each schedule's week, for the sheets' statutory warning.
	const thisYear = leaveYear(settings.leaveYearStarts, year);
	const ownWeek = annualLeave?.leave.calendar.timetable(today).week ?? [];
	const seesTeam = canSee(viewerOf(membership), "team");
	const tabs: PersonTab[] = seesTeam && person.isMember ? ["week", "contract"] : ["contract"];
	// The contract a sheet changes or ends: the one that covers today, or the next to begin, while it is not ended.
	const open = currentContract && currentContract.endReason === null ? currentContract : null;
	const last = theirs.at(-1);
	// The day they joined: the Give sheet asks how the days before a first contract count of someone who joined before it.
	const joinedOn = canChange && person.isMember ? await joinedOnOf(scope, personId) : null;
	return {
		person: { id: person.id, name: person.name, isMember: person.isMember },
		isYou: personId === access.userId,
		seesTeam,
		tabs,
		today,
		current,
		earlier,
		canChange,
		/** Whether the change is the person's own, made because nobody else here could. */
		changesAlone: canChange && personId === access.userId,
		/**
		 * What the sheets need: sent only to those who change contracts, who see pay.
		 * A new contract may begin the day after the last one ends.
		 */
		sheets: canChange
			? {
					change: open ? { id: open.id, ...defaultsOf(open, today) } : null,
					give:
						person.isMember && (!last || last.endsOn !== null)
							? {
									from: last?.endsOn ? addDays(last.endsOn, 1) : today,
									joinedOn,
									hasContracts: theirs.length > 0,
								}
							: null,
					currency: money.currency,
					schedules: [...book.schedules.values()]
						.filter((s) => !s.archived)
						.map((s) => ({ id: s.id, name: s.name })),
					floor: {
						holidays: (annualLeave?.holidays ?? []).filter(
							(d) => d >= thisYear.first && d <= thisYear.last,
						),
						holidaysFromAllowance: settings.holidaysFromAllowance,
						ownWeek,
						weeks: Object.fromEntries(
							[...book.schedules.values()].map((s) => [s.id, versionOn(s, today).week]),
						),
					},
				}
			: null,
		/** Their annual leave this leave year from the contract, and its adjustments; null where no contract gives it. */
		leave: counted
			? {
					heading: `Annual leave, ${leaveYearLabel(settings.leaveYearStarts, year)}`,
					...contractBalanceWords(counted, today),
					adjustments: adjustments
						.filter((a) => a.leaveYear === year)
						.map((a) => {
							const size = Math.abs(a.minutes);
							const inDays =
								counted.dayLength !== null && Number.isInteger((size * 2) / counted.dayLength);
							return {
								id: a.id,
								title: `${a.minutes > 0 ? "Added" : "Taken away"}: ${leaveAmount(size, inDays ? counted.dayLength : null)}`,
								reason: a.reason,
								by: `${a.by ?? "A former member"}, ${formatDayWithYear(dayOf(a.createdAt, zone))}`,
							};
						}),
				}
			: null,
		/** What the adjustment sheet offers: the leave year before, this one and the next. Only for those who change contracts. */
		adjust:
			canChange && counted
				? {
						year: String(year),
						years: [year - 1, year, year + 1].map((y) => ({
							id: String(y),
							label: leaveYearLabel(settings.leaveYearStarts, y),
						})),
						inDays: counted.dayLength !== null,
					}
				: null,
	};
}

const Id = z.string().min(1).max(64);

/** How the days before a first contract count, where the Give sheet asks (decision 76). */
const PriorDaysField = z.preprocess(
	(value) => (value === "" ? undefined : value),
	z.enum(PRIOR_DAYS).optional(),
);

/** What the Give sheet's preview reads of its fields. Pay plays no part in leave, and may not be typed yet. */
const GivePreview = ContractFields.extend({
	startsOn: Day,
	priorDays: PriorDaysField,
	pay: z.unknown().transform(() => "0"),
});

const form = z.discriminatedUnion("intent", [
	ContractFields.extend({ intent: z.literal("give"), startsOn: Day, priorDays: PriorDaysField }),
	// The Give sheet's fields as they stand, half filled in maybe: read in the action, never refused.
	z.looseObject({ intent: z.literal("preview") }),
	ContractFields.extend({ intent: z.literal("change"), contractId: Id, from: Day }),
	z.object({
		intent: z.literal("end"),
		contractId: Id,
		lastDay: Day,
		reason: EndReason.exclude(["replaced"]),
	}),
	// A change to their annual leave in a leave year (TS-098b): more or less, in days or hours, and why.
	z.object({
		intent: z.literal("adjust"),
		leaveYear: z.coerce.number().int().min(2000).max(2200),
		amount: z.string().max(20),
		unit: z.enum(["days", "hours"]),
		reason: z.string().trim().min(1).max(ADJUSTMENT_REASON_MAX_LENGTH),
	}),
]);

/** What a refused change says. */
function refusal(change: Exclude<ContractChange, { change: "done" }>): string {
	switch (change.change) {
		case "overlap":
			return `That shares days with their contract from ${formatDayWithYear(change.with.startsOn)}. A person has one contract on a day: end that one first, or choose other days.`;
		case "missing":
			return "That person or contract is no longer here.";
		case "schedule":
			return "That schedule is archived or no longer here. Choose another.";
		case "pay":
			return "Enter the pay as an amount, such as 32000 or 15.50.";
		case "fixed-term-end":
			return "A fixed term needs its last day.";
		case "ends-before-start":
			return "Its last day is before its first. Choose a later one.";
		case "outside":
			return "Choose a day within the contract.";
		case "past-hours":
			return "Days already gone keep the hours they had. Choose a later end, or no schedule.";
		case "kind-on-first-day":
			return "A contract that begins that day is changed from its first day, not given a new kind. End it and give another.";
		case "ends-before-a-change":
			return "It changes after that day. Choose a last day after its latest change.";
		case "ended":
			return "That contract has ended already.";
	}
}

export async function action({ request, params, context }: Route.ActionArgs) {
	const membership = context.get(membershipContext);
	const { organisation, user } = membership;
	const personId = params[CONTRACT_PERSON_PARAM];
	const access = await accessOf(membership);
	if (!maySeeContractOf(access, personId)) throw notFound();
	const scope = organisationScope(env.DB, organisation.id);
	const others = await otherAdministrators(scope, personId);
	if (!mayChangeContractOf(access, personId, others)) return declined(NOT_ALLOWED, 403);
	const input = await parseRequest(request, form);
	const today = dayOf(Date.now(), await zoneOfMember(membership));
	// A contract named by the form is this person's, or it is nobody's here.
	if (input.intent === "change" || input.intent === "end") {
		const theirs = (await contractsOf(scope, [personId])).get(personId) ?? [];
		if (!theirs.some((c) => c.id === input.contractId)) {
			return declined(refusal({ change: "missing" }), 404);
		}
	}
	const answer = (change: ContractChange, said: string) =>
		change.change === "done"
			? done(said)
			: declined(refusal(change), change.change === "missing" ? 404 : 409);

	switch (input.intent) {
		case "give": {
			const change = await giveContract(
				scope,
				user.id,
				personId,
				input.startsOn,
				input,
				today,
				input.priorDays,
			);
			return answer(change, `The contract is given, from ${formatDayWithYear(input.startsOn)}.`);
		}
		case "preview": {
			// What the Give sheet's fields would make of this leave year's balance, saving nothing.
			const fields = GivePreview.safeParse(input);
			if (!fields.success) return done("");
			const { startsOn, priorDays } = fields.data;
			const planned = await previewedContracts(
				scope,
				personId,
				startsOn,
				fields.data,
				today,
				priorDays,
			);
			if (planned.change !== "planned") return done("");
			const [now, then] = await Promise.all([
				annualLeaveOf(scope, personId),
				annualLeaveOf(scope, personId, planned),
			]);
			if (!now || !then) return done("");
			const year = leaveYearOf(now.settings.leaveYearStarts, today);
			const before = annualLeftWords(now, year);
			const after = annualLeftWords(then, year);
			return done(before && after ? `This year: ${before} → ${after}` : "");
		}
		case "change": {
			const change = await changeContract(
				scope,
				user.id,
				input.contractId,
				input.from,
				input,
				today,
			);
			return answer(change, `The contract is changed, from ${formatDayWithYear(input.from)}.`);
		}
		case "end": {
			const change = await endContract(
				scope,
				user.id,
				input.contractId,
				input.lastDay,
				input.reason,
				today,
			);
			return answer(change, `The contract ends on ${formatDayWithYear(input.lastDay)}.`);
		}
		case "adjust": {
			// Only a member's balance is adjusted: a leaver's went with their membership.
			const [member] = await scope.memberships.select((m) => eq(m.userId, personId), { limit: 1 });
			const annualLeave = member ? await annualLeaveOf(scope, personId) : null;
			if (!annualLeave) return declined(refusal({ change: "missing" }), 404);
			const counted = contractBalance(annualLeave.leave, input.leaveYear);
			if (!counted) return declined(ADJUST_NEEDS_CONTRACT, 409);
			const minutes = minutesFrom(input.amount, input.unit, counted.dayLength);
			if (minutes === null || Math.abs(minutes) > LONGEST_ADJUSTMENT_MINUTES) {
				return declined(
					input.unit === "days"
						? "Enter whole or half days, more or less, such as 2 or -1.5."
						: "Enter hours, more or less, such as 7:30 or -3.75.",
				);
			}
			const added = await addAdjustment(
				scope,
				user.id,
				personId,
				annualLeave.leave,
				annualLeave.annual,
				{ leaveYear: input.leaveYear, minutes, reason: input.reason },
			);
			if (!added.ok) return declined(ADJUST_NEEDS_CONTRACT, 409);
			const label = leaveYearLabel(annualLeave.settings.leaveYearStarts, input.leaveYear);
			return done(
				`Annual leave in ${label} is adjusted. ${contractBalanceWords(added.balance, today).value}.`,
			);
		}
	}
}

type LoaderData = Route.ComponentProps["loaderData"];
type Sheets = NonNullable<LoaderData["sheets"]>;

/** The sheets of this page. One is open at a time. */
type Task = "give" | "change" | "end" | "adjust";

export default function Contract({ loaderData }: Route.ComponentProps) {
	const organisation = useOrganisation();
	const {
		person,
		isYou,
		seesTeam,
		tabs,
		today,
		current,
		earlier,
		canChange,
		changesAlone,
		sheets,
		leave,
		adjust,
	} = loaderData;
	const [task, setTask] = useState<Task | null>(null);
	// What the sheets were last opened with. The answer to a sheet's own form
	// changes the page's data (a contract given has no Give, an ended one no
	// Change or End), and a sheet drawn from that data would be taken away, or
	// made anew, before it could hand the answer over and close. Each opening
	// draws them afresh, so their fields start from the page as it is then.
	const [opened, setOpened] = useState<{ count: number; sheets: Sheets } | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);
	const begin = (next: Task) => {
		if (!sheets) return;
		setOpened((last) => ({ count: (last?.count ?? 0) + 1, sheets }));
		setTask(next);
	};
	const whose = isYou ? "your" : "their";

	return (
		<>
			{seesTeam && (
				<p>
					<Link to={destinationPath(organisation.slug, "team")} className={ACTION_LINK}>
						← Everyone's week
					</Link>
				</p>
			)}
			<div className={seesTeam ? "mt-4" : undefined}>
				<PageHeading>{person.name}</PageHeading>
			</div>
			<PageLead>
				{person.isMember ? "" : "No longer a member. Their contracts are kept as payroll records. "}
				{canChange
					? changesAlone
						? "Nobody else here can change your contract, so you change it yourself, and its record says so."
						: `${isYou ? "Your" : "Their"} contract: the terms ${isYou ? "you work" : "they work"} on, each change from its day.`
					: `${isYou ? "Your" : "Their"} contract, as owners and admins set it.`}
			</PageLead>
			<PersonTabs slug={organisation.slug} personId={person.id} current="contract" tabs={tabs} />
			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			{current ? (
				<div className="mt-6 flex max-w-200 flex-col gap-6">
					<Ledger heading={current.heading}>
						<LedgerRows label={`${whose === "your" ? "Your" : "Their"} contract`}>
							{current.lines.map((line) => (
								<LedgerRow key={line} title={line} />
							))}
						</LedgerRows>
					</Ledger>
					{(sheets?.change || sheets?.give) && (
						<div className="flex flex-wrap gap-2">
							{sheets.change && (
								<>
									<Button variant="tonal" onPress={() => begin("change")}>
										Change contract
									</Button>
									<Button variant="text" onPress={() => begin("end")}>
										End contract
									</Button>
								</>
							)}
							{sheets.give && (
								<Button variant="text" onPress={() => begin("give")}>
									Give a new contract
								</Button>
							)}
						</div>
					)}
					{current.changes.length > 0 && (
						<Ledger heading="Its changes">
							<LedgerRows label="Its changes">
								{current.changes.map((line) => (
									<LedgerRow key={line} title={line} />
								))}
							</LedgerRows>
						</Ledger>
					)}
				</div>
			) : (
				<EmptySheet heading="No contract">
					{isYou ? "You have" : "They have"} no contract here
					{earlier.length > 0 ? " today" : ""}.{" "}
					{sheets?.give
						? `Give one to set ${whose} hours, pay and leave from a day.`
						: `${isYou ? "Your" : "Their"} hours come from ${whose} team, role or the organisation's default.`}
				</EmptySheet>
			)}
			{!current && sheets?.give && (
				<div className="mt-4 max-w-200">
					<Button variant="filled" onPress={() => begin("give")}>
						Give a contract
					</Button>
				</div>
			)}
			{leave && (
				<div className="mt-10 flex max-w-200 flex-col gap-4">
					<Ledger heading={leave.heading}>
						<LedgerRows label={leave.heading}>
							<LedgerRow title="Balance" detail={leave.detail} value={leave.value} />
							{leave.adjustments.map((a) => (
								<LedgerRow
									key={a.id}
									title={a.title}
									detail={
										<>
											<span className="block wrap-anywhere">“{a.reason}”</span>
											{a.by}
										</>
									}
								/>
							))}
						</LedgerRows>
					</Ledger>
					{adjust && (
						<div>
							<Button variant="text" onPress={() => setTask("adjust")}>
								Adjust annual leave
							</Button>
						</div>
					)}
				</div>
			)}

			{earlier.length > 0 && (
				<div className="mt-10 flex max-w-200 flex-col gap-6">
					{earlier.map((each) => (
						<Ledger key={each.id} heading={each.heading}>
							<LedgerRows label={each.heading}>
								{[...each.lines, ...each.changes].map((line) => (
									<LedgerRow key={line} title={line} />
								))}
							</LedgerRows>
						</Ledger>
					))}
				</div>
			)}

			{opened && (
				<>
					<TermsSheet
						key={`give:${opened.count}`}
						task="give"
						isOpen={task === "give"}
						onClose={close}
						onDone={setSaid}
						name={person.name}
						sheets={opened.sheets}
						from={opened.sheets.give?.from ?? today}
						defaults={null}
					/>
					{opened.sheets.change && (
						<>
							<TermsSheet
								key={`change:${opened.count}`}
								task="change"
								isOpen={task === "change"}
								onClose={close}
								onDone={setSaid}
								name={person.name}
								sheets={opened.sheets}
								from={opened.sheets.change.firstDay}
								defaults={opened.sheets.change}
							/>
							<FormSheet
								key={`end:${opened.count}`}
								title={`End ${person.name}'s contract`}
								intent="end"
								submitLabel="End contract"
								isOpen={task === "end"}
								onClose={close}
								onDone={setSaid}
							>
								<input type="hidden" name="contractId" value={opened.sheets.change.id} />
								<TextField
									label="Last day"
									name="lastDay"
									type="date"
									defaultValue={opened.sheets.change.endsOn ?? today}
									min={opened.sheets.change.startsOn}
									isRequired
									description="The last day it covers. From the next, their hours come from their team, role or the default."
								/>
								<Select
									label="Why it ends"
									name="reason"
									defaultValue={
										opened.sheets.change.kind === "fixed_term"
											? "end_of_term"
											: CHOSEN_END_REASONS[0]
									}
									isRequired
									options={CHOSEN_END_REASONS.map((id) => ({ id, label: END_REASON_LABELS[id] }))}
								/>
							</FormSheet>
						</>
					)}
				</>
			)}
			{adjust && (
				<FormSheet
					title={`Adjust ${person.name}'s annual leave`}
					intent="adjust"
					submitLabel="Adjust"
					isOpen={task === "adjust"}
					onClose={close}
					onDone={setSaid}
				>
					<Select
						label="Leave year"
						name="leaveYear"
						defaultValue={adjust.year}
						isRequired
						options={adjust.years}
					/>
					<div className="flex flex-wrap gap-4 *:min-w-0 *:grow *:basis-44">
						<TextField
							label="More or less"
							name="amount"
							inputMode="decimal"
							autoComplete="off"
							isRequired
							maxLength={20}
							description={
								adjust.inDays
									? "Days as 2 or 0.5, hours as 7:30. A minus takes away: -1."
									: "Hours as 7:30 or 7.5. A minus takes away: -7:30."
							}
						/>
						<Select
							label="In"
							name="unit"
							defaultValue={adjust.inDays ? "days" : "hours"}
							isRequired
							options={[
								...(adjust.inDays ? [{ id: "days", label: "Days" }] : []),
								{ id: "hours", label: "Hours" },
							]}
						/>
					</div>
					<TextField
						label="Reason"
						name="reason"
						autoComplete="off"
						isRequired
						maxLength={ADJUSTMENT_REASON_MAX_LENGTH}
						description="An opening balance, carry-over the law gives, or a correction. It is recorded, and the person reads it."
					/>
				</FormSheet>
			)}
		</>
	);
}

/** The sheet that gives a contract, or changes one from a day: its kind, dates and terms. */
function TermsSheet({
	task,
	isOpen,
	onClose,
	onDone,
	name,
	sheets,
	from,
	defaults,
}: {
	task: "give" | "change";
	isOpen: boolean;
	onClose: () => void;
	onDone: (said: string) => void;
	name: string;
	sheets: Sheets;
	from: Day;
	defaults: (ContractDefaults & { id: string }) | null;
}) {
	const [overtime, setOvertime] = useState<OvertimePay>(defaults?.overtimePay ?? "unpaid");
	const [kind, setKind] = useState<string>(defaults?.kind ?? "permanent");
	const [scheduleId, setScheduleId] = useState<string>(defaults?.scheduleId ?? "");
	const [leaveDays, setLeaveDays] = useState<string>(defaults?.leaveDays ?? "");
	const [startsOn, setStartsOn] = useState<string>(from);
	const [chosen, setChosen] = useState<PriorDays | null>(null);
	// The statutory floor (TS-098b): warned of as the days are typed, never refused.
	const week: ScheduleWeek = (scheduleId && sheets.floor.weeks[scheduleId]) || sheets.floor.ownWeek;
	const below =
		kind !== "contractor" &&
		/^\d+$/.test(leaveDays.trim()) &&
		belowStatutoryFloor({
			leaveDays: Number(leaveDays),
			week,
			holidayMinutes: holidayMinutesOn(week, sheets.floor.holidays),
			holidaysFromAllowance: sheets.floor.holidaysFromAllowance,
		});
	const multipliers = MULTIPLIERS.map((bp) => ({ id: String(bp), label: MULTIPLIER_LABELS[bp] }));
	const giving = task === "give";
	// Asked of a first contract for someone who joined before it starts (decision 76); suggested until chosen.
	const asked =
		giving && sheets.give && /^\d{4}-\d{2}-\d{2}$/.test(startsOn)
			? priorDaysQuestion(sheets.give.joinedOn, sheets.give.hasContracts, startsOn)
			: null;
	const priorDays = asked ? (chosen ?? asked) : null;
	return (
		<FormSheet
			title={giving ? `Give ${name} a contract` : `Change ${name}'s contract`}
			intent={task}
			submitLabel={giving ? "Give contract" : "Change contract"}
			isOpen={isOpen}
			onClose={onClose}
			onDone={onDone}
		>
			{defaults && <input type="hidden" name="contractId" value={defaults.id} />}
			<TextField
				label={giving ? "First day" : "From"}
				name={giving ? "startsOn" : "from"}
				type="date"
				value={giving ? startsOn : undefined}
				onChange={giving ? setStartsOn : undefined}
				defaultValue={giving ? undefined : from}
				min={defaults ? defaults.startsOn : undefined}
				isRequired
				description={
					giving
						? "The first day it covers. It may be a day already gone."
						: "Days before keep the terms they had. A new kind ends this contract the day before and starts the next."
				}
			/>
			<Select
				label="Kind"
				name="kind"
				value={kind}
				onChange={(id) => setKind(id ?? "permanent")}
				isRequired
				options={OFFERED_KINDS.map((id) => ({ id, label: KIND_LABELS[id] }))}
			/>
			<TextField
				label="Last day"
				name="endsOn"
				type="date"
				defaultValue={defaults?.endsOn ?? ""}
				isRequired={kind === "fixed_term"}
				description={
					kind === "fixed_term" ? "A fixed term ends on this day." : "Leave empty for no end."
				}
			/>
			<TextField
				label="Job title"
				name="jobTitle"
				defaultValue={defaults?.jobTitle ?? ""}
				maxLength={JOB_TITLE_MAX_LENGTH}
			/>
			<Select
				label="Work schedule"
				name="scheduleId"
				value={scheduleId}
				onChange={(id) => setScheduleId(id ?? "")}
				options={[
					{ id: "", label: "None of its own: their team's, role's or the default" },
					...sheets.schedules.map((s) => ({ id: s.id, label: s.name })),
				]}
				description="The hours it gives, from its day. Their schedule on Team follows it."
			/>
			<div className="flex flex-wrap gap-4 *:min-w-0 *:grow *:basis-44">
				<TextField
					label={`Pay, in ${sheets.currency}`}
					name="pay"
					defaultValue={defaults?.pay ?? ""}
					inputMode="decimal"
					isRequired
				/>
				<Select
					label="Paid"
					name="payBasis"
					defaultValue={defaults?.payBasis ?? "yearly"}
					isRequired
					options={PAY_BASES.map((id) => ({ id, label: PAY_BASIS_LABELS[id] }))}
				/>
			</div>
			<input type="hidden" name="currency" value={defaults?.currency ?? sheets.currency} />
			<Select
				label="Overtime"
				name="overtimePay"
				value={overtime}
				onChange={(id) => setOvertime((id as OvertimePay | null) ?? "unpaid")}
				isRequired
				options={OVERTIME_PAYS.map((id) => ({ id, label: OVERTIME_PAY_LABELS[id] }))}
			/>
			{overtime !== "unpaid" && (
				<>
					<Select
						label="Overtime at"
						name="overtimeMultiplier"
						defaultValue={defaults?.overtimeMultiplier || "10000"}
						isRequired
						options={multipliers}
					/>
					<Select
						label="On days off and public holidays"
						name="restDayMultiplier"
						defaultValue={defaults?.restDayMultiplier ?? ""}
						options={[{ id: "", label: "As other overtime" }, ...multipliers]}
					/>
				</>
			)}
			{kind !== "contractor" && (
				<>
					<TextField
						label="Annual leave, days a year"
						name="leaveDays"
						type="number"
						inputMode="numeric"
						min="0"
						max="366"
						value={leaveDays}
						onChange={setLeaveDays}
						description={`For a full week, ${sheets.floor.holidaysFromAllowance ? "public holidays included" : "plus public holidays"}. Leave empty for the kind of leave's allowance.`}
					/>
					<p role="status" className="text-body-medium text-on-surface-variant empty:hidden">
						{below ? BELOW_STATUTORY : ""}
					</p>
					<div className="flex flex-wrap gap-4 *:min-w-0 *:grow *:basis-44">
						<TextField
							label="Days carried over"
							name="carryOverDays"
							type="number"
							inputMode="numeric"
							min="0"
							max="366"
							defaultValue={defaults?.carryOverDays ?? ""}
							description="At most, of what is left at a leave year's end. Empty carries none."
						/>
						<TextField
							label="Carried leave lasts, days"
							name="carryOverExpiresAfterDays"
							type="number"
							inputMode="numeric"
							min="1"
							max="366"
							defaultValue={defaults?.carryOverExpiresAfterDays ?? ""}
							description="Into the next leave year. Empty lasts to its end."
						/>
					</div>
				</>
			)}
			{priorDays && (
				<RadioGroup
					label="Earlier this leave year"
					name="priorDays"
					value={priorDays}
					onChange={(value) => setChosen(value as PriorDays)}
					isRequired
				>
					{PRIOR_DAYS.map((id) => (
						<Radio key={id} value={id}>
							{PRIOR_DAYS_LABELS[id]}
						</Radio>
					))}
				</RadioGroup>
			)}
			{giving && (
				<BalancePreview
					kept={{ startsOn, kind, scheduleId, leaveDays, priorDays: priorDays ?? "" }}
				/>
			)}
			<TextField
				label="Works number"
				name="worksNumber"
				defaultValue={defaults?.worksNumber ?? ""}
				maxLength={WORKS_NUMBER_MAX_LENGTH}
				description="Their number in your payroll software, if it has one."
			/>
		</FormSheet>
	);
}

/** The fields of the Give sheet it keeps itself, which its form may not have caught up with. */
interface KeptFields {
	startsOn: string;
	kind: string;
	scheduleId: string;
	leaveDays: string;
	priorDays: string;
}

/**
 * What the Give sheet's fields would make of this leave year's balance, "This
 * year: 25 days → 25 days", asked of the server as they change (decision 76):
 * the same sum as the contract once saved. The fields the sheet keeps are
 * sent as it holds them; the others are heard as they are typed.
 */
function BalancePreview({ kept }: { kept: KeptFields }) {
	const fetcher = useFetcher<Outcome>();
	const { submit } = fetcher;
	const anchor = useRef<HTMLParagraphElement>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const { startsOn, kind, scheduleId, leaveDays, priorDays } = kept;
	useEffect(() => {
		const form = anchor.current?.closest("form");
		if (!form) return;
		const ask = () => {
			clearTimeout(timer.current);
			timer.current = setTimeout(() => {
				const fields = new FormData(form);
				fields.set("intent", "preview");
				for (const [name, value] of Object.entries({
					startsOn,
					kind,
					scheduleId,
					leaveDays,
					priorDays,
				})) {
					fields.set(name, value);
				}
				void submit(fields, { method: "post" });
			}, 300);
		};
		ask();
		form.addEventListener("input", ask);
		return () => {
			clearTimeout(timer.current);
			form.removeEventListener("input", ask);
		};
	}, [submit, startsOn, kind, scheduleId, leaveDays, priorDays]);
	return (
		<p ref={anchor} role="status" className="text-body-medium text-on-surface empty:hidden">
			{fetcher.data?.ok ? fetcher.data.said : ""}
		</p>
	);
}
