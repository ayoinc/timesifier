import { env } from "cloudflare:workers";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { useCallback, useState } from "react";
import { Form, Link } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { type OrganisationScope, organisationScope } from "~/db";
import { listCategories } from "~/expenses/categories.server";
import {
	type CategoryChoice,
	ExpenseFields,
	type ExpenseValues,
	type ProjectChoice,
} from "~/expenses/ExpenseFields";
import {
	amountText,
	EXPENSE_NOTES_MAX_LENGTH,
	quantityText,
	RECEIPT_MAX_BYTES,
} from "~/expenses/expenses";
import {
	changeExpense,
	deleteExpense,
	type ExpenseInput,
	expensesOf,
	recordExpense,
	termsOf,
} from "~/expenses/expenses.server";
import { receiptPath } from "~/expenses/paths";
import { parseRequest } from "~/lib/validate";
import type { LockReason } from "~/locks/locks";
import { formatMoney, totalsByCurrency } from "~/money/money";
import { isAdministrator, maySeeExpensesOf } from "~/organisations/access";
import { accessOf } from "~/organisations/access.server";
import { membershipContext, notFound } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { type PeriodDays, periodBounds } from "~/periods/periods";
import { type NotMoved, submitPeriod, withdrawPeriod } from "~/periods/submission.server";
import { activeProjects } from "~/projects/projects.server";
import { peopleToChoose } from "~/reports/reports.server";
import { destination, destinationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { EmptySheet, PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { viewedPeriod } from "~/teams/viewed-period.server";
import { dayLabel, periodLabel, WEEK_PARAM } from "~/teams/words";
import { Day } from "~/time/calendar";
import { zoneOfMember } from "~/time/zones.server";
import { Submission } from "~/timesheet/Submission";
import { periodState } from "~/timesheet/sheets";
import { type PeriodSubmission, periodOf } from "~/timesheet/timesheet.server";

import type { Route } from "./+types/expenses";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// Expenses (TS-070, B9), under Track: a person's costs on a project, a week at
// a time, each with its category, amount or quantity, note, whether it is
// billable and whether they ask to be paid back, and a receipt. A week's
// expenses are submitted, withdrawn, approved and returned with its time:
// the week's one submission is at the foot of this page as of the Timesheet,
// and a submitted or approved week, the lock date and an invoice lock them.
// Whoever may see somebody's time sees their expenses here too, by choosing
// them; only the person adds and changes their own (app/organisations/access.ts).

const { label } = destination("expenses");

/** The query that names whose expenses are shown. */
const PERSON_PARAM = "person";

/** The locale amounts are written in, as the rest of the pages write dates. */
const LOCALE = "en-GB";

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

const LOCK_WORDS: Record<LockReason, string> = {
	"locked-through": "Locked by the organisation's lock date",
	submitted: "Locked while the week is submitted",
	approved: "Locked: the week is approved",
	invoiced: "Locked: it is on an invoice",
};

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const { organisation, user } = membership;
	const url = new URL(request.url);
	const scope = organisationScope(env.DB, organisation.id);
	const access = await accessOf(membership);
	const [viewed, choices, terms] = await Promise.all([
		viewedPeriod(membership, url),
		peopleToChoose(scope, access),
		termsOf(organisation.id),
	]);
	const personId = url.searchParams.get(PERSON_PARAM) || user.id;
	const person = choices.find(({ id }) => id === personId);
	if (!person || !maySeeExpensesOf(access, personId)) throw notFound();
	const own = personId === user.id;
	const { period } = viewed;

	const expenses = await expensesOf(scope, personId, period.startsOn, period.endsOn);
	const money = (minor: number, currency: string) => formatMoney(minor, currency, LOCALE);
	const sum = (rows: typeof expenses) =>
		totalsByCurrency(rows.map(({ amountMinor, currency }) => ({ amountMinor, currency })))
			.map(({ amountMinor, currency }) => money(amountMinor, currency))
			.join(" + ");

	// What the person needs to record and change their own: the active projects
	// and categories, and where their week stands.
	let form: {
		projects: ProjectChoice[];
		categories: CategoryChoice[];
		submission: PeriodSubmission;
	} | null = null;
	if (own) {
		const [projects, categories, submission] = await Promise.all([
			activeProjects(scope),
			listCategories(scope),
			submissionOf(scope, user.id, period, viewed),
		]);
		const clientIds = [
			...new Set(projects.flatMap((p) => (p.clientId === null ? [] : [p.clientId]))),
		];
		const clients =
			clientIds.length === 0 ? [] : await scope.clients.select((c) => inArray(c.id, clientIds));
		const clientCurrency = new Map(clients.map((c) => [c.id, c.currency]));
		form = {
			projects: projects.map((p) => ({
				id: p.id,
				name: p.name,
				currency:
					p.currency ??
					(p.clientId === null ? null : clientCurrency.get(p.clientId)) ??
					terms.currency,
				billable: p.billingType !== "non_billable",
			})),
			categories: categories
				.filter((c) => !c.archived)
				.map(({ id, name, unitName, prices }) => ({ id, name, unitName, prices })),
			submission,
		};
	}

	return {
		week: {
			label: periodLabel(period),
			previous: viewed.previous,
			next: viewed.next,
			startsOn: period.startsOn,
		},
		// The day a new expense is dated at first: today in the current week, else the week's first day.
		firstDay:
			period.startsOn <= viewed.today && viewed.today <= period.endsOn
				? viewed.today
				: period.startsOn,
		person: { id: person.id, name: person.name, own },
		choices: choices.length > 1 ? choices : [],
		currency: terms.currency,
		expenses: expenses.map((e) => ({
			id: e.id,
			title: `${e.category} · ${e.project}`,
			day: dayLabel(e.spentOn),
			amount: money(e.amountMinor, e.currency),
			quantity:
				e.quantityMilli === null || e.unitPriceMinor === null
					? null
					: `${quantityText(e.quantityMilli)} × ${money(e.unitPriceMinor, e.currency)} per ${e.unitName ?? "unit"}`,
			flags: [
				e.billable ? "Billable" : "Not billable",
				...(e.reimbursable ? ["Reimburse me"] : []),
			].join(" · "),
			notes: e.notes,
			receipt:
				e.receiptName === null
					? null
					: { name: e.receiptName, to: receiptPath(organisation.slug, e.id) },
			lock: e.lock === null ? null : LOCK_WORDS[e.lock],
			// What its sheet offers when its project or category has since been archived.
			project: { id: e.projectId, name: e.project, currency: e.currency, billable: e.billable },
			category: { id: e.categoryId, name: e.category, unitName: e.unitName, prices: [] },
			values: {
				spentOn: e.spentOn,
				projectId: e.projectId,
				categoryId: e.categoryId,
				amount: amountText(e.amountMinor, e.currency),
				quantity: e.quantityMilli === null ? "" : quantityText(e.quantityMilli),
				notes: e.notes ?? "",
				billable: e.billable,
				reimbursable: e.reimbursable,
				receiptName: e.receiptName,
			} satisfies ExpenseValues,
		})),
		total: sum(expenses),
		billable: sum(expenses.filter((e) => e.billable)),
		reimbursable: sum(expenses.filter((e) => e.reimbursable)),
		form,
		administers: isAdministrator(membership.role),
	};
}

/** Where `userId`'s week stands, for its one submission at the foot of the page. */
async function submissionOf(
	scope: OrganisationScope,
	userId: string,
	period: PeriodDays,
	{ today, zone }: { today: Day; zone: string },
): Promise<PeriodSubmission> {
	const [row, running] = await Promise.all([
		periodOf(scope, userId, period.startsOn),
		scope.timeEntries.select((e) => and(eq(e.userId, userId), isNull(e.endedAt)), { limit: 1 }),
	]);
	const status = row?.status ?? null;
	const { from, to } = periodBounds(period, zone);
	return {
		period,
		state: periodState(status),
		status,
		comment: row?.status === "returned" ? row.comment : null,
		runsInWeek: running.some(({ startedAt }) => {
			const at = startedAt.getTime();
			return from <= at && at < to;
		}),
		started: period.startsOn <= today,
	};
}

const Id = z.string().min(1).max(64);
/** A checkbox sends its value only while it is ticked. */
const Ticked = z
	.literal("on")
	.optional()
	.transform((value) => value === "on");
const Typed = z.string().max(32).optional().default("");

const fields = {
	spentOn: Day,
	projectId: Id,
	categoryId: Id,
	amount: Typed,
	quantity: Typed,
	notes: z.string().trim().max(EXPENSE_NOTES_MAX_LENGTH).optional(),
	billable: Ticked,
	reimbursable: Ticked,
	// A file field left empty arrives as an empty string: no receipt.
	receipt: z
		.union([z.instanceof(File), z.literal("")])
		.optional()
		.transform((file) => (file === "" ? undefined : file)),
	removeReceipt: Ticked,
};

const form = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("record"), ...fields }),
	z.object({ intent: z.literal("change"), expenseId: Id, ...fields }),
	z.object({ intent: z.literal("delete"), expenseId: Id }),
	z.object({ intent: z.literal("submit"), startsOn: Day }),
	z.object({ intent: z.literal("withdraw"), startsOn: Day }),
]);

/** Room for the receipt and the rest of the form. */
const MAX_BYTES = RECEIPT_MAX_BYTES + 64 * 1024;

export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form, { maxBytes: MAX_BYTES });
	const membership = context.get(membershipContext);
	const { organisation, user } = membership;
	const scope = organisationScope(env.DB, organisation.id);

	const expense = (fields: Extract<typeof input, { spentOn: string }>): ExpenseInput => ({
		spentOn: fields.spentOn,
		projectId: fields.projectId,
		categoryId: fields.categoryId,
		amount: fields.amount,
		quantity: fields.quantity,
		notes: fields.notes || null,
		billable: fields.billable,
		reimbursable: fields.reimbursable,
		receipt: fields.receipt ?? null,
		removeReceipt: fields.removeReceipt,
	});

	switch (input.intent) {
		case "record": {
			const made = await recordExpense(scope, user.id, expense(input));
			return made.ok ? done("Expense recorded.") : declined(made.problem, made.status);
		}
		case "change": {
			const changed = await changeExpense(scope, user.id, input.expenseId, expense(input));
			return changed.ok ? done("Expense saved.") : declined(changed.problem, changed.status);
		}
		case "delete": {
			const deleted = await deleteExpense(scope, user.id, input.expenseId);
			return deleted.ok ? done("Expense deleted.") : declined(deleted.problem, deleted.status);
		}
		case "submit": {
			const submitted = await submitPeriod(scope, {
				userId: user.id,
				startsOn: input.startsOn,
				zone: await zoneOfMember(membership),
				weekStartsOn: organisation.weekStartsOn,
				now: Date.now(),
			});
			if (submitted.ok) {
				return done("Week submitted. Its time and expenses are locked until it is decided.");
			}
			const problem: Record<NotMoved, string> = {
				"not-yet": "A week can be submitted once it has begun.",
				running: "Stop the timer before you submit the week.",
				"not-from-here": "This week is already submitted or approved.",
			};
			return declined(problem[submitted.reason], 409);
		}
		case "withdraw": {
			const withdrawn = await withdrawPeriod(scope, { userId: user.id, startsOn: input.startsOn });
			return withdrawn.ok
				? done("Submission withdrawn. You can change the week's time and expenses again.")
				: declined("Only a submission nobody has decided yet can be withdrawn.", 409);
		}
	}
}

type Loaded = Route.ComponentProps["loaderData"];
type Shown = Loaded["expenses"][number];
type Task = "record" | "change" | "delete";

export default function Expenses({ loaderData }: Route.ComponentProps) {
	const { week, person, choices, expenses, form, administers } = loaderData;
	const organisation = useOrganisation();
	const [task, setTask] = useState<Task | null>(null);
	const [target, setTarget] = useState<Shown | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = useCallback(() => setTask(null), []);
	const open = (next: Task, on: Shown | null) => {
		setTarget(on);
		setTask(next);
	};
	const keep = person.own ? "" : `&${PERSON_PARAM}=${person.id}`;
	const canRecord = form !== null && form.projects.length > 0 && form.categories.length > 0;

	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>
				{person.own
					? "Costs you spend on a project, to be paid back or billed to its client. They are submitted with your week's time."
					: `The expenses of ${person.name}.`}
			</PageLead>
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			{choices.length > 0 && (
				<Form method="get" className="mt-6 flex max-w-200 flex-wrap items-end gap-4">
					<input type="hidden" name={WEEK_PARAM} value={week.startsOn} />
					<div className="min-w-60">
						<Select
							label="Whose expenses"
							name={PERSON_PARAM}
							options={choices.map(({ id, name }) => ({ id, label: name }))}
							defaultValue={person.id}
						/>
					</div>
					<Button type="submit" variant="outlined">
						Show
					</Button>
				</Form>
			)}

			{canRecord && (
				<div className="mt-6">
					<Button onPress={() => open("record", null)}>Record expense</Button>
				</div>
			)}

			<p className="mt-6 flex max-w-200 items-center justify-between gap-4 text-body-large">
				<Link to={`?${WEEK_PARAM}=${week.previous}${keep}`} className={TEXT_LINK}>
					← Previous week
				</Link>
				{week.next ? (
					<Link to={`?${WEEK_PARAM}=${week.next}${keep}`} className={TEXT_LINK}>
						Next week →
					</Link>
				) : (
					<span className="text-on-surface-variant">This is the current week</span>
				)}
			</p>

			<Section id="week" heading={`Week of ${week.label}`} className="max-w-200">
				{expenses.length === 0 ? (
					<EmptySheet heading="Expenses">
						{form === null ? (
							`${person.name} recorded no expenses this week.`
						) : canRecord ? (
							"No expenses this week. Record one with its receipt, and it goes with your week's time when you submit it."
						) : form.categories.length === 0 ? (
							administers ? (
								<>
									There are no expense categories yet.{" "}
									<Link
										to={`${destinationPath(organisation.slug, "settings")}#expense-categories`}
										className={TEXT_LINK}
									>
										Add them in Workspace settings
									</Link>
									.
								</>
							) : (
								"There are no expense categories yet. An owner or admin adds them in Workspace settings."
							)
						) : (
							"There are no active projects to record an expense on yet."
						)}
					</EmptySheet>
				) : (
					<Ledger heading="Expenses" note={`${expenses.length}`}>
						<LedgerRows label={`Expenses, week of ${week.label}`}>
							{expenses.map((e) => (
								<LedgerRow
									key={e.id}
									title={<span className="wrap-anywhere">{e.title}</span>}
									detail={
										<>
											{e.day} · {e.flags}
											{e.quantity && <span className="block">{e.quantity}</span>}
											{e.notes && <span className="block wrap-anywhere">“{e.notes}”</span>}
											{e.receipt && (
												<span className="block">
													<a
														href={e.receipt.to}
														className={`${TEXT_LINK} wrap-anywhere`}
														target="_blank"
														rel="noopener"
													>
														Receipt: {e.receipt.name}
													</a>
												</span>
											)}
											{e.lock && <span className="block">{e.lock}</span>}
										</>
									}
									value={e.amount}
									action={
										person.own &&
										e.lock === null && (
											<span className="flex gap-1">
												<Button
													variant="text"
													aria-label={`Change ${e.title}, ${e.day}`}
													onPress={() => open("change", e)}
												>
													Change
												</Button>
												<Button
													variant="text"
													aria-label={`Delete ${e.title}, ${e.day}`}
													onPress={() => open("delete", e)}
												>
													Delete
												</Button>
											</span>
										)
									}
								/>
							))}
						</LedgerRows>
						{loaderData.billable && <LedgerTotal label="Billable" value={loaderData.billable} />}
						{loaderData.reimbursable && (
							<LedgerTotal label="To pay back" value={loaderData.reimbursable} />
						)}
						<LedgerTotal label="Total" value={loaderData.total} />
					</Ledger>
				)}
			</Section>

			{form && (
				<div className="max-w-200">
					<Submission submission={form.submission} onSaid={setSaid} variant="outlined" />
				</div>
			)}

			{form && (
				<>
					<FormSheet
						title="Record an expense"
						intent="record"
						submitLabel="Record"
						encType="multipart/form-data"
						isOpen={task === "record"}
						onClose={close}
						onDone={setSaid}
					>
						<ExpenseFields
							projects={form.projects}
							categories={form.categories}
							currency={loaderData.currency}
							values={{
								spentOn: loaderData.firstDay,
								projectId: form.projects[0]?.id ?? "",
								categoryId: form.categories[0]?.id ?? "",
								amount: "",
								quantity: "",
								notes: "",
								billable: form.projects[0]?.billable ?? false,
								reimbursable: false,
								receiptName: null,
							}}
						/>
					</FormSheet>
					<FormSheet
						title="Change the expense"
						intent="change"
						submitLabel="Save"
						encType="multipart/form-data"
						isOpen={task === "change"}
						onClose={close}
						onDone={setSaid}
					>
						{target && (
							<>
								<input type="hidden" name="expenseId" value={target.id} />
								<ExpenseFields
									projects={withChoice(form.projects, target.project)}
									categories={withChoice(form.categories, target.category)}
									currency={loaderData.currency}
									values={target.values}
								/>
							</>
						)}
					</FormSheet>
					<FormSheet
						title="Delete this expense?"
						intent="delete"
						submitLabel="Delete"
						isOpen={task === "delete"}
						onClose={close}
						onDone={setSaid}
					>
						{target && (
							<>
								<input type="hidden" name="expenseId" value={target.id} />
								<p className="wrap-anywhere">
									{target.title}, {target.day}, {target.amount}. Its receipt is deleted with it.
								</p>
							</>
						)}
					</FormSheet>
				</>
			)}
		</>
	);
}

/** The choices offered, with the expense's own when it has since been archived. */
function withChoice<Choice extends { id: string }>(choices: Choice[], own: Choice): Choice[] {
	return choices.some(({ id }) => id === own.id) ? choices : [...choices, own];
}
