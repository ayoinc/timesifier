import { env } from "cloudflare:workers";
import { useEffect, useRef, useState } from "react";
import { Link, redirect, useFetcher } from "react-router";
import * as z from "zod";

import { BrandSettings } from "~/brand/BrandSettings";
import { BRAND_FORMS, brandAction, brandData, SETTINGS_MAX_BYTES } from "~/brand/settings.server";
import { Button } from "~/components/Button";
import { Checkbox } from "~/components/Checkbox";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Radio, RadioGroup } from "~/components/Radio";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { keepCategory, listCategories } from "~/expenses/categories.server";
import { ExpenseCategories } from "~/expenses/ExpenseCategories";
import { termsOf } from "~/expenses/expenses.server";
import { EVERYTHING_EXPORT_SEGMENT, EXPORT_KEEP_DAYS } from "~/exports/paths";
import { DPA_PATH } from "~/landing/Site";
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
	nextMondayAfter,
	OVERTIME_RULE_LABELS,
	OVERTIME_RULES,
	OvertimeRule,
	type RulesVersion,
	SHORT_NOTICE_LABELS,
	SHORT_NOTICE_RULES,
	ShortNoticeRule,
	type TimesheetRules,
} from "~/leave/rules";
import {
	nextRulesOf,
	rulesEffectOf,
	rulesSavedSentence,
	setTimesheetRules,
	timesheetRulesOf,
} from "~/leave/rules.server";
import { CODE_MAX_LENGTH, PATTERN_PROBLEM, parsePattern } from "~/lib/codes";
import { parseRequest } from "~/lib/validate";
import { LockSettings } from "~/locks/LockSettings";
import { LOCK_FORMS, lockAction, lockingData } from "~/locks/settings.server";
import { CurrencyCode } from "~/money/money";
import { isAdministrator } from "~/organisations/access";
import { deleteOrganisation, renameOrganisation } from "~/organisations/api.server";
import { acceptDpa, dpaToAccept } from "~/organisations/dpa.server";
import { membershipContext } from "~/organisations/membership.server";
import { NAME_MAX_LENGTH, Name, nameProblem } from "~/organisations/name";
import { declined, done, refused } from "~/organisations/outcome.server";
import { AS_ROLE } from "~/organisations/people";
import { NOT_ALLOWED, type Outcome } from "~/organisations/problems";
import { allows } from "~/organisations/roles";
import { policyWords } from "~/organisations/sign-in-policy";
import { WeekStart } from "~/periods/periods";
import { weekStartRefusal } from "~/periods/submission.server";
import { planStanding } from "~/plans/plans.server";
import { SUPPORT_ACCESS_SEGMENT, WELLBEING_SEGMENT } from "~/platform/paths";
import { activeGrant } from "~/platform/support.server";
import { MoneySettings, ownCurrencyHolders } from "~/projects/MoneySettings";
import { organisationMoney } from "~/projects/money.server";
import { projectCodeRules } from "~/projects/projects.server";
import {
	PROJECT_TRACKING_HINTS,
	PROJECT_TRACKING_LABELS,
	PROJECT_TRACKINGS,
	ProjectTracking,
} from "~/projects/teams";
import { trackingOf } from "~/projects/teams.server";
import { CapHours, defaultScheduleSummary } from "~/schedules/forms";
import { scheduleBookOf } from "~/schedules/schedules.server";
import {
	APP_PATH,
	destination,
	organisationPath,
	schedulesPath,
	signInSettingsPath,
} from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading, Section } from "~/shell/PageHeading";
import { Day, dayOf } from "~/time/calendar";
import { formatDayAndTime, formatDayWithYear, formatDuration } from "~/time/format";
import { TimeZone } from "~/time/zones";
import { zoneOfMember } from "~/time/zones.server";
import { WEEKDAYS, weekdayName, zoneLabel } from "~/workspace/general";
import { changeGeneral, timeZones } from "~/workspace/general.server";
import {
	DEFAULT_INTERNAL_TERM,
	INTERNAL_TERM_MAX_LENGTH,
	INTERNAL_TERM_PROBLEM,
	InternalTerm,
	WORK_MODEL_HINTS,
	WORK_MODEL_LABELS,
	WORK_MODELS,
	WorkModel,
	termsOf as workTerms,
} from "~/workspace/work-model";

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
	const today = dayOf(now.getTime(), organisation.timeZone);
	const isOwner = role === "owner";
	const [
		book,
		kinds,
		holidays,
		rules,
		next,
		categories,
		terms,
		locking,
		standing,
		grant,
		dpaToSign,
		codes,
		projectTracking,
	] = await Promise.all([
		scheduleBookOf(scope),
		leaveKindsOf(scope),
		publicHolidaysOf(scope),
		timesheetRulesOf(organisation.id, today),
		nextRulesOf(organisation.id, today),
		listCategories(scope),
		termsOf(organisation.id),
		lockingData(organisation, now.getTime()),
		planStanding(organisation.id, now),
		// Support access is the owners' alone, so nobody else is told whether it is granted.
		isOwner ? activeGrant(scope, now) : null,
		// So is accepting the data processing agreement (TS-105).
		isOwner ? dpaToAccept(organisation.id) : false,
		projectCodeRules(organisation.id),
		trackingOf(scope),
	]);
	return {
		organisation: {
			name: organisation.name,
			role,
			timeZone: organisation.timeZone,
			weekStartsOn: organisation.weekStartsOn,
			workModel: organisation.workModel,
			internalTerm: organisation.internalTerm,
			/** Who may track time to a project (TS-115c). */
			projectTracking,
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
		rules: {
			now: rules,
			/** A dated change still to come (TR-10), which the sheet opens on. */
			next,
			/** The day a change applies from unless the admin chooses another: next week's first day. */
			from: next?.effectiveFrom ?? nextMondayAfter(today),
		},
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
		/** How people sign in (TS-104), in a sentence; Settings › Sign-in changes it. */
		signIn: policyWords(organisation.signIn),
		/** Support access and wellbeing, which only owners open (TS-099). */
		owners: isOwner
			? {
					supportGrantedUntil: grant
						? formatDayAndTime(grant.expiresAt.getTime(), await zoneOfMember(membership))
						: null,
				}
			: null,
		/** Whether an owner is asked to accept this version of the data processing agreement (TS-105). */
		dpaToAccept: dpaToSign,
		/** Whether every project needs a code, and the pattern they are numbered by (TS-115a). */
		codes,
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
	z.object({
		intent: z.literal("work-model"),
		workModel: WorkModel,
		// Checked by `InternalTerm`, in the page's words.
		internalTerm: z.string().max(200),
	}),
	z.object({
		intent: z.literal("project-codes"),
		required: Ticked,
		// Under Both: whether every work code needs a code too.
		workCodeRequired: Ticked,
		// Checked by `parsePattern`, in the page's words; empty is none.
		pattern: z.string().max(200),
	}),
	z.object({ intent: z.literal("project-tracking"), projectTracking: ProjectTracking }),
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
		// The day the rules apply from (TR-10); empty is the Monday of next week.
		from: z.preprocess((value) => (value === "" ? undefined : value), Day.optional()),
	}),
	z.object({
		intent: z.literal("add-holiday"),
		day: Day,
		name: LeaveName,
		// Confirms that time already tracked on the day stands (TR-10).
		keepTime: Ticked,
	}),
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
	z.object({ intent: z.literal("accept-dpa") }),
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
		case "week-start": {
			if (!allows(role, { organization: ["update"] })) return declined(NOT_ALLOWED, 403);
			if (input.intent === "time-zone") {
				await changeGeneral(env.DB, organisation.id, { timeZone: input.timeZone }, user.id);
				return done(`The default time zone is now ${zoneLabel(input.timeZone)}.`);
			}
			const waiting =
				input.weekStartsOn === organisation.weekStartsOn
					? null
					: await weekStartRefusal(organisationScope(env.DB, organisation.id));
			if (waiting) return declined(waiting, 409);
			await changeGeneral(env.DB, organisation.id, { weekStartsOn: input.weekStartsOn }, user.id);
			return done(`Weeks now start on ${weekdayName(input.weekStartsOn)}.`);
		}

		case "work-model": {
			if (!allows(role, { organization: ["update"] })) return declined(NOT_ALLOWED, 403);
			const term = InternalTerm.safeParse(input.internalTerm);
			if (!term.success) return declined(INTERNAL_TERM_PROBLEM);
			await changeGeneral(
				env.DB,
				organisation.id,
				{ workModel: input.workModel, internalTerm: term.data },
				user.id,
			);
			return done(`How you work is now ${WORK_MODEL_LABELS[input.workModel]}.`);
		}

		case "project-tracking": {
			// Who tracks time to a project (TS-115c, decision 75): recorded in Activity as any setting.
			if (!allows(role, { organization: ["update"] })) return declined(NOT_ALLOWED, 403);
			await changeGeneral(
				env.DB,
				organisation.id,
				{ projectTracking: input.projectTracking },
				user.id,
			);
			return done(
				input.projectTracking === "assigned"
					? "Only the people on a project's team track time to it now."
					: "Anyone in the organisation tracks time to any active project now.",
			);
		}

		case "project-codes": {
			if (!allows(role, { organization: ["update"] })) return declined(NOT_ALLOWED, 403);
			const pattern = input.pattern.trim() === "" ? null : input.pattern.trim();
			if (pattern !== null && parsePattern(pattern) === null) return declined(PATTERN_PROBLEM);
			// The work codes' own rule is offered, and so read, only under Both.
			const both = organisation.workModel === "both";
			await changeGeneral(
				env.DB,
				organisation.id,
				{
					projectCodeRequired: input.required,
					projectCodePattern: pattern,
					...(both ? { workCodeRequired: input.workCodeRequired } : {}),
				},
				user.id,
			);
			// The internal term in a sentence's words, as Internal work would say it.
			const workCodes = workTerms("internal", organisation.internalTerm);
			return done(
				[
					pattern
						? `New projects without a code are numbered from ${pattern}.`
						: input.required
							? "Every new project needs a code."
							: "Project codes are optional.",
					...(both
						? [
								input.workCodeRequired
									? `Every new ${workCodes.project} needs a code.`
									: `Codes for ${workCodes.projects} are optional.`,
							]
						: []),
				].join(" "),
			);
		}

		case "currency":
		case "budget-hours": {
			if (!allows(role, { organization: ["update"] })) return declined(NOT_ALLOWED, 403);
			if (input.intent === "currency") {
				await changeGeneral(env.DB, organisation.id, { currency: input.currency }, user.id);
				const terms = workTerms(organisation.workModel, organisation.internalTerm);
				return done(
					`Amounts are now in ${input.currency} unless ${ownCurrencyHolders(terms)} has its own.`,
				);
			}
			const counts = input.countNonBillable === "on";
			await changeGeneral(env.DB, organisation.id, { budgetCountsNonBillable: counts }, user.id);
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
				const changed = await changeKind(scope, user.id, input.kindId, {
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
				const added = await addPublicHoliday(
					scope,
					user.id,
					{ day: input.day, name: input.name },
					input.keepTime,
				);
				if (added.ok) {
					return done(
						added.kept === null
							? `${input.name} is a public holiday.`
							: `${input.name} is a public holiday. The time already tracked on it stands: ${added.kept}.`,
					);
				}
				return added.reason === "exists"
					? declined("There is already a public holiday on that day.", 409)
					: declined(
							`${added.held}. To make it a public holiday and keep that time, tick "Keep the time already tracked on it".`,
							409,
						);
			}
			return (await removePublicHoliday(scope, user.id, input.holidayId))
				? done("Public holiday removed.")
				: declined("That public holiday is no longer there.", 404);
		}

		case "timesheet-rules": {
			if (!isAdministrator(role)) return declined(NOT_ALLOWED, 403);
			const from = input.from ?? nextMondayAfter(dayOf(Date.now(), organisation.timeZone));
			const next = {
				overtime: input.overtime,
				weekend: input.weekend,
				overtimeDayCap: input.overtimeDayCap,
				overtimeWeekCap: input.overtimeWeekCap,
			};
			const before = await timesheetRulesOf(organisation.id, from);
			const dated = (Object.keys(next) as (keyof typeof next)[]).some(
				(field) => before[field] !== next[field],
			);
			const effect = dated
				? await rulesEffectOf(organisationScope(env.DB, organisation.id), from, next, Date.now())
				: null;
			await setTimesheetRules(
				organisation.id,
				user.id,
				{ ...next, shortNotice: input.shortNotice },
				from,
			);
			return done(rulesSavedSentence(from, effect));
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
		case "accept-dpa": {
			// Only an owner accepts the agreement for the organisation (TS-105).
			if (role !== "owner") return declined(NOT_ALLOWED, 403);
			await acceptDpa(organisation.id, user.id, new Date());
			return done(`The data processing agreement is accepted for ${organisation.name}.`);
		}
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
type Task =
	| "rename"
	| "time-zone"
	| "week-start"
	| "work-model"
	| "project-tracking"
	| "project-codes"
	| "delete";

export default function Settings({ loaderData, params }: Route.ComponentProps) {
	const { organisation, zones, leave, rules, expenses, locking } = loaderData;
	const [task, setTask] = useState<Task | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	useDpaAnswer(setSaid);
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

			{loaderData.dpaToAccept && <DpaToAccept organisationName={organisation.name} />}

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
					</LedgerRows>
				</Ledger>
			</Section>

			{/* How the organisation works, and its project codes (TS-115a, decision 67). */}
			<Section
				id="how-you-work"
				heading="How you work"
				lead="Where your time goes, and the codes it carries."
				className="max-w-200"
			>
				<Ledger heading="How you work">
					<LedgerRows>
						<LedgerRow
							title={WORK_MODEL_LABELS[organisation.workModel]}
							detail={
								organisation.workModel === "client_projects"
									? "Clients, their projects, invoices and estimates."
									: organisation.workModel === "internal"
										? `No invoices or estimates. Time goes to ${workTerms("internal", organisation.internalTerm).projects}.`
										: `Clients and their projects, and ${workTerms("internal", organisation.internalTerm).projects} for internal time that bills nobody.`
							}
							action={change("work-model", "how you work")}
						/>
						<LedgerRow
							title={PROJECT_TRACKING_LABELS[organisation.projectTracking]}
							detail={PROJECT_TRACKING_HINTS[organisation.projectTracking]}
							action={change("project-tracking", "who tracks time")}
						/>
						<LedgerRow
							title={
								loaderData.codes.pattern
									? `Numbered from ${loaderData.codes.pattern}`
									: loaderData.codes.required
										? "Required"
										: "Optional"
							}
							detail={
								organisation.workModel === "internal"
									? `Codes for ${workTerms("internal", organisation.internalTerm).projects}, such as OPS-01, shown first wherever one appears.`
									: "Codes, such as ACME-001, shown first wherever a client or a project appears."
							}
							action={change("project-codes", "the codes")}
						/>
						{organisation.workModel === "both" && (
							<LedgerRow
								title={loaderData.codes.workCodeRequired ? "Required" : "Optional"}
								detail={`Codes for ${workTerms("internal", organisation.internalTerm).projects}, such as OPS-01, typed for each: the pattern numbers projects only.`}
								action={change(
									"project-codes",
									`the codes of ${workTerms("internal", organisation.internalTerm).projects}`,
								)}
							/>
						)}
					</LedgerRows>
				</Ledger>
			</Section>

			{/* Company sign-in and the verified domains (TS-104), on a page of their own. */}
			<Section id="sign-in" heading="Sign-in" lead={loaderData.signIn} className="max-w-200">
				<Ledger heading="Sign-in">
					<LedgerRows>
						<LedgerRow
							title={
								<Link to={signInSettingsPath(params.organisation)} className={TEXT_LINK}>
									Company sign-in and domains
								</Link>
							}
							detail={
								organisation.role === "owner"
									? "Require Google or Microsoft sign-in, and verify the domains your people's addresses are at."
									: "Require Google or Microsoft sign-in. Owners verify the organisation's domains."
							}
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
				terms={workTerms(organisation.workModel, organisation.internalTerm)}
				canChange={organisation.canChange}
				onDone={setSaid}
			/>

			<LeaveSettings data={leave} onDone={setSaid} />

			<LockSettings data={locking} onDone={setSaid} />

			<RulesSection {...rules} onDone={setSaid} />

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

			<WorkModelSheet
				isOpen={task === "work-model"}
				onClose={close}
				onDone={setSaid}
				workModel={organisation.workModel}
				internalTerm={organisation.internalTerm}
			/>

			<FormSheet
				title="Change who tracks time"
				intent="project-tracking"
				submitLabel="Save"
				isOpen={task === "project-tracking"}
				onClose={close}
				onDone={setSaid}
			>
				<RadioGroup
					label="Who tracks time"
					name="projectTracking"
					defaultValue={organisation.projectTracking}
				>
					{PROJECT_TRACKINGS.map((tracking) => (
						<Radio key={tracking} value={tracking} hint={PROJECT_TRACKING_HINTS[tracking]}>
							{PROJECT_TRACKING_LABELS[tracking]}
						</Radio>
					))}
				</RadioGroup>
				<p>Time already tracked stays as it is. A project's team is on its page, under Team.</p>
			</FormSheet>

			<FormSheet
				title="Change the codes"
				intent="project-codes"
				submitLabel="Save"
				isOpen={task === "project-codes"}
				onClose={close}
				onDone={setSaid}
			>
				<p>
					A code is shown first wherever one appears, and in every export. Codes already given stay
					as they are.
				</p>
				<Checkbox name="required" value="on" defaultSelected={loaderData.codes.required}>
					{organisation.workModel === "both"
						? "Every new project has a code"
						: "Every new one has a code"}
				</Checkbox>
				{organisation.workModel === "both" && (
					<Checkbox
						name="workCodeRequired"
						value="on"
						defaultSelected={loaderData.codes.workCodeRequired}
					>
						{`Every new ${workTerms("internal", organisation.internalTerm).project} has a code`}
					</Checkbox>
				)}
				<TextField
					label="Number new ones from"
					name="pattern"
					defaultValue={loaderData.codes.pattern ?? ""}
					autoComplete="off"
					maxLength={CODE_MAX_LENGTH}
					validate={(typed) =>
						typed.trim() === "" || parsePattern(typed) ? null : PATTERN_PROBLEM
					}
					description="Optional, for example PRJ-0001. One left without a code takes the next number."
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
							<LedgerRow
								title={
									<Link to={`${home}/${EVERYTHING_EXPORT_SEGMENT}`} className={TEXT_LINK}>
										Export everything
									</Link>
								}
								detail={`One ZIP of everything your organisation holds, kept for ${EXPORT_KEEP_DAYS} days.`}
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
 * changes them all. The rules of a day apply from the day the admin chooses,
 * next week's first day unless another, so the days before keep theirs
 * (TR-10): the rules in force today are shown, and a change still to come.
 */
function RulesSection({
	now: rules,
	next,
	from,
	onDone,
}: {
	now: TimesheetRules;
	next: RulesVersion | null;
	from: Day;
	onDone: (said: string) => void;
}) {
	const [isOpen, setOpen] = useState(false);
	const close = () => setOpen(false);
	const caps =
		rules.overtime === "none"
			? ""
			: ` Cap: ${capText(rules.overtimeDayCap)} a day, ${capText(rules.overtimeWeekCap)} a week.`;
	// The sheet opens on the change still to come, which saving from its day replaces.
	const sheet = next ? { ...rules, ...next } : rules;

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
					{next && (
						<LedgerRow
							title={`From ${formatDayWithYear(next.effectiveFrom)}`}
							detail={`Overtime: ${OVERTIME_RULE_LABELS[next.overtime]}${next.overtime === "none" ? "" : `, cap ${capText(next.overtimeDayCap)} a day and ${capText(next.overtimeWeekCap)} a week`}. Weekend and non-working days: ${NON_WORKING_RULE_LABELS[next.weekend]}.`}
						/>
					)}
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
				<TextField
					label="From"
					name="from"
					type="date"
					defaultValue={from}
					isRequired
					description="The overtime and weekend rules apply to the days from this one; the days before keep the rules they had. Next Monday unless you choose another day. Short-notice requests change at once."
				/>
				<RadioGroup label="Overtime" name="overtime" defaultValue={sheet.overtime} isRequired>
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
							sheet.overtimeDayCap === null ? "" : formatDuration(sheet.overtimeDayCap * 60)
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
							sheet.overtimeWeekCap === null ? "" : formatDuration(sheet.overtimeWeekCap * 60)
						}
						inputMode="decimal"
						autoComplete="off"
						maxLength={6}
					/>
				</div>
				<RadioGroup
					label="Weekend and non-working days"
					name="weekend"
					defaultValue={sheet.weekend}
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
 * The sheet that changes How you work (TS-115a, decision 67): the three
 * answers, and what internal work is called, which matters under Internal work
 * and Both. A change deletes nothing: clients, invoices and estimates come
 * back with clients.
 */
function WorkModelSheet({
	isOpen,
	onClose,
	onDone,
	workModel,
	internalTerm,
}: {
	isOpen: boolean;
	onClose: () => void;
	onDone: (said: string) => void;
	workModel: WorkModel;
	internalTerm: string;
}) {
	const [chosen, setChosen] = useState<WorkModel>(workModel);
	return (
		<FormSheet
			title="Change how you work"
			intent="work-model"
			submitLabel="Save"
			isOpen={isOpen}
			onClose={onClose}
			onDone={onDone}
		>
			<RadioGroup
				label="How you work"
				name="workModel"
				value={chosen}
				onChange={(value) => setChosen(WorkModel.parse(value))}
			>
				{WORK_MODELS.map((model) => (
					<Radio key={model} value={model} hint={WORK_MODEL_HINTS[model]}>
						{WORK_MODEL_LABELS[model]}
					</Radio>
				))}
			</RadioGroup>
			{chosen === "client_projects" ? (
				<input type="hidden" name="internalTerm" value={internalTerm} />
			) : (
				<TextField
					label="What you call internal work"
					name="internalTerm"
					defaultValue={internalTerm}
					autoComplete="off"
					isRequired
					maxLength={INTERNAL_TERM_MAX_LENGTH}
					validate={(typed) =>
						InternalTerm.safeParse(typed).success ? null : INTERNAL_TERM_PROBLEM
					}
					description={`In the plural, for example ${DEFAULT_INTERNAL_TERM} or Cost centres.`}
				/>
			)}
			<p>
				Nothing is deleted. Clients, invoices and estimates come back when you work with clients
				again.
			</p>
		</FormSheet>
	);
}

/** The fetcher of "Accept the agreement": the ask and the page that holds it read the same one. */
const ACCEPT_DPA = "settings-accept-dpa";

/**
 * What accepting the agreement did, for the page. The ask is gone by the time
 * the answer is read, with the button that had the focus: the page says what
 * happened, and the focus goes to its heading.
 */
function useDpaAnswer(onSaid: (said: string) => void) {
	const fetcher = useFetcher<Outcome>({ key: ACCEPT_DPA });
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
 * The owners' one ask of an organisation that holds an older version of the
 * data processing agreement, or none (TS-105): read it and accept it. Nothing
 * waits on it, and once one owner has accepted, nobody is asked again.
 */
function DpaToAccept({ organisationName }: { organisationName: string }) {
	const fetcher = useFetcher<Outcome>({ key: ACCEPT_DPA });
	const answer = fetcher.state === "idle" ? fetcher.data : undefined;

	return (
		<section
			aria-labelledby="dpa-to-accept"
			className="mt-6 flex max-w-200 flex-col gap-3 rounded-medium bg-secondary-container px-5 py-4 text-on-secondary-container"
		>
			<h2 id="dpa-to-accept" className="text-title-medium">
				Accept the data processing agreement
			</h2>
			<p className="text-body-large">
				The{" "}
				<a href={DPA_PATH} className={TEXT_LINK}>
					data processing agreement
				</a>{" "}
				sets out how Timesifier processes the personal data in{" "}
				<span className="wrap-anywhere">{organisationName}</span> for it. As an owner, read it and
				accept it for the organisation. Nothing waits on it.
			</p>
			{answer && !answer.ok && (
				<p role="alert" className="text-body-medium text-error">
					{answer.problem}
				</p>
			)}
			<fetcher.Form method="post">
				<input type="hidden" name="intent" value="accept-dpa" />
				<Button type="submit" isPending={fetcher.state !== "idle"} pendingLabel="Accepting…">
					Accept the agreement
				</Button>
			</fetcher.Form>
		</section>
	);
}
