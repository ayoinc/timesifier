import { env } from "cloudflare:workers";
import { useEffect, useState } from "react";
import { Link, redirect, useFetcher } from "react-router";
import * as z from "zod";

import { BrandSettings } from "~/brand/BrandSettings";
import { BRAND_FORMS, brandAction, brandData, SETTINGS_MAX_BYTES } from "~/brand/settings.server";
import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Radio, RadioGroup } from "~/components/Radio";
import { Select } from "~/components/Select";
import { Switch } from "~/components/Switch";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { keepCategory, listCategories } from "~/expenses/categories.server";
import { ExpenseCategories } from "~/expenses/ExpenseCategories";
import { termsOf } from "~/expenses/expenses.server";
import { LARGEST_ALLOWANCE_DAYS, LEAVE_NAME_MAX_LENGTH } from "~/leave/kinds";
import { LeaveSettings } from "~/leave/LeaveSettings";
import {
	addPublicHoliday,
	changeKind,
	leaveKindsOf,
	publicHolidaysOf,
	removePublicHoliday,
} from "~/leave/leave.server";
import {
	LONGEST_NOTICE_DAYS,
	NON_WORKING_RULE_LABELS,
	NON_WORKING_RULES,
	NonWorkingRule,
	OVERTIME_RULE_LABELS,
	OVERTIME_RULES,
	OvertimeRule,
	SHORT_NOTICE_LABELS,
	SHORT_NOTICE_RULES,
	ShortNoticeRule,
	type TimesheetRules,
} from "~/leave/rules";
import { setTimesheetRules, timesheetRulesOf } from "~/leave/rules.server";
import { parseRequest } from "~/lib/validate";
import { LockSettings } from "~/locks/LockSettings";
import { LOCK_FORMS, lockAction, lockingData } from "~/locks/settings.server";
import { CurrencyCode } from "~/money/money";
import { isAdministrator } from "~/organisations/access";
import { deleteOrganisation, renameOrganisation } from "~/organisations/api.server";
import { membershipContext } from "~/organisations/membership.server";
import { NAME_MAX_LENGTH, Name, nameProblem } from "~/organisations/name";
import { declined, done, refused } from "~/organisations/outcome.server";
import { AS_ROLE } from "~/organisations/people";
import { NOT_ALLOWED, type Outcome } from "~/organisations/problems";
import { allows } from "~/organisations/roles";
import { WeekStart } from "~/periods/periods";
import { planStanding } from "~/plans/plans.server";
import { SUPPORT_ACCESS_SEGMENT, WELLBEING_SEGMENT } from "~/platform/paths";
import { activeGrant } from "~/platform/support.server";
import { MoneySettings } from "~/projects/MoneySettings";
import { organisationMoney } from "~/projects/money.server";
import { CapHours, defaultScheduleSummary } from "~/schedules/forms";
import { scheduleBookOf } from "~/schedules/schedules.server";
import { APP_PATH, destination, organisationPath, schedulesPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading, Section } from "~/shell/PageHeading";
import { Day, dayOf } from "~/time/calendar";
import { formatDayAndTime, formatDayWithYear, formatDuration } from "~/time/format";
import { TimeZone } from "~/time/zones";
import { zoneOfMember } from "~/time/zones.server";
import { WEEKDAYS, weekdayName, zoneLabel } from "~/workspace/general";
import { changeGeneral, timeZones } from "~/workspace/general.server";

import type { Route } from "./+types/settings";
import { FormSheet } from "./FormSheet";

// Workspace settings: the organisation on screen, which its owners and admins
// manage for everyone in it (docs/navigation.md, "Workspace settings"). Only
// they are shown it; anybody else gets 404 here (app/shell/destinations.ts).
// General holds its name, its default time zone, the day its weeks start on
// and whether Clients is shown (TS-048). Below it are the default work schedule (TS-097), the
// kinds of leave with their allowances and notice, and the public holidays,
// which apply to everyone in the organisation (TS-061), then the timesheet
// rules: overtime, weekend work and short-notice leave (TS-090), then the
// expense categories (TS-070). Brand, under General, holds the logo and colour
// that lead the documents the organisation sends (TS-100). The person's own
// account is on My account.

const { label } = destination("settings");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

/** The organisation and what the person's role lets them do to it. The checks on the layouts have already run. */
export async function loader({ context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const { organisation, role } = membership;
	const canChange = allows(role, { organization: ["update"] });
	const scope = organisationScope(env.DB, organisation.id);
	const now = new Date();
	const isOwner = role === "owner";
	const [book, kinds, holidays, rules, categories, terms, locking, standing, grant] =
		await Promise.all([
			scheduleBookOf(scope),
			leaveKindsOf(scope),
			publicHolidaysOf(scope),
			timesheetRulesOf(organisation.id),
			listCategories(scope),
			termsOf(organisation.id),
			lockingData(organisation, now.getTime()),
			planStanding(organisation.id, now),
			// Support access is the owners' alone, so nobody else is told whether it is granted.
			isOwner ? activeGrant(scope, now) : null,
		]);
	return {
		organisation: {
			name: organisation.name,
			role,
			timeZone: organisation.timeZone,
			weekStartsOn: organisation.weekStartsOn,
			clientsEnabled: organisation.clientsEnabled,
			canChange,
			canDelete: allows(role, { organization: ["delete"] }),
		},
		// Only those who may choose a zone are sent the list.
		zones: canChange ? timeZones() : [],
		/** The default work schedule (TS-097), the kinds of leave and the public holidays (TS-061). */
		leave: {
			schedule: defaultScheduleSummary(
				book,
				dayOf(Date.now(), organisation.timeZone),
				schedulesPath(organisation.slug),
			),
			kinds,
			holidays,
		},
		/** Overtime, weekend work and short-notice leave (TS-090). */
		rules,
		/** The expense categories (TS-070). */
		expenses: {
			currency: terms.currency,
			today: dayOf(Date.now(), organisation.timeZone),
			categories,
		},
		/** The lock date, the deadline and auto-lock (TS-065). */
		locking,
		/** The currency, and whether non-billable hours count against budgets (TS-067, TS-069). */
		money: await organisationMoney(organisation.id),
		/** The logo and colour that lead the organisation's documents (TS-100). */
		brand: await brandData(organisation),
		/** The plan Timesifier set, and the seats it uses (TS-099). */
		plan: standing && {
			label: standing.label,
			used: standing.used,
			seats: standing.seats,
			trialEndsOn: standing.trialEndsAt
				? formatDayWithYear(dayOf(standing.trialEndsAt.getTime(), organisation.timeZone))
				: null,
			trialEnded: standing.trialEnded,
			warning: standing.warning,
		},
		/** Support access and wellbeing, which only owners open (TS-099). */
		owners: isOwner
			? {
					supportGrantedUntil: grant
						? formatDayAndTime(grant.expiresAt.getTime(), await zoneOfMember(membership))
						: null,
				}
			: null,
	};
}

const LeaveName = z.string().trim().min(1).max(LEAVE_NAME_MAX_LENGTH);
/** A checkbox sends its value only while it is ticked. */
const Ticked = z
	.literal("on")
	.optional()
	.transform((value) => value === "on");
/** A yearly allowance in days, whole or half; empty is none. Kept as half days. */
const AllowanceDays = z
	.string()
	.trim()
	.max(6)
	.transform((text, context) => {
		if (text === "") return null;
		const days = Number(text.replace(",", "."));
		if (
			!Number.isFinite(days) ||
			days < 0 ||
			days > LARGEST_ALLOWANCE_DAYS ||
			!Number.isInteger(days * 2)
		) {
			context.addIssue({
				code: "custom",
				message: `Type whole or half days, at most ${LARGEST_ALLOWANCE_DAYS}.`,
			});
			return z.NEVER;
		}
		return days * 2;
	});
/** Days of notice a kind asks for, whole; empty is none. */
const NoticeDays = z
	.string()
	.trim()
	.max(6)
	.transform((text, context) => {
		if (text === "") return 0;
		const days = Number(text);
		if (!/^\d+$/.test(text) || days > LONGEST_NOTICE_DAYS) {
			context.addIssue({
				code: "custom",
				message: `Type whole days, at most ${LONGEST_NOTICE_DAYS}.`,
			});
			return z.NEVER;
		}
		return days;
	});
/** Each thing this page can ask for. A form says which with its `intent`. */
const form = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("rename"), name: Name }),
	z.object({ intent: z.literal("time-zone"), timeZone: TimeZone }),
	z.object({ intent: z.literal("week-start"), weekStartsOn: WeekStart }),
	// A switch sends its value only while it is on: no `clientsEnabled` is off.
	z.object({ intent: z.literal("clients"), clientsEnabled: z.literal("on").optional() }),
	z.object({ intent: z.literal("currency"), currency: CurrencyCode }),
	z.object({ intent: z.literal("budget-hours"), countNonBillable: z.literal("on").optional() }),
	// What the person typed to confirm. It is compared with the name; it is never used as one.
	z.object({ intent: z.literal("delete"), confirmation: z.string().max(200) }),
	z.object({
		intent: z.literal("kind"),
		kindId: z.string().min(1).max(64),
		name: LeaveName,
		enabled: Ticked,
		needsApproval: Ticked,
		allowanceDays: AllowanceDays.optional(),
		// Not sent for sick leave and public holidays, which never need notice.
		noticeDays: NoticeDays.optional(),
	}),
	z.object({
		intent: z.literal("timesheet-rules"),
		overtime: OvertimeRule,
		weekend: NonWorkingRule,
		overtimeDayCap: CapHours,
		overtimeWeekCap: CapHours,
		shortNotice: ShortNoticeRule,
	}),
	z.object({ intent: z.literal("add-holiday"), day: Day, name: LeaveName }),
	z.object({ intent: z.literal("remove-holiday"), holidayId: z.string().min(1).max(64) }),
	z.object({
		intent: z.literal("add-category"),
		name: z.string().max(200),
		unitName: z.string().max(200).optional(),
		unitPrice: z.string().max(32).optional(),
		from: z.preprocess((value) => (value === "" ? undefined : value), Day.optional()),
	}),
	z.object({
		intent: z.literal("change-category"),
		categoryId: z.string().min(1).max(64),
		name: z.string().max(200),
		unitName: z.string().max(200).optional(),
		unitPrice: z.string().max(32).optional(),
		from: z.preprocess((value) => (value === "" ? undefined : value), Day.optional()),
	}),
	z.object({
		intent: z.enum(["archive-category", "restore-category"]),
		categoryId: z.string().min(1).max(64),
	}),
	z.object({ intent: z.literal("add-usual-categories") }),
	...LOCK_FORMS,
	...BRAND_FORMS,
]);

/**
 * The organisation's general settings and its deletion, which the server
 * allows by role. The organisation acted on is the one in the address, as the
 * layout read it; no form names one.
 */
export async function action({ request, context }: Route.ActionArgs) {
	// A logo, and the PNG drawn from it, need more room than any other form here.
	const input = await parseRequest(request, form, { maxBytes: SETTINGS_MAX_BYTES });
	const membership = context.get(membershipContext);
	const { organisation, role, user } = membership;
	switch (input.intent) {
		case "rename": {
			const renamed = await renameOrganisation(request, organisation.id, input.name);
			return renamed.ok ? done(`The organisation is now called ${input.name}.`) : refused(renamed);
		}

		case "time-zone":
		case "week-start":
		case "clients": {
			if (!allows(role, { organization: ["update"] })) return declined(NOT_ALLOWED, 403);
			if (input.intent === "time-zone") {
				await changeGeneral(env.DB, organisation.id, { timeZone: input.timeZone });
				return done(`The default time zone is now ${zoneLabel(input.timeZone)}.`);
			}
			if (input.intent === "week-start") {
				await changeGeneral(env.DB, organisation.id, { weekStartsOn: input.weekStartsOn });
				return done(`Weeks now start on ${weekdayName(input.weekStartsOn)}.`);
			}
			const clientsEnabled = input.clientsEnabled === "on";
			await changeGeneral(env.DB, organisation.id, { clientsEnabled });
			return done(
				clientsEnabled
					? "Clients is on. Everyone sees each project's client."
					: "Clients is off. Nothing was deleted; turn it on to show them again.",
			);
		}

		case "currency":
		case "budget-hours": {
			if (!allows(role, { organization: ["update"] })) return declined(NOT_ALLOWED, 403);
			if (input.intent === "currency") {
				await changeGeneral(env.DB, organisation.id, { currency: input.currency });
				return done(
					`Amounts are now in ${input.currency} unless a client or a project has its own.`,
				);
			}
			const counts = input.countNonBillable === "on";
			await changeGeneral(env.DB, organisation.id, { budgetCountsNonBillable: counts });
			return done(
				counts
					? "Non-billable hours now count against hour budgets."
					: "Only billable hours now count against hour budgets.",
			);
		}

		case "kind":
		case "add-holiday":
		case "remove-holiday": {
			if (!isAdministrator(role)) return declined(NOT_ALLOWED, 403);
			const scope = organisationScope(env.DB, organisation.id);
			if (input.intent === "kind") {
				const changed = await changeKind(scope, input.kindId, {
					name: input.name,
					enabled: input.enabled,
					needsApproval: input.needsApproval,
					allowanceHalfDays: input.allowanceDays ?? null,
					noticeDays: input.noticeDays ?? 0,
				});
				return changed
					? done(`${input.name} is saved.`)
					: declined("That kind of leave is not there.", 404);
			}
			if (input.intent === "add-holiday") {
				return (await addPublicHoliday(scope, { day: input.day, name: input.name }))
					? done(`${input.name} is a public holiday.`)
					: declined("There is already a public holiday on that day.", 409);
			}
			return (await removePublicHoliday(scope, input.holidayId))
				? done("Public holiday removed.")
				: declined("That public holiday is no longer there.", 404);
		}

		case "timesheet-rules": {
			if (!isAdministrator(role)) return declined(NOT_ALLOWED, 403);
			await setTimesheetRules(organisation.id, user.id, {
				overtime: input.overtime,
				weekend: input.weekend,
				overtimeDayCap: input.overtimeDayCap,
				overtimeWeekCap: input.overtimeWeekCap,
				shortNotice: input.shortNotice,
			});
			return done("The timesheet rules are saved.");
		}

		case "add-category":
		case "change-category":
		case "archive-category":
		case "restore-category":
		case "add-usual-categories": {
			if (!isAdministrator(role)) return declined(NOT_ALLOWED, 403);
			const kept = await keepCategory(
				organisationScope(env.DB, organisation.id),
				membership.user.id,
				input,
				(await termsOf(organisation.id)).currency,
				dayOf(Date.now(), organisation.timeZone),
			);
			return kept.ok ? done(kept.said) : declined(kept.problem, kept.status);
		}

		case "deadline":
		case "lock-date":
		case "remove-lock-date":
			return lockAction(input, membership, Date.now());
		case "brand-logo":
		case "remove-logo":
		case "brand-colour":
			return brandAction(input, membership, Date.now());
		case "delete": {
			if (input.confirmation.trim() !== organisation.name) {
				return declined("That is not the organisation's name. Type it exactly as it is shown.");
			}
			const deleted = await deleteOrganisation(request, organisation.id);
			return deleted.ok ? redirect(APP_PATH) : refused(deleted);
		}
	}
}

/** The sheets of this page. One is open at a time. */
type Task = "rename" | "time-zone" | "week-start" | "delete";

export default function Settings({ loaderData, params }: Route.ComponentProps) {
	const { organisation, zones, leave, rules, expenses, locking } = loaderData;
	const [task, setTask] = useState<Task | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	// The name typed to confirm a deletion. The confirmation waits until it is the name exactly.
	const [typedName, setTypedName] = useState("");
	const close = () => setTask(null);
	const change = (to: Task, what: string) =>
		organisation.canChange && (
			<Button variant="text" aria-label={`Change ${what}`} onPress={() => setTask(to)}>
				Change
			</Button>
		);

	return (
		<>
			<PageHeading>{label}</PageHeading>
			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			<Section
				id="general"
				heading="General"
				lead={
					<>
						Shared by everyone in {organisation.name}. You are {AS_ROLE[organisation.role]}.
					</>
				}
				className="max-w-200"
			>
				<Ledger heading="Organisation">
					<LedgerRows>
						<LedgerRow
							title={<span className="wrap-anywhere">{organisation.name}</span>}
							detail="Name"
							action={
								organisation.canChange && (
									<Button variant="text" onPress={() => setTask("rename")}>
										Rename
									</Button>
								)
							}
						/>
						<LedgerRow
							title={zoneLabel(organisation.timeZone)}
							detail="Default time zone. A person's days are counted in it until they choose their own in My account."
							action={change("time-zone", "the default time zone")}
						/>
						<LedgerRow
							title={weekdayName(organisation.weekStartsOn)}
							detail="Week starts on. Every timesheet week, and the period it is submitted in, starts on this day."
							action={change("week-start", "the day weeks start on")}
						/>
						<ClientsRow
							enabled={organisation.clientsEnabled}
							canChange={organisation.canChange}
							onDone={setSaid}
						/>
					</LedgerRows>
				</Ledger>
			</Section>

			<BrandSettings
				data={loaderData.brand}
				organisationName={organisation.name}
				onDone={setSaid}
			/>

			<PlanSection
				plan={loaderData.plan}
				owners={loaderData.owners}
				home={organisationPath(params.organisation)}
			/>

			<MoneySettings
				currency={loaderData.money.currency}
				budgetCountsNonBillable={loaderData.money.budgetCountsNonBillable}
				canChange={organisation.canChange}
				onDone={setSaid}
			/>

			<LeaveSettings data={leave} onDone={setSaid} />

			<LockSettings data={locking} onDone={setSaid} />

			<RulesSection rules={rules} onDone={setSaid} />

			<ExpenseCategories data={expenses} onDone={setSaid} />

			{/* Deletion is last, under its own rule. */}
			{organisation.canDelete && (
				<Section
					id="delete-organisation"
					heading="Delete organisation"
					lead={
						<>
							Removes {organisation.name}, its members and its invitations for everyone. It cannot
							be undone.
						</>
					}
					className="max-w-200"
				>
					<Button
						variant="outlined-danger"
						onPress={() => {
							setTypedName("");
							setTask("delete");
						}}
					>
						Delete organisation
					</Button>
				</Section>
			)}

			<FormSheet
				title="Rename the organisation"
				intent="rename"
				submitLabel="Save"
				isOpen={task === "rename"}
				onClose={close}
				onDone={setSaid}
			>
				<p>Everyone in the organisation sees the new name. Its address stays the same.</p>
				<TextField
					label="Organisation name"
					name="name"
					defaultValue={organisation.name}
					autoComplete="off"
					autoFocus
					isRequired
					maxLength={NAME_MAX_LENGTH}
					validate={nameProblem}
				/>
			</FormSheet>

			<FormSheet
				title="Change the default time zone"
				intent="time-zone"
				submitLabel="Save"
				isOpen={task === "time-zone"}
				onClose={close}
				onDone={setSaid}
			>
				<p>
					Everyone who has not chosen their own zone counts their days in this one. Times already
					tracked stay as they are.
				</p>
				<Select
					label="Default time zone"
					name="timeZone"
					options={zones.map((zone) => ({ id: zone, label: zoneLabel(zone) }))}
					defaultValue={organisation.timeZone}
					isRequired
				/>
			</FormSheet>

			<FormSheet
				title="Change the day weeks start on"
				intent="week-start"
				submitLabel="Save"
				isOpen={task === "week-start"}
				onClose={close}
				onDone={setSaid}
			>
				<p>
					Every timesheet week starts on this day, and so does each period people submit. Periods
					already submitted keep their days.
				</p>
				<Select
					label="Week starts on"
					name="weekStartsOn"
					options={[...WEEKDAYS]}
					defaultValue={`${organisation.weekStartsOn}`}
					isRequired
				/>
			</FormSheet>

			<FormSheet
				title={`Delete ${organisation.name}?`}
				intent="delete"
				submitLabel="Delete organisation"
				submitVariant="danger"
				isSubmitDisabled={typedName !== organisation.name}
				isOpen={task === "delete"}
				onClose={close}
			>
				<p>
					This removes the organisation, its members and its invitations for everyone, and it cannot
					be undone. To confirm, type its name:{" "}
					<strong className="text-on-surface">{organisation.name}</strong>
				</p>
				<TextField
					label="Organisation name"
					name="confirmation"
					autoComplete="off"
					value={typedName}
					onChange={setTypedName}
					autoFocus
					isRequired
					validate={(typed) =>
						typed.trim() === organisation.name ? null : "Type the name exactly as it is shown."
					}
				/>
			</FormSheet>
		</>
	);
}

/**
 * The plan Timesifier set for the organisation and the seats it uses (TS-099),
 * and for owners, the two pages that are theirs alone: support access and
 * wellbeing. Plans are set in the platform console, not here.
 */
function PlanSection({
	plan,
	owners,
	home,
}: {
	plan: Route.ComponentProps["loaderData"]["plan"];
	owners: Route.ComponentProps["loaderData"]["owners"];
	/** The organisation's own address, which the owners' pages are below. */
	home: string;
}) {
	return (
		<Section
			id="plan"
			heading="Plan"
			lead="Plans are set by Timesifier. Ask us for more seats."
			className="max-w-200"
		>
			<div className="flex flex-col gap-6">
				{plan && (
					<Ledger heading="Your plan">
						<LedgerRows>
							<LedgerRow
								title={plan.label}
								detail={
									plan.trialEndsOn
										? `A trial, until ${plan.trialEndsOn}.`
										: plan.trialEnded
											? "The trial has ended, so the organisation is now on Free."
											: undefined
								}
							/>
							<LedgerRow
								title={`${plan.used} of ${plan.seats} seats used`}
								detail={
									plan.warning ??
									"Each member holds a seat, and so does each invitation not yet accepted."
								}
							/>
						</LedgerRows>
					</Ledger>
				)}
				{owners && (
					<Ledger heading="For owners only">
						<LedgerRows>
							<LedgerRow
								title={
									<Link to={`${home}/${SUPPORT_ACCESS_SEGMENT}`} className={TEXT_LINK}>
										Support access
									</Link>
								}
								detail={
									owners.supportGrantedUntil
										? `Granted until ${owners.supportGrantedUntil}.`
										: "Not granted. Timesifier cannot read your organisation."
								}
							/>
							<LedgerRow
								title={
									<Link to={`${home}/${WELLBEING_SEGMENT}`} className={TEXT_LINK}>
										Wellbeing
									</Link>
								}
								detail="Rough signs of overwork and missed rest across your people, with no names."
							/>
						</LedgerRows>
					</Ledger>
				)}
			</div>
		</Section>
	);
}

/** A cap in minutes as the rules section shows it: "2:00", or "No cap". */
const capText = (minutes: number | null) =>
	minutes === null ? "No cap" : formatDuration(minutes * 60);

/**
 * The timesheet rules (TS-090, TS-095): whether time past a day's expected
 * hours is overtime that is not allowed, allowed, or allowed only with
 * pre-approval, with an optional cap a day and a week; whether time on a day
 * the working week does not work counts as overtime or is not allowed; and
 * whether leave asked for at short notice is allowed with a reason. One sheet
 * changes them all.
 */
function RulesSection({
	rules,
	onDone,
}: {
	rules: TimesheetRules;
	onDone: (said: string) => void;
}) {
	const [isOpen, setOpen] = useState(false);
	const close = () => setOpen(false);
	const caps =
		rules.overtime === "none"
			? ""
			: ` Cap: ${capText(rules.overtimeDayCap)} a day, ${capText(rules.overtimeWeekCap)} a week.`;

	return (
		<Section
			id="timesheet-rules"
			heading="Timesheet rules"
			lead="Expected hours are a ceiling: what people may track beyond them, and how leave asked for at short notice is treated. They apply to everyone in the organisation."
			className="max-w-200"
		>
			<Ledger heading="Rules">
				<LedgerRows label="Timesheet rules">
					<LedgerRow
						title={OVERTIME_RULE_LABELS[rules.overtime]}
						detail={`Overtime. Time past a day's expected hours, recorded as overtime.${caps}`}
					/>
					<LedgerRow
						title={NON_WORKING_RULE_LABELS[rules.weekend]}
						detail="Weekend and non-working days. Time on a day the working week has no hours for."
					/>
					<LedgerRow
						title={SHORT_NOTICE_LABELS[rules.shortNotice]}
						detail="Short-notice leave requests. Leave asked for with less notice than its kind needs."
					/>
				</LedgerRows>
			</Ledger>
			<div className="mt-4">
				<Button variant="outlined" onPress={() => setOpen(true)}>
					Change timesheet rules
				</Button>
			</div>

			<FormSheet
				title="Change the timesheet rules"
				intent="timesheet-rules"
				submitLabel="Save"
				isOpen={isOpen}
				onClose={close}
				onDone={onDone}
			>
				<p>
					A day takes its expected hours: the working week, less leave and public holidays. Time
					past them is entered as overtime, where overtime is allowed.
				</p>
				<RadioGroup label="Overtime" name="overtime" defaultValue={rules.overtime} isRequired>
					{OVERTIME_RULES.map((rule) => (
						<Radio key={rule} value={rule}>
							{OVERTIME_RULE_LABELS[rule]}
						</Radio>
					))}
				</RadioGroup>
				<div className="grid grid-cols-2 gap-4">
					<TextField
						label="Overtime cap a day"
						name="overtimeDayCap"
						description="Hours, as 2 or 1:30. Empty is no cap."
						defaultValue={
							rules.overtimeDayCap === null ? "" : formatDuration(rules.overtimeDayCap * 60)
						}
						inputMode="decimal"
						autoComplete="off"
						maxLength={6}
					/>
					<TextField
						label="Overtime cap a week"
						name="overtimeWeekCap"
						description="Hours, as 10 or 7:30. Empty is no cap."
						defaultValue={
							rules.overtimeWeekCap === null ? "" : formatDuration(rules.overtimeWeekCap * 60)
						}
						inputMode="decimal"
						autoComplete="off"
						maxLength={6}
					/>
				</div>
				<RadioGroup
					label="Weekend and non-working days"
					name="weekend"
					defaultValue={rules.weekend}
					isRequired
				>
					{NON_WORKING_RULES.map((rule) => (
						<Radio key={rule} value={rule}>
							{NON_WORKING_RULE_LABELS[rule]}
						</Radio>
					))}
				</RadioGroup>
				<p>
					Pre-approval is asked for on Time off and decided like leave. A short-notice request needs
					a one-line reason, and its approver sees it marked.
				</p>
				<RadioGroup
					label="Short-notice leave requests"
					name="shortNotice"
					defaultValue={rules.shortNotice}
					isRequired
				>
					{SHORT_NOTICE_RULES.map((rule) => (
						<Radio key={rule} value={rule}>
							{SHORT_NOTICE_LABELS[rule]}
						</Radio>
					))}
				</RadioGroup>
			</FormSheet>
		</Section>
	);
}

/**
 * Whether Clients is shown, a switch that takes effect at once. Off, nobody is
 * shown Clients or a project's client; nothing is deleted (TS-048).
 */
function ClientsRow({
	enabled,
	canChange,
	onDone,
}: {
	enabled: boolean;
	canChange: boolean;
	onDone: (said: string) => void;
}) {
	const fetcher = useFetcher<Outcome>();
	// While the change is on its way, the switch shows what was asked for.
	const asked = fetcher.formData?.get("intent") === "clients";
	const on = asked ? fetcher.formData?.get("clientsEnabled") === "on" : enabled;
	const answer = fetcher.state === "idle" ? fetcher.data : undefined;
	// The answer to one change is told once.
	useEffect(() => {
		if (answer?.ok) onDone(answer.said);
	}, [answer, onDone]);

	return (
		<LedgerRow
			title={
				<Switch
					isSelected={on}
					isReadOnly={!canChange}
					onChange={(selected) =>
						fetcher.submit(
							selected ? { intent: "clients", clientsEnabled: "on" } : { intent: "clients" },
							{ method: "post" },
						)
					}
				>
					Clients
				</Switch>
			}
			detail={
				<>
					Shows Clients to owners and admins, and each project's client to everyone. Turning it off
					hides them and deletes nothing.
					{answer && !answer.ok && (
						<span role="alert" className="block text-error">
							{answer.problem}
						</span>
					)}
				</>
			}
		/>
	);
}
