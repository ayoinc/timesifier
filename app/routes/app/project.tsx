import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { type ReactNode, useState } from "react";
import { useLocale } from "react-aria";
import { Link } from "react-router";
import * as z from "zod";

import { BillingType } from "~/billing/billable";
import { BudgetKind, isHoursBudget } from "~/budgets/budget";
import { Button } from "~/components/Button";
import { Checkbox } from "~/components/Checkbox";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { LinkTabs } from "~/components/LinkTabs";
import { Menu, MenuItem, MenuTrigger } from "~/components/Menu";
import { Radio, RadioGroup } from "~/components/Radio";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { parseRequest } from "~/lib/validate";
import { formatMoney, isCurrencyCode } from "~/money/money";
import { moneyText, parseBudgetHours, parseMoney } from "~/money/typed";
import { mayManageRates, mayManageTasks, timeScopeOf } from "~/organisations/access";
import { accessOf } from "~/organisations/access.server";
import { membershipContext, notFound } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { NOT_ALLOWED } from "~/organisations/problems";
import {
	BILLING_TYPE_LABELS,
	BILLING_TYPE_MEANINGS,
	BUDGET_KIND_LABELS,
	CURRENCIES,
	INHERITED,
	RATE_MODE_LABELS,
	RATE_MODES,
} from "~/projects/billing";
import { projectCurrencies, projectPage } from "~/projects/project.server";
import {
	defaultRatesPath,
	PROJECT_PARAM,
	PROJECT_TABS,
	type ProjectTab,
	projectPath,
	projectTabIn,
} from "~/projects/projects";
import { changeBilling, changeBudget } from "~/projects/settings.server";
import { resolveRate } from "~/rates/rates";
import { ratesForProject, setRate } from "~/rates/rates.server";
import { dayLabel, hoursAndMinutes } from "~/reports/format";
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

import type { Route } from "./+types/project";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// A project's own page (harvest-taste.md item 11): Overview, with its hours,
// what they are worth and its budget; Tasks, its list and each task's hours;
// Team, the people who tracked time to it; and Settings, how it bills, its
// budget and its tags. Every member opens it, as every member sees Projects;
// the hours are those of the people whose time the viewer may see. Amounts,
// rates and a budget in fees are shown only to owners, admins and Finance
// (`maySeeRates`), who also set them (`mayManageRates`); owners and admins
// keep the project's tasks and tags (`mayManageTasks`).

const TAB_LABELS: Record<ProjectTab, string> = {
	overview: "Overview",
	tasks: "Tasks",
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
	const page = await projectPage(
		scope,
		membership,
		params[PROJECT_PARAM],
		timeScopeOf(access),
		now,
		negotiateLocale(request.headers.get("Accept-Language")),
	);
	if (!page) throw notFound();
	const managesRates = mayManageRates(membership.role);
	const managesTasks = mayManageTasks(membership.role);
	const tabs = PROJECT_TABS.filter((tab) => tab !== "settings" || managesRates || managesTasks);
	const asked = projectTabIn(new URL(request.url).searchParams);
	return {
		page,
		tab: tabs.includes(asked) ? asked : "overview",
		tabs,
		managesRates,
		managesTasks,
		showsClients: membership.organisation.clientsEnabled,
	};
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
	z.object({ intent: z.literal("tags"), tagIds: TagIds }),
	z.object({ intent: z.literal("add-task"), taskId: Id }),
	z.object({ intent: z.literal("remove-task"), taskId: Id }),
	z.object({
		intent: z.literal("task-billable"),
		taskIds: Ids,
		billable: z.enum(["true", "false"]),
	}),
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
			return done(kind === "none" ? "The project has no budget." : "Budget saved.");
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

const RATE_IN_FORCE =
	"That rate is in force, and entries are priced by it. Set a new rate from today or a later day instead.";

type Data = Route.ComponentProps["loaderData"];
type Page = Data["page"];

export default function Project({ loaderData }: Route.ComponentProps) {
	const { page, tab, tabs } = loaderData;
	const organisation = useOrganisation();
	const [said, setSaid] = useState<string | null>(null);
	const { project } = page;

	return (
		<>
			<p className="text-body-large">
				<Link to={destinationPath(organisation.slug, "projects")} className={TEXT_LINK}>
					← Projects
				</Link>
			</p>
			<PageHeading>{project.name}</PageHeading>
			<PageLead>
				{[
					loaderData.showsClients ? (project.client?.name ?? "No client") : null,
					BILLING_TYPE_LABELS[project.billingType],
					project.archived ? "Archived" : null,
				]
					.filter(Boolean)
					.join(" · ")}
			</PageLead>
			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>
			<div className="mt-6">
				<LinkTabs
					label="Project pages"
					tabs={tabs.map((id) => ({
						id,
						label: TAB_LABELS[id],
						to: projectPath(organisation.slug, project.id, id),
					}))}
					current={tab}
				/>
			</div>
			<div className="mt-8 max-w-200">
				{tab === "overview" && <Overview data={loaderData} />}
				{tab === "tasks" && <Tasks data={loaderData} onSaid={setSaid} />}
				{tab === "team" && <Team data={loaderData} onSaid={setSaid} />}
				{tab === "settings" && <Settings data={loaderData} onSaid={setSaid} />}
			</div>
		</>
	);
}

/** Hours or money of a budget, as the page writes them. */
function budgetFigure(page: Page, value: number, locale: string) {
	if (!page.budget) return "";
	return page.budget.hours
		? hoursAndMinutes(value * 60)
		: formatMoney(value, page.budget.currency, locale);
}

/**
 * How much of a budget is spent, as a bar: the spent part in primary, the
 * part over the budget in error. Drawn in SVG, so no `style` attribute is
 * written (docs/security.md); the figures are read out by its role.
 */
function BudgetBar({
	label,
	percent,
	over,
}: {
	label: string;
	percent: number | null;
	over: boolean;
}) {
	const shown = Math.min(100, percent ?? 100);
	return (
		// biome-ignore lint/a11y/useSemanticElements: drawn in SVG from the tokens, which a native meter cannot take.
		<div
			role="meter"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.min(100, percent ?? 100)}
			aria-valuetext={percent === null ? "Over a budget of nothing" : `${percent}% spent`}
			className="mt-2"
		>
			<svg
				viewBox="0 0 100 4"
				preserveAspectRatio="none"
				className="block h-2 w-full"
				aria-hidden="true"
			>
				<rect width="100" height="4" rx="2" className="fill-surface-container-highest" />
				<rect width={shown} height="4" rx="2" className={over ? "fill-error" : "fill-primary"} />
			</svg>
		</div>
	);
}

function Overview({ data }: { data: Data }) {
	const { page } = data;
	const { locale } = useLocale();
	const organisation = useOrganisation();
	const { budget } = page;
	return (
		<>
			<Ledger heading="Hours" note="To date">
				<LedgerRows label="Hours to date">
					<LedgerRow title="Billable" value={page.hours.billable} />
					<LedgerRow title="Non-billable" value={page.hours.nonBillable} />
					{page.amount !== null && (
						<LedgerRow title={`Billable amount, ${page.project.currency}`} value={page.amount} />
					)}
					{page.project.fee !== null && <LedgerRow title="Fixed fee" value={page.project.fee} />}
				</LedgerRows>
				<LedgerTotal label="Total hours" value={page.hours.total} />
			</Ledger>

			{budget && (
				<Section
					id="budget"
					heading="Budget"
					lead={`${BUDGET_KIND_LABELS[budget.kind]}, ${
						budget.period.endsOn === null
							? "over the whole project"
							: `for ${dayLabel(budget.period.startsOn)} to ${dayLabel(budget.period.endsOn)}`
					}.${page.alertSentOn ? ` The alert went out on ${dayLabel(page.alertSentOn)}.` : ""}`}
				>
					{budget.whole ? (
						<div>
							<p className="flex flex-wrap justify-between gap-x-6 text-body-large">
								<span>
									{budgetFigure(page, budget.whole.spent, locale)} spent of{" "}
									{budgetFigure(page, budget.whole.amount, locale)}
								</span>
								<span className={budget.whole.over ? "text-error" : undefined}>
									{budget.whole.over
										? `${budgetFigure(page, -budget.whole.remaining, locale)} over`
										: `${budgetFigure(page, budget.whole.remaining, locale)} remaining`}
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
											value={`${budgetFigure(page, line.spent, locale)} of ${budgetFigure(page, line.amount, locale)}`}
										/>
									))}
								</LedgerRows>
							</Ledger>
						</div>
					)}
				</Section>
			)}

			{page.missingRates && page.missingRates.count > 0 && (
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
	return (
		<FormSheet
			title={`Rate for ${target?.name ?? "this project"}`}
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
	const [adding, setAdding] = useState(false);
	const [rating, setRating] = useState<Parameters<typeof RateSheet>[0]["target"]>(null);
	const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
	const [billing, setBilling] = useState<{ ids: string[]; billable: boolean } | null>(null);
	const listed = page.tasks.filter((t) => t.id !== "");
	const taskRates = page.seesRates && page.project.rateMode === "task";

	return (
		<>
			{managesTasks && page.addableTasks.length > 0 && (
				<Button onPress={() => setAdding(true)}>Add a task</Button>
			)}
			<div className={managesTasks ? "mt-6" : undefined}>
				<Ledger heading="Tasks" note={listed.length}>
					{page.tasks.length === 0 ? (
						<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
							This project has no tasks. Its entries have none until one is added.
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
													{managesTasks && page.project.billingType !== "non_billable" ? (
														<MenuItem id="billable">
															{task.billable ? "Set non-billable" : "Set billable"}
														</MenuItem>
													) : null}
													{managesRates && taskRates ? (
														<MenuItem id="rate">Set rate</MenuItem>
													) : null}
													{managesTasks ? (
														<MenuItem id="remove">Remove from project</MenuItem>
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
			{managesTasks && listed.length > 1 && page.project.billingType !== "non_billable" && (
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
				<p>It is billable here if it is billable by default, unless the project bills nothing.</p>
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
					{billing?.ids.length === 1 ? "The task's" : "The tasks'"} entries on this project change
					with {billing?.ids.length === 1 ? "it" : "them"}, back to the first. Entries already on an
					invoice keep what they were billed as.
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
	const [rating, setRating] = useState<Parameters<typeof RateSheet>[0]["target"]>(null);
	const personRates = page.seesRates && page.project.rateMode === "person";
	return (
		<>
			<Ledger heading="People" note={page.people.length}>
				{page.people.length === 0 ? (
					<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
						Nobody whose time you can see has tracked time to this project yet.
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
			{personRates && (
				<p className="mt-4 max-w-160 text-body-medium text-on-surface-variant">
					A rate set here is for this project alone. Each person's default rate is on{" "}
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
	const { project } = page;
	const [open, setOpen] = useState<"billing" | "budget" | "tags" | null>(null);
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
				<LedgerRows label="The project's settings">
					{managesRates && (
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
					label="Project type"
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
						label="Project rate an hour"
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
								Count the project's expenses
							</Checkbox>
						)}
					</>
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
				<p>A project's tags count for its entries when a report is filtered by tag.</p>
				<TagPicker tags={page.tags} selected={page.tagIds} />
			</FormSheet>
		</>
	);
}
