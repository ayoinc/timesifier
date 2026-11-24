import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { useState } from "react";
import { Link } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import {
	CHOSEN_END_REASONS,
	ContractFields,
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
	WORKS_NUMBER_MAX_LENGTH,
} from "~/contracts/contracts";
import {
	type ContractChange,
	changeContract,
	endContract,
	giveContract,
	otherAdministrators,
} from "~/contracts/contracts.server";
import { contractsOf } from "~/contracts/read.server";
import { type ContractDefaults, contractsView, defaultsOf } from "~/contracts/view";
import { type OrganisationScope, organisationScope, users } from "~/db";
import { parseRequest } from "~/lib/validate";
import { mayChangeContractOf, maySeeContractOf, maySeePayOf } from "~/organisations/access";
import { accessOf } from "~/organisations/access.server";
import { membershipContext, notFound, viewerOf } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { shownName } from "~/organisations/people";
import { NOT_ALLOWED } from "~/organisations/problems";
import { organisationMoney } from "~/projects/money.server";
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

// One person's contracts, a page of Team beside their Week (TS-098a,
// research/contracts-model.md sections 6 and 7). Owners, admins and Finance
// read anybody's, a manager the people of their teams, and a person their own;
// anybody else gets the organisation's 404, as if there were nobody. What a
// viewer may not read (pay, multipliers, the works number) is left out on the
// server. Owners and admins give, change and end contracts in sheets, never
// their own while another owner or admin could.

const TITLE = "Contract";

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
	const [contracts, book, zone, others, money] = await Promise.all([
		contractsOf(scope, [personId]),
		scheduleBookOf(scope),
		zoneOfMember(membership),
		otherAdministrators(scope, personId),
		organisationMoney(organisation.id),
	]);
	const theirs = contracts.get(personId) ?? [];
	const person = await personOf(scope, organisation, personId, theirs.length > 0);
	if (!person) throw notFound();
	const today = dayOf(Date.now(), zone);
	const seesPay = maySeePayOf(access, personId);
	const canChange = mayChangeContractOf(access, personId, others);
	const { current, others: earlier, currentContract } = contractsView(theirs, book, today, seesPay);
	const seesTeam = canSee(viewerOf(membership), "team");
	const tabs: PersonTab[] = seesTeam && person.isMember ? ["week", "contract"] : ["contract"];
	// The contract a sheet changes or ends: the one that covers today, or the next to begin, while it is not ended.
	const open = currentContract && currentContract.endReason === null ? currentContract : null;
	const last = theirs.at(-1);
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
							? { from: last?.endsOn ? addDays(last.endsOn, 1) : today }
							: null,
					currency: money.currency,
					schedules: [...book.schedules.values()]
						.filter((s) => !s.archived)
						.map((s) => ({ id: s.id, name: s.name })),
				}
			: null,
	};
}

const Id = z.string().min(1).max(64);

const form = z.discriminatedUnion("intent", [
	ContractFields.extend({ intent: z.literal("give"), startsOn: Day }),
	ContractFields.extend({ intent: z.literal("change"), contractId: Id, from: Day }),
	z.object({
		intent: z.literal("end"),
		contractId: Id,
		lastDay: Day,
		reason: EndReason.exclude(["replaced"]),
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
	if (input.intent !== "give") {
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
			const change = await giveContract(scope, user.id, personId, input.startsOn, input, today);
			return answer(change, `The contract is given, from ${formatDayWithYear(input.startsOn)}.`);
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
	}
}

type LoaderData = Route.ComponentProps["loaderData"];
type Sheets = NonNullable<LoaderData["sheets"]>;

/** The sheets of this page. One is open at a time. */
type Task = "give" | "change" | "end";

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
	} = loaderData;
	const [task, setTask] = useState<Task | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);
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
									<Button variant="tonal" onPress={() => setTask("change")}>
										Change contract
									</Button>
									<Button variant="text" onPress={() => setTask("end")}>
										End contract
									</Button>
								</>
							)}
							{sheets.give && (
								<Button variant="text" onPress={() => setTask("give")}>
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
						? "Give one to set their hours, pay and leave from a day."
						: "Their hours come from their team, role or the organisation's default."}
				</EmptySheet>
			)}
			{!current && sheets?.give && (
				<div className="mt-4 max-w-200">
					<Button variant="filled" onPress={() => setTask("give")}>
						Give a contract
					</Button>
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

			{sheets && (
				<>
					<TermsSheet
						key={`give:${sheets.give?.from ?? ""}`}
						task="give"
						isOpen={task === "give"}
						onClose={close}
						onDone={setSaid}
						name={person.name}
						sheets={sheets}
						from={sheets.give?.from ?? today}
						defaults={null}
					/>
					{sheets.change && (
						<>
							<TermsSheet
								key={`change:${sheets.change.firstDay}`}
								task="change"
								isOpen={task === "change"}
								onClose={close}
								onDone={setSaid}
								name={person.name}
								sheets={sheets}
								from={sheets.change.firstDay}
								defaults={sheets.change}
							/>
							<FormSheet
								title={`End ${person.name}'s contract`}
								intent="end"
								submitLabel="End contract"
								isOpen={task === "end"}
								onClose={close}
								onDone={setSaid}
							>
								<input type="hidden" name="contractId" value={sheets.change.id} />
								<TextField
									label="Last day"
									name="lastDay"
									type="date"
									defaultValue={sheets.change.endsOn ?? today}
									min={sheets.change.startsOn}
									isRequired
									description="The last day it covers. From the next, their hours come from their team, role or the default."
								/>
								<Select
									label="Why it ends"
									name="reason"
									defaultValue={
										sheets.change.kind === "fixed_term" ? "end_of_term" : CHOSEN_END_REASONS[0]
									}
									isRequired
									options={CHOSEN_END_REASONS.map((id) => ({ id, label: END_REASON_LABELS[id] }))}
								/>
							</FormSheet>
						</>
					)}
				</>
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
	const multipliers = MULTIPLIERS.map((bp) => ({ id: String(bp), label: MULTIPLIER_LABELS[bp] }));
	const giving = task === "give";
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
				defaultValue={from}
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
				defaultValue={defaults?.scheduleId ?? ""}
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
				<TextField
					label="Annual leave, days a year"
					name="leaveDays"
					type="number"
					inputMode="numeric"
					min="0"
					max="366"
					defaultValue={defaults?.leaveDays ?? ""}
					description="For a full week, plus public holidays. Leave empty for the kind of leave's allowance."
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
