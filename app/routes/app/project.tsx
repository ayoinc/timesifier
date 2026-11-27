import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { type ReactNode, useState } from "react";
import { useLocale } from "react-aria";
import { Link, useNavigate } from "react-router";
import * as z from "zod";

import { AllocationUnit, amountText, parseAmount, SHARE_PROBLEMS } from "~/allocations/allocations";
import {
	changeShare,
	projectShares,
	removeShare,
	type ShareChange,
	setShare,
} from "~/allocations/allocations.server";
import { BillingType } from "~/billing/billable";
import { BudgetBar, budgetFigure } from "~/budgets/BudgetBar";
import { BudgetKind, isHoursBudget } from "~/budgets/budget";
import { managedClientIds, mayCreateProject } from "~/clients/managers.server";
import { Button } from "~/components/Button";
import { Checkbox } from "~/components/Checkbox";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { LinkTabs } from "~/components/LinkTabs";
import { Menu, MenuItem, MenuTrigger } from "~/components/Menu";
import { PeriodStepper } from "~/components/PeriodStepper";
import { Radio, RadioGroup } from "~/components/Radio";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { type OrganisationScope, organisationScope } from "~/db";
import { quantityText } from "~/invoices/lines";
import { CODE_PROBLEM, codedName, typedCode } from "~/lib/codes";
import { recordName } from "~/lib/names";
import { parseRequest } from "~/lib/validate";
import { isCurrencyCode } from "~/money/money";
import { moneyText, parseBudgetHours, parseMoney } from "~/money/typed";
import { mayManageRates, mayManageTasks, maySeeRates, timeScopeOf } from "~/organisations/access";
import { accessOf } from "~/organisations/access.server";
import { type Membership, membershipContext, notFound } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { NOT_ALLOWED } from "~/organisations/problems";
import {
	BILLING_TYPE_LABELS,
	BILLING_TYPE_MEANINGS,
	BUDGET_KIND_LABELS,
	CURRENCIES,
	CUSTOM_OVERTIME_RATE,
	INHERITED,
	NOT_A_MULTIPLIER,
	OVERTIME_RATE_CHOICES,
	overtimeRateText,
	parseOvertimeRate,
	RATE_MODE_LABELS,
	RATE_MODES,
} from "~/projects/billing";
import { DuplicateSheet } from "~/projects/DuplicateSheet";
import { organisationMoney, pricingOf } from "~/projects/money.server";
import { namesOf, projectCurrencies, projectPage, projectProfit } from "~/projects/project.server";
import {
	defaultRatesPath,
	PROJECT_PARAM,
	PROJECT_TABS,
	type ProjectTab,
	projectPath,
	projectTabIn,
} from "~/projects/projects";
import { offeredCopyName, projectCodeRules } from "~/projects/projects.server";
import { changeBilling, changeBudget, changeOvertimeRate } from "~/projects/settings.server";
import { TeamTab } from "~/projects/TeamTab";
import { NAMES_LEADS_ONLY, TEAM_PROBLEMS, TeamRole } from "~/projects/teams";
import {
	assignToTeam,
	changeStretch,
	mayManageTeam,
	mayNameDeliveryManagers,
	oversightOf,
	removeStretch,
	stretchOf,
	type TeamChange,
	teamTab,
} from "~/projects/teams.server";
import { WorkPackagesTab } from "~/projects/WorkPackagesTab";
import {
	WORK_PACKAGE_NAME_MAX_LENGTH,
	WorkPackageBudgetKind,
	WorkPackageState,
} from "~/projects/work-packages";
import {
	createWorkPackage,
	mayManageWorkPackages,
	setWorkPackageArchived,
	setWorkPackageState,
	updateWorkPackage,
	WORK_PACKAGE_PROBLEMS,
	type WorkPackageInput,
	workPackageOf,
	workPackagesOf,
	workPackagesTab,
} from "~/projects/work-packages.server";
import { resolveRate } from "~/rates/rates";
import { ratesForProject, setRate } from "~/rates/rates.server";
import { dayLabel } from "~/reports/format";
import { destination, destinationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { negotiateLocale } from "~/shell/locale";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { TagPicker } from "~/tags/TagPicker";
import { TagIds } from "~/tags/tags";
import { setProjectTags } from "~/tags/tags.server";
import {
	addTaskToProject,
	removeTaskFromProject,
	setProjectTaskBillable,
} from "~/tasks/tasks.server";
import { Day, dayOf } from "~/time/calendar";
import { hasClients, inTerms, termsOf } from "~/workspace/work-model";

import type { Route } from "./+types/project";
import { FormSheet } from "./FormSheet";
import { useOrganisation, useTerms } from "./useOrganisation";

// A project's own page (harvest-taste.md item 11): Overview, with its hours,
// what they are worth, its profit over a range (TS-071) and its budget; Tasks,
// its list and each task's hours; Team, the people who tracked time to it; and
// Settings, how it bills, its budget and its tags. Every member opens it, as
// every member sees Projects;
// the hours are those of the people whose time the viewer may see. Amounts,
// rates and a budget in fees are shown only to owners, admins and Finance
// (`maySeeRates`), who also set them (`mayManageRates`); owners and admins
// keep the project's tasks and tags (`mayManageTasks`).

const TAB_LABELS: Record<ProjectTab, string> = {
	overview: "Overview",
	tasks: "Tasks",
	"work-packages": "Work packages",
	team: "Team",
	settings: "Settings",
};

export function meta({ loaderData }: Route.MetaArgs) {
	const name = loaderData?.page.project.name ?? destination("projects").label;
	return [{ title: `${name} · Timesifier` }];
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const scope = organisationScope(env.DB, membership.organisation.id);
	const access = await accessOf(membership);
	const now = Date.now();
	const today = dayOf(now, membership.organisation.timeZone);
	const projectId = params[PROJECT_PARAM];
	// Its delivery managers and its client's account managers oversee it (TS-115c).
	const { led, overseen } = await oversightOf(scope, membership.user.id, today);
	const page = await projectPage(
		scope,
		membership,
		projectId,
		timeScopeOf(access),
		now,
		negotiateLocale(request.headers.get("Accept-Language")),
		overseen.has(projectId),
	);
	if (!page) throw notFound();
	const managesRates = mayManageRates(membership.role);
	const managesTasks = mayManageTasks(membership.role);
	const tabs = PROJECT_TABS.filter((tab) => tab !== "settings" || managesRates || managesTasks);
	const url = new URL(request.url);
	const asked = projectTabIn(url.searchParams);
	const tab = tabs.includes(asked) ? asked : "overview";
	const { organisation } = membership;
	const managed = hasClients(organisation.workModel)
		? await managedClientIds(scope, membership.user.id)
		: [];
	// Who may duplicate it follows who may create one for its client (decisions 42 and 65).
	const duplicates = mayCreateProject(membership.role, managed, page.project.client?.id ?? null);
	return {
		page,
		tab,
		tabs,
		managesRates,
		managesTasks,
		showsClients: hasClients(organisation.workModel),
		/** The name a copy of the project is offered (TS-122, S2-06) to those who may duplicate it; null to anyone else. */
		copyName: duplicates ? await offeredCopyName(scope, page.project.name) : null,
		/** The code rules its copy follows (TS-115a), for those who may duplicate it. */
		codes: duplicates ? await projectCodeRules(organisation.id) : null,
		// Read only for Overview, where it is shown, and only for those who see rates.
		// Read only for Overview, and not under Internal work, where nothing earns revenue (TS-115a).
		profit:
			tab === "overview" && hasClients(organisation.workModel)
				? await projectProfit(membership, page.project.id, url, now)
				: null,
		/** The Work packages tab (TS-115b), read only when it is shown. */
		workPackages:
			tab === "work-packages"
				? await packagesTab(scope, membership, page.project.id, now, {
						leads: led.has(projectId),
						oversees: overseen.has(projectId),
					})
				: null,
		/** The project's team (TS-115c), read only on the Team tab. */
		team: tab === "team" ? await teamWithShares() : null,
		today,
	};

	/** The Team tab with each person's time share (TS-116): all of them where the viewer sees the whole team, else their own. */
	async function teamWithShares() {
		const team = await teamTab(
			scope,
			{
				userId: membership.user.id,
				role: membership.role,
				managesTeams: membership.managesTeams,
				managed,
				leads: led.has(projectId),
				oversees: overseen.has(projectId),
			},
			{
				id: projectId,
				clientId: hasClients(organisation.workModel) ? (page?.project.client?.id ?? null) : null,
			},
			today,
		);
		const [shares, packages] = await Promise.all([
			projectShares(
				scope,
				projectId,
				today,
				organisation.weekStartsOn,
				team.seesAll ? undefined : membership.user.id,
			),
			team.manages ? workPackagesOf(scope, [projectId]) : undefined,
		]);
		return {
			...team,
			projectId,
			shares,
			/** The work packages a share may name: those still taking time. */
			packages: (packages?.get(projectId) ?? [])
				.filter((w) => w.state === "open" && w.archivedAt === null)
				.map((w) => ({ id: w.id, label: `${w.code} · ${w.name}` })),
		};
	}
}

/** The project's Work packages tab as `membership` is shown it. */
async function packagesTab(
	scope: OrganisationScope,
	membership: Membership,
	projectId: string,
	now: number,
	oversight: { leads: boolean; oversees: boolean },
) {
	const found = await projectCurrencies(scope, projectId);
	if (!found) throw notFound();
	const money = await organisationMoney(membership.organisation.id);
	return workPackagesTab(
		scope,
		{
			role: membership.role,
			managesTeams: membership.managesTeams,
			userId: membership.user.id,
			...oversight,
		},
		{ id: projectId, clientId: found.project.clientId },
		{
			now,
			money,
			pricing: await pricingOf(scope, money.currency),
			showsClients: hasClients(membership.organisation.workModel),
		},
	);
}

const Id = z.string().min(1).max(64);
const Ids = z
	.union([Id, z.array(Id).max(200)])
	.transform((value) => (Array.isArray(value) ? value : [value]));
const Typed = z.string().max(32);
const Flag = z
	.enum(["on", "true", "false", ""])
	.optional()
	.transform((value) => value === "on" || value === "true");

const form = z.discriminatedUnion("intent", [
	z.object({
		intent: z.literal("billing"),
		billingType: BillingType,
		rateMode: z.enum(RATE_MODES),
		fee: Typed.default(""),
		currency: z.string().max(8),
		rate: Typed.default(""),
	}),
	z.object({
		intent: z.literal("budget"),
		budgetKind: BudgetKind,
		amount: Typed.default(""),
		lineKey: Ids.optional(),
		lineAmount: z
			.union([Typed, z.array(Typed).max(200)])
			.optional()
			.transform((value) => (value === undefined ? [] : Array.isArray(value) ? value : [value])),
		resetsMonthly: Flag,
		alertPercent: Typed.default(""),
		warnMembers: Flag,
		includesExpenses: Flag,
	}),
	z.object({
		intent: z.literal("overtime-rate"),
		overtimeRate: z.enum([...OVERTIME_RATE_CHOICES, CUSTOM_OVERTIME_RATE]),
		customRate: Typed.default(""),
	}),
	z.object({ intent: z.literal("tags"), tagIds: TagIds }),
	z.object({ intent: z.literal("add-task"), taskId: Id }),
	z.object({ intent: z.literal("remove-task"), taskId: Id }),
	z.object({
		intent: z.literal("task-billable"),
		taskIds: Ids,
		billable: z.enum(["true", "false"]),
	}),
	z.object({
		intent: z.literal("wp-save"),
		workPackageId: z.string().max(64).default(""),
		code: z.string().max(64),
		name: z.string().max(200),
		startsOn: z.union([Day, z.literal("")]).default(""),
		endsOn: z.union([Day, z.literal("")]).default(""),
		budgetKind: WorkPackageBudgetKind.optional(),
		budgetAmount: Typed.default(""),
		billable: Flag,
	}),
	z.object({ intent: z.literal("wp-state"), workPackageId: Id, state: WorkPackageState }),
	z.object({
		intent: z.literal("wp-archive"),
		workPackageId: Id,
		archived: z.enum(["true", "false"]),
	}),
	z.object({
		intent: z.literal("team-assign"),
		userId: Id,
		role: TeamRole,
		startsOn: Day,
		endsOn: z.union([Day, z.literal("")]).default(""),
	}),
	z.object({
		intent: z.literal("team-end"),
		stretchId: Id,
		endsOn: z.union([Day, z.literal("")]).default(""),
	}),
	z.object({ intent: z.literal("team-role"), stretchId: Id, role: TeamRole, from: Day }),
	z.object({ intent: z.literal("team-remove"), stretchId: Id }),
	// A person's time share (TS-116): set, changed from a day, ended, or removed.
	z.object({
		intent: z.literal("share-set"),
		userId: Id,
		workPackageId: z.union([Id, z.literal("")]).default(""),
		amount: Typed,
		unit: AllocationUnit,
		startsOn: Day,
		endsOn: z.union([Day, z.literal("")]).default(""),
	}),
	z.object({
		intent: z.literal("share-change"),
		shareId: Id,
		amount: Typed,
		unit: AllocationUnit,
		from: Day,
	}),
	z.object({
		intent: z.literal("share-end"),
		shareId: Id,
		endsOn: z.union([Day, z.literal("")]).default(""),
	}),
	z.object({ intent: z.literal("share-remove"), shareId: Id }),
	z.object({
		intent: z.literal("rate"),
		level: z.enum(["project", "project-person", "project-task"]),
		key: z.string().max(64).default(""),
		amount: Typed,
		from: Day,
	}),
]);

const NOT_AN_AMOUNT = "Type an amount such as 85 or 85.50.";

/**
 * Changes the project in the address: how it bills, its budget, its tags,
 * its tasks or a rate. A project of another organisation is no project here,
 * so it answers 404 and nothing changes; a role that may not make the change
 * is refused with 403.
 */
export async function action({ request, params, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const membership = context.get(membershipContext);
	const { role, user, organisation } = membership;
	const scope = organisationScope(env.DB, organisation.id);
	const projectId = params[PROJECT_PARAM];
	const found = await projectCurrencies(scope, projectId);
	if (!found) throw notFound();
	const today = dayOf(Date.now(), organisation.timeZone);
	const { currency } = found;

	switch (input.intent) {
		case "billing": {
			if (!mayManageRates(role)) return declined(NOT_ALLOWED, 403);
			const own = input.currency === INHERITED ? null : input.currency;
			if (own !== null && !isCurrencyCode(own)) return declined("Choose a currency.");
			const billsIn = own ?? found.clientCurrency ?? found.organisationCurrency;
			let feeMinor: number | null = null;
			if (input.billingType === "fixed_fee") {
				feeMinor = parseMoney(input.fee, billsIn);
				if (feeMinor === null) return declined(`The fee: ${NOT_AN_AMOUNT}`);
			}
			let rateMinor: number | null = null;
			if (
				input.billingType !== "non_billable" &&
				input.rateMode === "project" &&
				input.rate.trim()
			) {
				rateMinor = parseMoney(input.rate, billsIn);
				if (rateMinor === null) return declined(`The rate: ${NOT_AN_AMOUNT}`);
			}
			const changed = await changeBilling(scope, user.id, projectId, {
				billingType: input.billingType,
				rateMode: input.rateMode,
				feeMinor,
				currency: own,
			});
			if (!changed) throw notFound();
			const inForce = resolveRate(
				(await ratesForProject(scope, projectId)).filter((r) => r.level === "project"),
				{ kind: "billable", projectId, userId: null, taskId: null, on: today },
			);
			if (
				rateMinor !== null &&
				(rateMinor !== inForce?.amountMinor || billsIn !== inForce.currency)
			) {
				const set = await setRate(
					scope,
					user.id,
					{ userId: null, projectId, taskId: null },
					{ amountMinor: rateMinor, currency: billsIn, effectiveFrom: today },
					today,
				);
				if (!set.ok) return declined(RATE_IN_FORCE, 409);
			}
			return done(`Billing saved: ${BILLING_TYPE_LABELS[input.billingType]}.`);
		}

		case "budget": {
			if (!mayManageRates(role)) return declined(NOT_ALLOWED, 403);
			const kind = input.budgetKind;
			const hours = kind !== "none" && isHoursBudget(kind);
			const read = (text: string) => (hours ? parseBudgetHours(text) : parseMoney(text, currency));
			let amount: number | null = null;
			if (kind === "total_hours" || kind === "total_fees") {
				amount = read(input.amount);
				if (amount === null) {
					return declined(hours ? "Type the budget in hours, such as 120 or 37.5." : NOT_AN_AMOUNT);
				}
			}
			const lines = new Map<string, number>();
			const keys = input.lineKey ?? [];
			for (const [at, key] of keys.entries()) {
				const typed = input.lineAmount[at] ?? "";
				if (typed.trim() === "") continue;
				const value = read(typed);
				if (value === null)
					return declined("Type each line's budget as a number, or leave it empty.");
				lines.set(key, value);
			}
			let alertPercent: number | null = null;
			if (input.alertPercent.trim() !== "") {
				alertPercent = Number(input.alertPercent);
				if (!Number.isInteger(alertPercent) || alertPercent < 1 || alertPercent > 1000) {
					return declined(
						"Type the alert as a whole percentage, from 1 to 1000, or leave it empty.",
					);
				}
			}
			const changed = await changeBudget(scope, user.id, projectId, {
				kind,
				amount,
				lines,
				resetsMonthly: input.resetsMonthly,
				alertPercent,
				warnMembers: input.warnMembers,
				includesExpenses: input.includesExpenses,
			});
			if (changed === null) throw notFound();
			if (!changed.ok) {
				return declined(
					changed.reason === "no-amount"
						? "Type the budget."
						: "A budget's lines are the project's tasks, or the organisation's people.",
				);
			}
			return done(
				kind === "none"
					? `The ${termsOf(membership.organisation.workModel, membership.organisation.internalTerm).project} has no budget.`
					: "Budget saved.",
			);
		}

		case "overtime-rate": {
			if (!mayManageRates(role)) return declined(NOT_ALLOWED, 403);
			const milli = parseOvertimeRate(
				input.overtimeRate === CUSTOM_OVERTIME_RATE ? input.customRate : input.overtimeRate,
			);
			if (milli === null) return declined(NOT_A_MULTIPLIER);
			const changed = await changeOvertimeRate(scope, user.id, projectId, milli);
			if (!changed) throw notFound();
			return done(`Overtime is billed at ${overtimeRateText(milli)} the day's rate.`);
		}

		case "tags": {
			if (!mayManageTasks(role)) return declined(NOT_ALLOWED, 403);
			const result = await setProjectTags(scope, user.id, projectId, input.tagIds ?? []);
			if (result === null) throw notFound();
			return result.ok ? done("Tags saved.") : declined(result.problem);
		}

		case "add-task": {
			if (!mayManageTasks(role)) return declined(NOT_ALLOWED, 403);
			const result = await addTaskToProject(scope, user.id, projectId, input.taskId);
			if (result === null) throw notFound();
			return result.ok ? done(`${result.name} is on this project.`) : declined(result.problem);
		}

		case "remove-task": {
			if (!mayManageTasks(role)) return declined(NOT_ALLOWED, 403);
			const result = await removeTaskFromProject(scope, user.id, projectId, input.taskId);
			if (result === null) throw notFound();
			return result.ok
				? done(`${result.name} is off this project. Its entries keep it.`)
				: declined(result.problem);
		}

		case "task-billable": {
			if (!mayManageTasks(role)) return declined(NOT_ALLOWED, 403);
			const billable = input.billable === "true";
			const result = await setProjectTaskBillable(
				scope,
				user.id,
				projectId,
				input.taskIds,
				billable,
			);
			if (result === null) throw notFound();
			if (!result.ok) return declined(result.problem);
			return done(
				billable
					? "Set billable. Their entries not yet invoiced are billable too."
					: "Set non-billable. Their entries not yet invoiced are non-billable too.",
			);
		}

		case "wp-save":
		case "wp-state":
		case "wp-archive": {
			// Decision 42's rule for the project's client (TS-115b), and its delivery managers (TS-115c).
			const { managed, clientId, leads } = await teamAuthority(
				scope,
				membership,
				found.project,
				today,
			);
			if (!mayManageWorkPackages(role, managed, clientId, leads)) return declined(NOT_ALLOWED, 403);
			return workPackageAction(input, {
				scope,
				actor: user.id,
				projectId,
				currency,
				seesRates: maySeeRates(role),
			});
		}

		case "team-assign":
		case "team-end":
		case "team-role":
		case "team-remove":
			return teamAction(input, {
				scope,
				actor: user.id,
				projectId,
				authority: await teamAuthority(scope, membership, found.project, today),
				role,
			});

		case "share-set":
		case "share-change":
		case "share-end":
		case "share-remove": {
			const { managed, clientId, leads } = await teamAuthority(
				scope,
				membership,
				found.project,
				today,
			);
			// Whoever manages the project's team sets its time shares (TS-116, decision 78).
			if (!mayManageTeam(role, managed, clientId, leads)) return declined(NOT_ALLOWED, 403);
			return shareAction(input, { scope, actor: user.id, projectId });
		}

		case "rate": {
			if (!mayManageRates(role)) return declined(NOT_ALLOWED, 403);
			const amountMinor = parseMoney(input.amount, currency);
			if (amountMinor === null) return declined(NOT_AN_AMOUNT);
			if (input.from < today) {
				return declined(
					"A rate starts today or later, so no entry already tracked is priced again.",
				);
			}
			const target =
				input.level === "project"
					? { userId: null, projectId, taskId: null }
					: input.level === "project-person"
						? { userId: input.key, projectId, taskId: null }
						: { userId: null, projectId, taskId: input.key };
			const known =
				input.level === "project" ||
				(input.level === "project-person"
					? (await scope.memberships.select((m) => eq(m.userId, input.key), { limit: 1 })).length >
						0
					: (
							await scope.projectTasks.select(
								(pt) => and(eq(pt.projectId, projectId), eq(pt.taskId, input.key)),
								{ limit: 1 },
							)
						).length > 0);
			if (!known) throw notFound();
			const set = await setRate(
				scope,
				user.id,
				target,
				{
					amountMinor,
					currency,
					effectiveFrom: input.from,
				},
				today,
			);
			return set.ok ? done("Rate saved.") : declined(RATE_IN_FORCE, 409);
		}
	}
}

/**
 * What `membership` may do with the project's work packages and team: the
 * clients they are an account manager of, the project's client where the
 * organisation shows clients, and whether they lead it (TS-115c).
 */
async function teamAuthority(
	scope: OrganisationScope,
	membership: Membership,
	project: { id: string; clientId: string | null },
	today: Day,
) {
	const showsClients = hasClients(membership.organisation.workModel);
	const [managed, { led }] = await Promise.all([
		showsClients ? managedClientIds(scope, membership.user.id) : [],
		oversightOf(scope, membership.user.id, today),
	]);
	return {
		managed,
		clientId: showsClients ? project.clientId : null,
		leads: led.has(project.id),
	};
}

/**
 * Assigns a person to the project's team, ends or changes a stretch, or takes
 * one away (TS-115c). Its delivery managers, owners, admins and the client's
 * account managers manage the team; only the last three name a delivery
 * manager or change one's stretch.
 */
async function teamAction(
	input: Extract<
		z.infer<typeof form>,
		{ intent: "team-assign" | "team-end" | "team-role" | "team-remove" }
	>,
	{
		scope,
		actor,
		projectId,
		authority: { managed, clientId, leads },
		role,
	}: {
		scope: OrganisationScope;
		actor: string;
		projectId: string;
		authority: Awaited<ReturnType<typeof teamAuthority>>;
		role: Membership["role"];
	},
) {
	if (!mayManageTeam(role, managed, clientId, leads)) return declined(NOT_ALLOWED, 403);
	const namesLeads = mayNameDeliveryManagers(role, managed, clientId);
	const stretch =
		input.intent === "team-assign" ? null : await stretchOf(scope, projectId, input.stretchId);
	if (input.intent !== "team-assign" && !stretch) throw notFound();
	const touchesLead =
		stretch?.role === "delivery_manager" ||
		((input.intent === "team-assign" || input.intent === "team-role") &&
			input.role === "delivery_manager");
	if (touchesLead && !namesLeads) return declined(NAMES_LEADS_ONLY, 403);
	const who = { userId: actor };
	const said = (change: TeamChange, sentence: string) => {
		if (change === null) throw notFound();
		return change.ok ? done(sentence) : declined(TEAM_PROBLEMS[change.problem]);
	};
	switch (input.intent) {
		case "team-assign": {
			const change = await assignToTeam(scope, who, {
				projectId,
				userId: input.userId,
				role: input.role,
				startsOn: input.startsOn,
				endsOn: input.endsOn || null,
			});
			const [name] = (await namesOf([input.userId])).values();
			return said(
				change,
				`${name ?? "They"} ${input.role === "delivery_manager" ? "leads" : "is on"} the team from ${dayLabel(input.startsOn)}${input.endsOn ? ` to ${dayLabel(input.endsOn)}` : ""}.`,
			);
		}
		case "team-end":
			return said(
				await changeStretch(scope, who, projectId, input.stretchId, {
					endsOn: input.endsOn || null,
				}),
				input.endsOn
					? `Their last day on the team is ${dayLabel(input.endsOn)}.`
					: "Their stretch runs on.",
			);
		case "team-role":
			return said(
				await changeStretch(scope, who, projectId, input.stretchId, {
					role: input.role,
					from: input.from,
				}),
				`From ${dayLabel(input.from)}, they are ${input.role === "delivery_manager" ? "a delivery manager" : "a member"} of the team.`,
			);
		case "team-remove":
			return said(
				await removeStretch(scope, who, projectId, input.stretchId),
				"Taken off the team.",
			);
	}
}

/** Sets, changes, ends or removes a person's time share of the project (TS-116). */
async function shareAction(
	input: Extract<
		z.infer<typeof form>,
		{ intent: "share-set" | "share-change" | "share-end" | "share-remove" }
	>,
	{ scope, actor, projectId }: { scope: OrganisationScope; actor: string; projectId: string },
) {
	const who = { userId: actor };
	const said = (change: ShareChange, sentence: string) => {
		if (change === null) throw notFound();
		return change.ok ? done(sentence) : declined(SHARE_PROBLEMS[change.problem]);
	};
	switch (input.intent) {
		case "share-set": {
			const amount = parseAmount(input.amount, input.unit);
			if (amount === null) return declined(SHARE_PROBLEMS.amount);
			const change = await setShare(scope, who, {
				projectId,
				workPackageId: input.workPackageId || null,
				userId: input.userId,
				startsOn: input.startsOn,
				endsOn: input.endsOn || null,
				amount,
				unit: input.unit,
			});
			const [name] = (await namesOf([input.userId])).values();
			return said(
				change,
				`${name ?? "They"}: ${amountText({ amount, unit: input.unit })} from ${dayLabel(input.startsOn)}${input.endsOn ? ` to ${dayLabel(input.endsOn)}` : ""}.`,
			);
		}
		case "share-change": {
			const amount = parseAmount(input.amount, input.unit);
			if (amount === null) return declined(SHARE_PROBLEMS.amount);
			return said(
				await changeShare(
					scope,
					who,
					input.shareId,
					{ amount, unit: input.unit, from: input.from },
					projectId,
				),
				`From ${dayLabel(input.from)}, ${amountText({ amount, unit: input.unit })}.`,
			);
		}
		case "share-end":
			return said(
				await changeShare(scope, who, input.shareId, { endsOn: input.endsOn || null }, projectId),
				input.endsOn
					? `The time share's last day is ${dayLabel(input.endsOn)}.`
					: "The time share runs on.",
			);
		case "share-remove":
			return said(await removeShare(scope, who, input.shareId, projectId), "Time share removed.");
	}
}

/** Adds, changes, closes, reopens, archives or restores one of the project's work packages (TS-115b). */
async function workPackageAction(
	input: Extract<z.infer<typeof form>, { intent: "wp-save" | "wp-state" | "wp-archive" }>,
	{
		scope,
		actor,
		projectId,
		currency,
		seesRates,
	}: {
		scope: OrganisationScope;
		actor: string;
		projectId: string;
		currency: string;
		seesRates: boolean;
	},
) {
	if (input.intent === "wp-state") {
		const set = await setWorkPackageState(
			scope,
			actor,
			projectId,
			input.workPackageId,
			input.state,
		);
		if (set === null) throw notFound();
		return done(
			input.state === "closed"
				? "Closed. It takes no new time; what it has stays."
				: "Reopened. It takes time again.",
		);
	}
	if (input.intent === "wp-archive") {
		const archived = input.archived === "true";
		const set = await setWorkPackageArchived(
			scope,
			actor,
			projectId,
			input.workPackageId,
			archived,
			Date.now(),
		);
		if (set === null) throw notFound();
		return done(archived ? "Archived. Its entries keep it." : "Restored.");
	}
	const code = typedCode(input.code);
	if (code === null || code === false) return declined(CODE_PROBLEM);
	const name = recordName(input.name);
	if (!name) return declined("Enter a name.");
	if (name.length > WORK_PACKAGE_NAME_MAX_LENGTH) {
		return declined(`Enter a name of up to ${WORK_PACKAGE_NAME_MAX_LENGTH} characters.`);
	}
	const existing =
		input.workPackageId === "" ? null : await workPackageOf(scope, projectId, input.workPackageId);
	if (input.workPackageId !== "" && !existing) throw notFound();
	let budget: WorkPackageInput["budget"] = null;
	if (input.budgetKind !== undefined) {
		// A budget in fees is money: set by those who see rates, and kept from those who do not.
		const fees = input.budgetKind === "fees" || existing?.budgetKind === "fees";
		if (fees && !seesRates) return declined(NOT_ALLOWED, 403);
		let amount: number | null = null;
		if (input.budgetKind === "hours") {
			amount = parseBudgetHours(input.budgetAmount);
			if (amount === null) return declined("Type the budget in hours, such as 120 or 37.5.");
		} else if (input.budgetKind === "fees") {
			amount = parseMoney(input.budgetAmount, currency);
			if (amount === null) return declined(`The budget: ${NOT_AN_AMOUNT}`);
		}
		budget = { kind: input.budgetKind, amount };
	} else if (!existing) {
		budget = { kind: "none", amount: null };
	}
	const fields: WorkPackageInput = {
		code,
		name,
		startsOn: input.startsOn || null,
		endsOn: input.endsOn || null,
		budget,
		billable: input.billable,
	};
	const saved = existing
		? await updateWorkPackage(scope, actor, projectId, existing.id, fields)
		: await createWorkPackage(scope, actor, projectId, fields);
	if (saved === null) throw notFound();
	if (!saved.ok) return declined(WORK_PACKAGE_PROBLEMS[saved.problem], 409);
	return done(existing ? `${code} ${name} saved.` : `${code} ${name} added.`);
}

const RATE_IN_FORCE =
	"That rate is in force, and entries are priced by it. Set a new rate from today or a later day instead.";

type Data = Route.ComponentProps["loaderData"];
type Page = Data["page"];

export default function Project({ loaderData }: Route.ComponentProps) {
	const { page, tab, tabs } = loaderData;
	const organisation = useOrganisation();
	const [said, setSaid] = useState<string | null>(null);
	const [duplicating, setDuplicating] = useState(false);
	const navigate = useNavigate();
	const { project } = page;
	const { terms } = organisation;

	return (
		<>
			<p className="text-body-large">
				<Link to={destinationPath(organisation.slug, "projects")} className={TEXT_LINK}>
					← {terms.Projects}
				</Link>
			</p>
			<PageHeading>{codedName(project.code, project.name)}</PageHeading>
			<PageLead>
				{[
					loaderData.showsClients
						? project.client
							? codedName(project.client.code, project.client.name)
							: "No client"
						: null,
					// Under Internal work nothing is billable, so nothing says how it bills (TS-115a).
					loaderData.showsClients ? BILLING_TYPE_LABELS[project.billingType] : null,
					project.archived ? "Archived" : null,
				]
					.filter(Boolean)
					.join(" · ")}
			</PageLead>
			{loaderData.copyName !== null && (
				<div className="mt-4">
					<MenuTrigger>
						<Button variant="outlined" aria-label={`Actions for ${project.name}`}>
							Actions
						</Button>
						<Menu
							onAction={(chosen) => {
								if (chosen === "duplicate") setDuplicating(true);
							}}
						>
							<MenuItem id="duplicate">Duplicate</MenuItem>
						</Menu>
					</MenuTrigger>
				</div>
			)}
			{/* The copy is made by Projects' action; its page opens once it is made. */}
			{loaderData.copyName !== null && loaderData.codes !== null && (
				<DuplicateSheet
					project={project}
					codes={loaderData.codes}
					offered={loaderData.copyName}
					isOpen={duplicating}
					onClose={() => setDuplicating(false)}
					onDone={(done, answer) => {
						setSaid(done);
						const copy = answer.changed?.[0];
						if (copy) navigate(projectPath(organisation.slug, copy));
					}}
					action={destinationPath(organisation.slug, "projects")}
				/>
			)}
			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>
			<div className="mt-6">
				<LinkTabs
					label={inTerms("Project pages", terms)}
					tabs={tabs.map((id) => ({
						id,
						label: TAB_LABELS[id],
						to: projectPath(organisation.slug, project.id, id),
					}))}
					current={tab}
					wraps
				/>
			</div>
			<div className="mt-8 max-w-200">
				{tab === "overview" && <Overview data={loaderData} />}
				{tab === "tasks" && <Tasks data={loaderData} onSaid={setSaid} />}
				{tab === "work-packages" && loaderData.workPackages && (
					<WorkPackagesTab
						tab={loaderData.workPackages}
						currency={page.project.currency}
						seesRates={page.seesRates}
						showsBilling={loaderData.showsClients && page.project.billingType !== "non_billable"}
						onSaid={setSaid}
					/>
				)}
				{tab === "team" && <Team data={loaderData} onSaid={setSaid} />}
				{tab === "settings" && <Settings data={loaderData} onSaid={setSaid} />}
			</div>
		</>
	);
}

function Overview({ data }: { data: Data }) {
	const { page } = data;
	const { locale } = useLocale();
	const organisation = useOrganisation();
	const t = (text: string) => inTerms(text, organisation.terms);
	const { budget } = page;
	return (
		<>
			<Ledger heading="Hours" note="To date">
				{/* Under Internal work nothing is billable: the hours are their total alone (TS-115a). */}
				{data.showsClients && (
					<LedgerRows label="Hours to date">
						<LedgerRow title="Billable" value={page.hours.billable} />
						<LedgerRow title="Non-billable" value={page.hours.nonBillable} />
						{page.amount !== null && (
							<LedgerRow title={`Billable amount, ${page.project.currency}`} value={page.amount} />
						)}
						{page.project.fee !== null && <LedgerRow title="Fixed fee" value={page.project.fee} />}
					</LedgerRows>
				)}
				<LedgerTotal label="Total hours" value={page.hours.total} />
			</Ledger>

			{data.profit && <Profit profit={data.profit} />}

			{budget && (
				<Section
					id="budget"
					heading="Budget"
					lead={`${BUDGET_KIND_LABELS[budget.kind]}, ${
						budget.period.endsOn === null
							? t("over the whole project")
							: `for ${dayLabel(budget.period.startsOn)} to ${dayLabel(budget.period.endsOn)}`
					}.${page.alertSentOn ? ` The alert went out on ${dayLabel(page.alertSentOn)}.` : ""}`}
				>
					{budget.whole ? (
						<div>
							<p className="flex flex-wrap justify-between gap-x-6 text-body-large">
								<span>
									{budgetFigure(budget, budget.whole.spent, locale)} spent of{" "}
									{budgetFigure(budget, budget.whole.amount, locale)}
								</span>
								<span className={budget.whole.over ? "text-error" : undefined}>
									{budget.whole.over
										? `${budgetFigure(budget, -budget.whole.remaining, locale)} over`
										: `${budgetFigure(budget, budget.whole.remaining, locale)} remaining`}
									{budget.whole.percent !== null && ` · ${budget.whole.percent}%`}
								</span>
							</p>
							<BudgetBar
								label="Budget spent"
								percent={budget.whole.percent}
								over={budget.whole.over}
							/>
						</div>
					) : (
						<p className="text-body-large text-on-surface-variant">
							No line has a budget yet.
							{data.managesRates && (
								<>
									{" "}
									<Link
										to={projectPath(organisation.slug, page.project.id, "settings")}
										className={TEXT_LINK}
									>
										Give each a budget
									</Link>
								</>
							)}
						</p>
					)}
					{budget.lines.length > 0 && (
						<div className="mt-6">
							<Ledger heading={budget.kind === "person_hours" ? "By person" : "By task"}>
								<LedgerRows label="Budget by line">
									{budget.lines.map((line) => (
										<LedgerRow
											key={line.key}
											title={<span className="wrap-anywhere">{line.name}</span>}
											detail={
												<BudgetBar
													label={`${line.name}: budget spent`}
													percent={line.percent}
													over={line.over}
												/>
											}
											value={`${budgetFigure(budget, line.spent, locale)} of ${budgetFigure(budget, line.amount, locale)}`}
										/>
									))}
								</LedgerRows>
							</Ledger>
						</div>
					)}
				</Section>
			)}

			{data.showsClients && page.missingRates && page.missingRates.count > 0 && (
				<Section
					id="missing-rates"
					heading="Missing rate"
					lead={`${page.missingRates.count} billable ${
						page.missingRates.count === 1 ? "entry has" : "entries have"
					} no rate. Each counts 0 in the amount until it has one.`}
				>
					<Ledger heading="Entries with no rate" note={page.missingRates.count}>
						<LedgerRows label="Entries with no rate">
							{page.missingRates.entries.map((entry) => (
								<LedgerRow
									key={entry.id}
									title={<span className="wrap-anywhere">{entry.person}</span>}
									detail={[dayLabel(entry.day), entry.task].filter(Boolean).join(" · ")}
									aside="Missing rate"
									value={entry.duration}
								/>
							))}
						</LedgerRows>
					</Ledger>
				</Section>
			)}
		</>
	);
}

/**
 * The project's revenue, cost, profit and margin over a range, for those who
 * see rates: its row of the Profitability report over the same range, which
 * it links to (TS-071).
 */
function Profit({ profit }: { profit: NonNullable<Data["profit"]> }) {
	const { figures } = profit;
	const terms = useTerms();
	return (
		<Section
			id="profit"
			heading="Profit"
			lead="Revenue less the cost of the time and the expenses, as the Profitability report counts them."
		>
			{profit.steps && (
				<div className="mb-4">
					<PeriodStepper
						label="Profit range"
						period={profit.range}
						previous={profit.steps.previous}
						next={profit.steps.next}
						current={profit.steps.current}
					/>
				</div>
			)}
			<Ledger heading={profit.range}>
				{figures ? (
					<>
						<LedgerRows label="Profit over the range">
							<LedgerRow
								title="Revenue"
								detail={figures.otherCurrency && `Billed in ${figures.otherCurrency}`}
								value={figures.revenue ?? "—"}
							/>
							<LedgerRow title="Cost" value={figures.cost} />
							<LedgerRow title="Margin" value={figures.margin} />
						</LedgerRows>
						<LedgerTotal label="Profit" value={figures.profit} />
					</>
				) : (
					<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
						{inTerms("No time, expenses or fee on this project in this range.", terms)}
					</p>
				)}
			</Ledger>
			{figures && (
				<div className="mt-4 flex flex-col gap-1 text-body-medium text-on-surface-variant empty:hidden">
					{figures.missingFeeOrDates && <p>Revenue unknown: the fee or the dates are missing.</p>}
					{figures.otherCurrency && (
						<p>Billed in {figures.otherCurrency}: no profit without a conversion.</p>
					)}
					{figures.missingRate && <p>{figures.missingRate} billable with no rate.</p>}
					{figures.missingCost && (
						<p>{figures.missingCost} with no cost rate counts as costing nothing.</p>
					)}
				</div>
			)}
			<p className="mt-4 text-body-large">
				<Link to={profit.report} className={TEXT_LINK}>
					Open profitability
				</Link>
			</p>
		</Section>
	);
}

/** A rate as a row of the page says it: the one in force, and any to come. */
function rateWords(rate: Page["projectRate"], fallback: Page["projectRate"] = null): ReactNode {
	const shown = rate?.current ?? null;
	const later = rate?.later ?? [];
	const parts = [
		shown
			? `${shown.amount} an hour`
			: fallback?.current
				? `${fallback.current.amount} an hour (default)`
				: "No rate",
		...later.map((l) => `${l.amount} from ${dayLabel(l.from)}`),
	];
	return parts.join(" · ");
}

/** The sheet that sets one rate: an amount from a day, today unless another is typed. */
function RateSheet({
	target,
	page,
	onClose,
	onDone,
}: {
	target: {
		level: "project" | "project-person" | "project-task";
		key: string;
		name: string;
	} | null;
	page: Page;
	onClose: () => void;
	onDone: (said: string) => void;
}) {
	const terms = useTerms();
	return (
		<FormSheet
			title={`Rate for ${target?.name ?? inTerms("this project", terms)}`}
			intent="rate"
			submitLabel="Save rate"
			isOpen={target !== null}
			onClose={onClose}
			onDone={onDone}
		>
			<input type="hidden" name="level" value={target?.level ?? "project"} />
			<input type="hidden" name="key" value={target?.key ?? ""} />
			<p>
				Billable, in {page.project.currency}, an hour. Entries before the day it starts keep the
				rate they had.
			</p>
			<TextField
				label="Rate an hour"
				name="amount"
				inputMode="decimal"
				autoComplete="off"
				isRequired
			/>
			<TextField label="From" name="from" type="date" defaultValue={page.today} isRequired />
		</FormSheet>
	);
}

function Tasks({ data, onSaid }: { data: Data; onSaid: (said: string) => void }) {
	const { page, managesTasks, managesRates } = data;
	const terms = useTerms();
	const t = (text: string) => inTerms(text, terms);
	const [adding, setAdding] = useState(false);
	const [rating, setRating] = useState<Parameters<typeof RateSheet>[0]["target"]>(null);
	const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
	const [billing, setBilling] = useState<{ ids: string[]; billable: boolean } | null>(null);
	const listed = page.tasks.filter((t) => t.id !== "");
	// Under Internal work nothing is billable: no task says whether it is, nor has a rate (TS-115a).
	const bills = data.showsClients && page.project.billingType !== "non_billable";
	const taskRates = data.showsClients && page.seesRates && page.project.rateMode === "task";

	return (
		<>
			{managesTasks && page.addableTasks.length > 0 && (
				<Button onPress={() => setAdding(true)}>Add a task</Button>
			)}
			<div className={managesTasks ? "mt-6" : undefined}>
				<Ledger heading="Tasks" note={listed.length}>
					{page.tasks.length === 0 ? (
						<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
							{t("This project has no tasks. Its entries have none until one is added.")}
						</p>
					) : (
						<LedgerRows label="Tasks and their hours">
							{page.tasks.map((task) => (
								<LedgerRow
									key={task.id || "none"}
									title={
										<span className="wrap-anywhere">
											{task.name}
											{task.archived ? " (archived)" : ""}
										</span>
									}
									detail={[
										task.id === ""
											? "Entries from before it had tasks"
											: !data.showsClients
												? null
												: task.billable
													? "Billable"
													: "Non-billable",
										taskRates && task.id !== "" ? rateWords(task.rate, task.defaultRate) : null,
									]
										.filter(Boolean)
										.join(" · ")}
									value={task.hours}
									action={
										task.id !== "" && (managesTasks || (managesRates && taskRates)) ? (
											<MenuTrigger>
												<Button variant="text" aria-label={`Actions for ${task.name}`}>
													Actions
												</Button>
												<Menu
													onAction={(chosen) => {
														if (chosen === "billable")
															setBilling({ ids: [task.id], billable: !task.billable });
														if (chosen === "remove") setRemoving({ id: task.id, name: task.name });
														if (chosen === "rate")
															setRating({ level: "project-task", key: task.id, name: task.name });
													}}
												>
													{managesTasks && bills ? (
														<MenuItem id="billable">
															{task.billable ? "Set non-billable" : "Set billable"}
														</MenuItem>
													) : null}
													{managesRates && taskRates ? (
														<MenuItem id="rate">Set rate</MenuItem>
													) : null}
													{managesTasks ? (
														<MenuItem id="remove">{t("Remove from project")}</MenuItem>
													) : null}
												</Menu>
											</MenuTrigger>
										) : undefined
									}
								/>
							))}
						</LedgerRows>
					)}
				</Ledger>
			</div>
			{managesTasks && listed.length > 1 && bills && (
				<p className="mt-4 flex flex-wrap gap-3">
					<Button
						variant="outlined"
						onPress={() => setBilling({ ids: listed.map((t) => t.id), billable: true })}
					>
						Set all billable
					</Button>
					<Button
						variant="outlined"
						onPress={() => setBilling({ ids: listed.map((t) => t.id), billable: false })}
					>
						Set all non-billable
					</Button>
				</p>
			)}

			<FormSheet
				title="Add a task"
				intent="add-task"
				submitLabel="Add task"
				isOpen={adding}
				onClose={() => setAdding(false)}
				onDone={onSaid}
			>
				{data.showsClients && (
					<p>
						{t(
							"It is billable here if it is billable by default, unless the project bills nothing.",
						)}
					</p>
				)}
				<Select
					label="Task"
					name="taskId"
					options={page.addableTasks.map((t) => ({ id: t.id, label: t.name }))}
					defaultValue={page.addableTasks[0]?.id ?? null}
					isRequired
				/>
			</FormSheet>

			<FormSheet
				title={billing?.billable ? "Set billable?" : "Set non-billable?"}
				intent="task-billable"
				submitLabel={billing?.billable ? "Set billable" : "Set non-billable"}
				isOpen={billing !== null}
				onClose={() => setBilling(null)}
				onDone={onSaid}
			>
				{billing?.ids.map((id) => (
					<input key={id} type="hidden" name="taskIds" value={id} />
				))}
				<input type="hidden" name="billable" value={String(billing?.billable ?? false)} />
				<p>
					{t(
						`${billing?.ids.length === 1 ? "The task's" : "The tasks'"} entries on this project change with ${billing?.ids.length === 1 ? "it" : "them"}, back to the first. Entries already on an invoice keep what they were billed as.`,
					)}
				</p>
			</FormSheet>

			<FormSheet
				title={`Remove ${removing?.name ?? "this task"}?`}
				intent="remove-task"
				submitLabel="Remove task"
				isOpen={removing !== null}
				onClose={() => setRemoving(null)}
				onDone={onSaid}
			>
				<input type="hidden" name="taskId" value={removing?.id ?? ""} />
				<p>It is no longer offered for this project. Entries that have it keep it.</p>
			</FormSheet>

			<RateSheet target={rating} page={page} onClose={() => setRating(null)} onDone={onSaid} />
		</>
	);
}

function Team({ data, onSaid }: { data: Data; onSaid: (said: string) => void }) {
	const { page, managesRates } = data;
	const organisation = useOrganisation();
	const t = (text: string) => inTerms(text, organisation.terms);
	const [rating, setRating] = useState<Parameters<typeof RateSheet>[0]["target"]>(null);
	const personRates = page.seesRates && page.project.rateMode === "person";
	return (
		<>
			{data.team && <TeamTab team={data.team} today={data.today} onSaid={onSaid} />}
			<div className={data.team ? "mt-10" : undefined}>
				<Ledger heading="People" note={page.people.length}>
					{page.people.length === 0 ? (
						<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
							{t("Nobody whose time you can see has tracked time to this project yet.")}
						</p>
					) : (
						<LedgerRows label="People and their hours">
							{page.people.map((person) => (
								<LedgerRow
									key={person.id}
									title={<span className="wrap-anywhere">{person.name}</span>}
									detail={personRates ? rateWords(person.rate, person.defaultRate) : undefined}
									value={person.hours}
									action={
										managesRates && personRates ? (
											<Button
												variant="text"
												aria-label={`Set rate for ${person.name}`}
												onPress={() =>
													setRating({ level: "project-person", key: person.id, name: person.name })
												}
											>
												Set rate
											</Button>
										) : undefined
									}
								/>
							))}
						</LedgerRows>
					)}
				</Ledger>
			</div>
			{personRates && (
				<p className="mt-4 max-w-160 text-body-medium text-on-surface-variant">
					{t("A rate set here is for this project alone.")} Each person's default rate is on{" "}
					<Link to={defaultRatesPath(organisation.slug)} className={TEXT_LINK}>
						Default rates
					</Link>
					.
				</p>
			)}
			<RateSheet target={rating} page={page} onClose={() => setRating(null)} onDone={onSaid} />
		</>
	);
}

function Settings({ data, onSaid }: { data: Data; onSaid: (said: string) => void }) {
	const { page, managesRates, managesTasks } = data;
	const terms = useTerms();
	const t = (text: string) => inTerms(text, terms);
	const { project } = page;
	const [open, setOpen] = useState<"billing" | "budget" | "overtime" | "tags" | null>(null);
	const overtimeRate = project.overtimeRateMilli ?? 1000;
	const [overtimeChoice, setOvertimeChoice] = useState<string>(
		OVERTIME_RATE_CHOICES.find((choice) => parseOvertimeRate(choice) === overtimeRate) ??
			CUSTOM_OVERTIME_RATE,
	);
	const close = () => setOpen(null);
	const [billingType, setBillingType] = useState<string>(project.billingType);
	const [budgetKind, setBudgetKind] = useState<string>(project.budgetKind);
	const tagNames = page.tags.filter((t) => page.tagIds.includes(t.id)).map((t) => t.name);
	const hoursKind = budgetKind !== "none" && isHoursBudget(budgetKind as BudgetKind);
	const lineChoices =
		budgetKind === "person_hours"
			? page.members.map((m) => ({ key: m.id, name: m.name }))
			: page.tasks.filter((t) => t.id !== "").map((t) => ({ key: t.id, name: t.name }));
	const lineAmount = (key: string) => {
		if (budgetKind !== project.budgetKind || !page.budget) return "";
		const line = page.budget.lines.find((l) => l.key === key);
		if (!line) return "";
		return hoursKind ? String(line.amount / 60) : moneyText(line.amount, project.currency);
	};
	const wholeAmount =
		project.budgetAmount === null || budgetKind !== project.budgetKind
			? ""
			: hoursKind
				? String(project.budgetAmount / 60)
				: moneyText(project.budgetAmount, project.currency);

	return (
		<>
			<Ledger heading="Settings">
				<LedgerRows label={t("The project's settings")}>
					{managesRates && data.showsClients && (
						<LedgerRow
							title="Billing"
							detail={[
								BILLING_TYPE_LABELS[project.billingType],
								project.billingType === "non_billable" ? null : RATE_MODE_LABELS[project.rateMode],
								project.billingType === "hourly" || project.billingType === "fixed_fee"
									? project.rateMode === "project"
										? rateWords(page.projectRate)
										: null
									: null,
								project.fee ? `Fee ${project.fee}` : null,
								project.currency,
							]
								.filter(Boolean)
								.join(" · ")}
							action={
								<Button
									variant="text"
									aria-label="Change billing"
									onPress={() => setOpen("billing")}
								>
									Change
								</Button>
							}
						/>
					)}
					{managesRates && (
						<LedgerRow
							title="Budget"
							detail={[
								BUDGET_KIND_LABELS[project.budgetKind as BudgetKind] ?? "No budget",
								project.budgetKind !== "none" && project.budgetResetsMonthly
									? "Resets each month"
									: null,
								project.budgetKind !== "none" && project.budgetAlertPercent !== null
									? `Alert at ${project.budgetAlertPercent}%`
									: null,
								project.budgetKind !== "none" && project.budgetWarnMembers
									? "Warns when over"
									: null,
							]
								.filter(Boolean)
								.join(" · ")}
							action={
								<Button variant="text" aria-label="Change budget" onPress={() => setOpen("budget")}>
									Change
								</Button>
							}
						/>
					)}
					{managesRates && project.overtimeRateMilli !== null && (
						<LedgerRow
							title="Overtime billed at"
							detail={`${overtimeRateText(project.overtimeRateMilli)} the day's rate`}
							action={
								<Button
									variant="text"
									aria-label="Change what overtime is billed at"
									onPress={() => setOpen("overtime")}
								>
									Change
								</Button>
							}
						/>
					)}
					{managesTasks && (
						<LedgerRow
							title="Tags"
							detail={tagNames.length > 0 ? tagNames.join(", ") : "No tags"}
							action={
								page.tags.some((t) => !t.archived) || tagNames.length > 0 ? (
									<Button variant="text" aria-label="Change tags" onPress={() => setOpen("tags")}>
										Change
									</Button>
								) : undefined
							}
						/>
					)}
				</LedgerRows>
			</Ledger>

			<FormSheet
				title="Billing"
				intent="billing"
				submitLabel="Save billing"
				isOpen={open === "billing"}
				onClose={close}
				onDone={onSaid}
			>
				<RadioGroup
					label={t("Project type")}
					name="billingType"
					value={billingType}
					onChange={setBillingType}
				>
					{BillingType.options.map((type) => (
						<Radio key={type} value={type}>
							{BILLING_TYPE_LABELS[type]}
							<span className="block text-body-medium text-on-surface-variant">
								{BILLING_TYPE_MEANINGS[type]}
							</span>
						</Radio>
					))}
				</RadioGroup>
				{billingType === "fixed_fee" && (
					<TextField
						label="Fee"
						name="fee"
						inputMode="decimal"
						autoComplete="off"
						defaultValue={
							project.feeMinor === null ? "" : moneyText(project.feeMinor, project.currency)
						}
						isRequired
					/>
				)}
				<Select
					label="Bill by"
					name="rateMode"
					options={RATE_MODES.map((mode) => ({ id: mode, label: RATE_MODE_LABELS[mode] }))}
					defaultValue={project.rateMode}
					description="Each person's and each task's rate is set on the Team and Tasks tabs."
				/>
				{billingType !== "non_billable" && (
					<TextField
						label={t("Project rate an hour")}
						name="rate"
						inputMode="decimal"
						autoComplete="off"
						defaultValue={
							page.projectRate?.current
								? moneyText(page.projectRate.current.amountMinor, project.currency)
								: ""
						}
						description="When it bills one rate for the project. A new rate prices entries from today."
					/>
				)}
				<Select
					label="Currency"
					name="currency"
					options={[
						{
							id: INHERITED,
							label: `${page.clientCurrency ? "The client's" : "The organisation's"} (${page.clientCurrency ?? page.organisationCurrency})`,
						},
						...CURRENCIES.map((code) => ({ id: code, label: code })),
					]}
					defaultValue={project.ownCurrency ?? INHERITED}
				/>
			</FormSheet>

			<FormSheet
				title="Budget"
				intent="budget"
				submitLabel="Save budget"
				isOpen={open === "budget"}
				onClose={close}
				onDone={onSaid}
			>
				<Select
					label="Budget"
					name="budgetKind"
					options={BudgetKind.options.map((kind) => ({
						id: kind,
						label: BUDGET_KIND_LABELS[kind],
					}))}
					value={budgetKind}
					onChange={(id) => setBudgetKind(id ?? "none")}
				/>
				{(budgetKind === "total_hours" || budgetKind === "total_fees") && (
					<TextField
						key={budgetKind}
						label={hoursKind ? "Hours" : `Fees, ${project.currency}`}
						name="amount"
						inputMode="decimal"
						autoComplete="off"
						defaultValue={wholeAmount}
						isRequired
					/>
				)}
				{(budgetKind === "task_hours" ||
					budgetKind === "task_fees" ||
					budgetKind === "person_hours") && (
					<fieldset className="flex flex-col gap-4">
						<legend className="pb-1 text-title-medium">
							{budgetKind === "person_hours"
								? "Hours for each person"
								: hoursKind
									? "Hours for each task"
									: `Fees for each task, ${project.currency}`}
						</legend>
						{lineChoices.map((line) => (
							<div key={`${budgetKind}-${line.key}`}>
								<input type="hidden" name="lineKey" value={line.key} />
								<TextField
									label={line.name}
									name="lineAmount"
									inputMode="decimal"
									autoComplete="off"
									defaultValue={lineAmount(line.key)}
								/>
							</div>
						))}
					</fieldset>
				)}
				{budgetKind !== "none" && (
					<>
						<Checkbox name="resetsMonthly" defaultSelected={project.budgetResetsMonthly}>
							Start again each month
						</Checkbox>
						<TextField
							label="Alert at, %"
							name="alertPercent"
							inputMode="numeric"
							autoComplete="off"
							defaultValue={
								project.budgetAlertPercent === null ? "" : String(project.budgetAlertPercent)
							}
							description="Owners, admins and the managers of its people are told once a period. Empty sends none."
						/>
						<Checkbox name="warnMembers" defaultSelected={project.budgetWarnMembers}>
							Warn people tracking time once it is over
						</Checkbox>
						{budgetKind === "total_fees" && (
							<Checkbox name="includesExpenses" defaultSelected={project.budgetIncludesExpenses}>
								{t("Count the project's expenses")}
							</Checkbox>
						)}
					</>
				)}
			</FormSheet>

			<FormSheet
				title="Overtime billed at"
				intent="overtime-rate"
				submitLabel="Save"
				isOpen={open === "overtime"}
				onClose={close}
				onDone={onSaid}
			>
				<p>
					Overtime is billed at the rate in force on its day times this, on a line of its own. It
					prices overtime on no invoice yet.
				</p>
				<RadioGroup
					label="Overtime billed at"
					name="overtimeRate"
					value={overtimeChoice}
					onChange={setOvertimeChoice}
				>
					{OVERTIME_RATE_CHOICES.map((choice) => (
						<Radio key={choice} value={choice}>
							×{choice}
							{choice === "1" ? ", the day's rate" : ""}
						</Radio>
					))}
					<Radio value={CUSTOM_OVERTIME_RATE}>Custom</Radio>
				</RadioGroup>
				{overtimeChoice === CUSTOM_OVERTIME_RATE && (
					<TextField
						label="Multiplier"
						name="customRate"
						inputMode="decimal"
						autoComplete="off"
						defaultValue={quantityText(overtimeRate)}
						description="From 1 to 10, such as 1.75."
						isRequired
					/>
				)}
			</FormSheet>

			<FormSheet
				title="Tags"
				intent="tags"
				submitLabel="Save tags"
				isOpen={open === "tags"}
				onClose={close}
				onDone={onSaid}
			>
				<p>{t("A project's tags count for its entries when a report is filtered by tag.")}</p>
				<TagPicker tags={page.tags} selected={page.tagIds} />
			</FormSheet>
		</>
	);
}
