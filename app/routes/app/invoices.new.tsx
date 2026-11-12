import { asc, isNull } from "drizzle-orm";
import { Form, redirect, useActionData } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Checkbox } from "~/components/Checkbox";
import { cx } from "~/components/cx";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { BillingTabs } from "~/invoices/BillingTabs";
import { billingOf } from "~/invoices/context.server";
import { createDraft } from "~/invoices/invoices.server";
import { GROUPING_LABELS, Grouping, hoursMilli, quantityText } from "~/invoices/lines";
import { invoicePath } from "~/invoices/paths";
import { type SourceRequest, sourcesFor } from "~/invoices/sources.server";
import { parseRequest } from "~/lib/validate";
import { formatMoney } from "~/money/money";
import { moneyText, parseMoney } from "~/money/typed";
import { declined } from "~/organisations/outcome.server";
import type { Outcome } from "~/organisations/problems";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { Day } from "~/time/calendar";
import { formatDay } from "~/time/format";

import type { Route } from "./+types/invoices.new";

// A new invoice from tracked time and expenses (TS-073). A person chooses a
// client, a range and its projects, and how time becomes lines; the page
// shows the billable time and expenses on no invoice yet, flags time in
// periods not approved, and each fixed-fee project's fee still to invoice.
// Saving makes a draft with the organisation's next number, and those entries
// and expenses are invoiced on it. The choices are in the address, so the
// preview is a link, and the action works the preview out again from them:
// nothing the browser says about amounts is believed.

export function meta() {
	return [{ title: "New invoice · Timesifier" }];
}

const Id = z.string().min(1).max(64);
const OptionalDay = z.union([Day, z.literal("")]).optional();

/** The choices, as the address or the form carries them. A fixed fee's part is `fee-<project id>`. */
const Choices = z.looseObject({
	client: Id.optional(),
	from: OptionalDay,
	to: OptionalDay,
	project: z.union([Id, z.array(Id).max(500)]).optional(),
	group: Grouping.optional(),
});
type Choices = z.output<typeof Choices>;

const FEE_PREFIX = "fee-";

/** The address's choices as the schema reads them: a name sent more than once is a list. */
function choicesIn(search: URLSearchParams): Choices | null {
	const fields: Record<string, string | string[]> = {};
	for (const key of new Set(search.keys())) {
		const values = search.getAll(key);
		fields[key] = values.length === 1 ? (values[0] ?? "") : values;
	}
	const parsed = Choices.safeParse(fields);
	return parsed.success ? parsed.data : null;
}

/** The fixed fees typed, by project, each still text. */
function feesIn(choices: Choices): Map<string, string> {
	return new Map(
		Object.entries(choices)
			.filter(([key, value]) => key.startsWith(FEE_PREFIX) && typeof value === "string")
			.map(([key, value]) => [key.slice(FEE_PREFIX.length), String(value).trim()]),
	);
}

/** What the choices ask for, or a sentence for one that cannot be read. */
function sourceRequest(
	choices: Choices,
	currencyOf: (projectId: string) => string | undefined,
): { request: SourceRequest } | { problem: string } {
	const from = choices.from || null;
	const to = choices.to || null;
	if ((from === null) !== (to === null)) {
		return {
			problem: "Give both the first and the last day, or neither for everything until today.",
		};
	}
	if (from !== null && to !== null && to < from) {
		return { problem: "The last day cannot be before the first." };
	}
	const fixedMinor = new Map<string, number>();
	for (const [projectId, text] of feesIn(choices)) {
		if (text === "") continue;
		const currency = currencyOf(projectId);
		const minor = currency ? parseMoney(text, currency) : null;
		if (minor === null)
			return { problem: "Enter each fixed fee to invoice as an amount, such as 1500.00." };
		fixedMinor.set(projectId, minor);
	}
	const projects = choices.project;
	return {
		request: {
			clientId: choices.client ?? "",
			days: from !== null && to !== null ? { first: from, last: to } : null,
			projectIds: projects === undefined ? [] : Array.isArray(projects) ? projects : [projects],
			grouping: choices.group ?? "project",
			fixedMinor,
		},
	};
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const { scope, organisation, now, locale } = await billingOf(context, request);
	const choices = choicesIn(new URL(request.url).searchParams) ?? {};
	const clients = await scope.clients.select((c) => isNull(c.archivedAt), {
		orderBy: (c) => [asc(c.nameKey)],
	});
	const base = {
		slug: organisation.slug,
		clients: clients.map((c) => ({ id: c.id, label: c.name })),
		choices: {
			client: choices.client ?? "",
			from: choices.from ?? "",
			to: choices.to ?? "",
			group: choices.group ?? "project",
			projects: choices.project === undefined ? [] : [choices.project].flat(),
			fees: Object.fromEntries(feesIn(choices)),
		},
	};
	if (!choices.client || !clients.some((c) => c.id === choices.client)) {
		return { ...base, preview: null };
	}

	const first = await sourcesFor(
		scope,
		organisation,
		{
			clientId: choices.client,
			days: null,
			projectIds: [],
			grouping: "project",
			fixedMinor: new Map(),
			includeTime: false,
		},
		now,
	);
	const asked = sourceRequest(choices, (id) => first.projects.find((p) => p.id === id)?.currency);
	if ("problem" in asked)
		return {
			...base,
			preview: {
				problem: asked.problem,
				projects: first.projects.map(offered(locale)),
				entries: [],
				expenses: [],
				lines: [],
				subtotal: "",
				canCreate: false,
				unapproved: 0,
				unpriced: 0,
			},
		};
	const sources = await sourcesFor(scope, organisation, asked.request, now);
	const currency = sources.currency ?? organisation.currency;
	const money = (minor: number) => formatMoney(minor, currency, locale);
	const subtotal = sources.lines.reduce((sum, line) => sum + line.amountMinor, 0);
	return {
		...base,
		preview: {
			problem: sources.problem,
			projects: sources.projects.map(offered(locale)),
			entries: sources.entries.map((e) => ({
				id: e.id,
				title: e.description ?? e.taskName ?? "No description",
				detail: [formatDay(e.day), e.personName, e.projectName, e.taskName]
					.filter(Boolean)
					.join(" · "),
				approved: e.approved,
				priced: e.priced,
				hours: quantityText(hoursMilli(e.minutes)),
				amount: e.priced ? money(Math.round(e.minuteMinor / 60)) : "No rate",
			})),
			expenses: sources.expenses.map((x) => ({
				id: x.id,
				title: x.categoryName,
				detail: [formatDay(x.spentOn), x.projectName, x.notes].filter(Boolean).join(" · "),
				amount: formatMoney(x.amountMinor, x.currency, locale),
			})),
			lines: sources.lines.map((line, index) => ({
				key: `${index}`,
				description: line.description,
				detail:
					line.kind === "time"
						? `${quantityText(line.quantityMilli)} hours · ${line.timeEntryIds.length} ${line.timeEntryIds.length === 1 ? "entry" : "entries"}`
						: line.kind === "expense"
							? "Expense"
							: "Fixed fee",
				amount: money(line.amountMinor),
			})),
			subtotal: money(subtotal),
			canCreate: sources.problem === null && sources.lines.length > 0,
			unapproved: sources.entries.filter((e) => !e.approved).length,
			unpriced: sources.entries.filter((e) => !e.priced).length,
		},
	};
}

/** A project as the choices show it, with a fixed fee's part still to invoice. */
function offered(locale: string) {
	return (p: {
		id: string;
		name: string;
		billingType: string;
		currency: string;
		feeLeftMinor: number | null;
	}) => ({
		id: p.id,
		name: p.name,
		fixed: p.billingType === "fixed_fee",
		feeLeft: p.feeLeftMinor === null ? null : formatMoney(p.feeLeftMinor, p.currency, locale),
		feeLeftText: p.feeLeftMinor === null ? "" : moneyText(p.feeLeftMinor, p.currency),
	});
}

export async function action({ request, context }: Route.ActionArgs) {
	const choices = await parseRequest(request, Choices);
	if (!choices.client) return declined("Choose a client.");
	const { scope, organisation, now, today, membership } = await billingOf(context, request);
	const offeredProjects = await sourcesFor(
		scope,
		organisation,
		{
			clientId: choices.client,
			days: null,
			projectIds: [],
			grouping: "project",
			fixedMinor: new Map(),
			includeTime: false,
		},
		now,
	);
	const asked = sourceRequest(
		choices,
		(id) => offeredProjects.projects.find((p) => p.id === id)?.currency,
	);
	if ("problem" in asked) return declined(asked.problem);
	const sources = await sourcesFor(scope, organisation, asked.request, now);
	if (sources.problem) return declined(sources.problem);
	if (!sources.currency)
		return declined("There is nothing to invoice for that client, range and projects.");
	const created = await createDraft(scope, membership.user.id, {
		clientId: choices.client,
		currency: sources.currency,
		issuedOn: today,
		lines: sources.lines,
	});
	if (!created.ok) return declined(created.problem, 409);
	return redirect(invoicePath(organisation.slug, created.id));
}

export default function NewInvoice({ loaderData }: Route.ComponentProps) {
	const { slug, clients, choices, preview } = loaderData;
	const refused = useActionData<Outcome>();
	const canCreate = preview !== null && "canCreate" in preview && preview.canCreate;

	return (
		<>
			<PageHeading>New invoice</PageHeading>
			<PageLead>
				Choose a client and a range. The billable time and expenses of its projects that are on no
				invoice yet become the lines of a draft, which you can change before you issue it.
			</PageLead>
			<BillingTabs slug={slug} current="invoices" />

			{clients.length === 0 ? (
				<p className="mt-8 max-w-160 text-body-large text-on-surface-variant">
					An invoice is for a client, and this organisation has none. Add one on Clients first.
				</p>
			) : (
				<Form
					method="get"
					aria-label="What to invoice"
					className="mt-8 max-w-200"
					key={JSON.stringify(choices)}
				>
					<div className="grid gap-6 medium:grid-cols-2">
						<Select
							label="Client"
							name="client"
							options={clients}
							defaultValue={choices.client || null}
							isRequired
						/>
						<Select
							label="Lines of time"
							name="group"
							options={Grouping.options.map((id) => ({ id, label: GROUPING_LABELS[id] }))}
							defaultValue={choices.group}
						/>
						<TextField
							label="First day"
							name="from"
							type="date"
							defaultValue={choices.from}
							description="Leave both days empty for everything until today."
						/>
						<TextField label="Last day" name="to" type="date" defaultValue={choices.to} />
					</div>
					{preview && preview.projects.length > 0 && (
						<fieldset className="mt-6">
							<legend className="text-title-medium">Projects</legend>
							<p className="mt-1 text-body-medium text-on-surface-variant">
								None ticked takes all of them.
							</p>
							<div className="mt-2 flex flex-col gap-1">
								{preview.projects.map((project) => (
									<div key={project.id} className="flex flex-wrap items-end gap-x-6 gap-y-2">
										<Checkbox
											name="project"
											value={project.id}
											defaultSelected={choices.projects.includes(project.id)}
										>
											{project.name}
											{project.fixed ? ` (fixed fee, ${project.feeLeft} left)` : ""}
										</Checkbox>
										{project.fixed && (
											<div className="w-48">
												<TextField
													label={`Part of the fee to invoice, ${project.name}`}
													name={`${FEE_PREFIX}${project.id}`}
													inputMode="decimal"
													defaultValue={choices.fees[project.id] ?? project.feeLeftText}
												/>
											</div>
										)}
									</div>
								))}
							</div>
						</fieldset>
					)}
					<div className="mt-6">
						<Button type="submit" variant={canCreate ? "outlined" : "filled"}>
							Show what can be invoiced
						</Button>
					</div>
				</Form>
			)}

			{preview?.problem && (
				<p role="alert" className="mt-6 max-w-160 text-body-large text-error">
					{preview.problem}
				</p>
			)}

			{preview && "lines" in preview && (
				<>
					<Section
						id="lines"
						heading="The draft's lines"
						lead="What the draft will hold. Its subtotal is what the time and expenses below are worth together."
					>
						<div className="max-w-200">
							<Ledger heading="Lines" note={preview.lines.length}>
								{preview.lines.length === 0 ? (
									<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
										Nothing to invoice for this client, range and projects.
									</p>
								) : (
									<LedgerRows label="Lines">
										{preview.lines.map((line) => (
											<LedgerRow
												key={line.key}
												title={<span className="wrap-anywhere">{line.description}</span>}
												detail={line.detail}
												value={line.amount}
											/>
										))}
									</LedgerRows>
								)}
								<LedgerTotal label="Subtotal" value={preview.subtotal} />
							</Ledger>
							<Form method="post" className="mt-6 flex flex-col items-start gap-3">
								<input type="hidden" name="client" value={choices.client} />
								<input type="hidden" name="from" value={choices.from} />
								<input type="hidden" name="to" value={choices.to} />
								<input type="hidden" name="group" value={choices.group} />
								{choices.projects.map((id) => (
									<input key={id} type="hidden" name="project" value={id} />
								))}
								{Object.entries(choices.fees).map(([id, text]) => (
									<input key={id} type="hidden" name={`${FEE_PREFIX}${id}`} value={text} />
								))}
								<p role="alert" className="text-body-medium text-error empty:hidden">
									{refused && !refused.ok ? refused.problem : null}
								</p>
								<Button type="submit" isDisabled={!canCreate}>
									Create draft invoice
								</Button>
							</Form>
						</div>
					</Section>

					<Section
						id="time"
						heading="Time"
						lead={`Billable time on no invoice yet.${preview.unapproved > 0 ? ` ${preview.unapproved} in periods not approved are flagged, and included.` : ""}${preview.unpriced > 0 ? ` ${preview.unpriced} without a rate are left off until one is set.` : ""}`}
					>
						<div className="max-w-200">
							<Ledger heading="Entries" note={preview.entries.length}>
								{preview.entries.length === 0 ? (
									<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
										No uninvoiced billable time in this range.
									</p>
								) : (
									<LedgerRows label="Entries">
										{preview.entries.map((entry) => (
											<LedgerRow
												key={entry.id}
												title={<span className="wrap-anywhere">{entry.title}</span>}
												detail={
													<span className="wrap-anywhere">
														{entry.detail}
														{!entry.approved && <span className="text-error"> · Not approved</span>}
													</span>
												}
												aside={`${entry.hours} h`}
												value={
													<span className={cx(!entry.priced && "text-error")}>{entry.amount}</span>
												}
											/>
										))}
									</LedgerRows>
								)}
							</Ledger>
						</div>
					</Section>

					<Section id="expenses" heading="Expenses" lead="Billable expenses on no invoice yet.">
						<div className="max-w-200">
							<Ledger heading="Expenses" note={preview.expenses.length}>
								{preview.expenses.length === 0 ? (
									<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
										No uninvoiced billable expenses in this range.
									</p>
								) : (
									<LedgerRows label="Expenses">
										{preview.expenses.map((expense) => (
											<LedgerRow
												key={expense.id}
												title={expense.title}
												detail={<span className="wrap-anywhere">{expense.detail}</span>}
												value={expense.amount}
											/>
										))}
									</LedgerRows>
								)}
							</Ledger>
						</div>
					</Section>
				</>
			)}
		</>
	);
}
