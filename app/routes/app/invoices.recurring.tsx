import { asc, isNull } from "drizzle-orm";
import { Link, redirect } from "react-router";
import * as z from "zod";

import { Checkbox } from "~/components/Checkbox";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { ActionForm } from "~/invoices/ActionForm";
import { BillingTabs } from "~/invoices/BillingTabs";
import { billingOf } from "~/invoices/context.server";
import { invoiceDetailsOf } from "~/invoices/documents.server";
import { readForm, refuse } from "~/invoices/form.server";
import { recurringPath } from "~/invoices/paths";
import { FREQUENCY_LABELS, Frequency } from "~/invoices/recurring";
import { createRecurring, recurringOf } from "~/invoices/recurring.server";
import { FREQUENCY_OPTIONS, RecurringFields } from "~/invoices/recurring-form";
import { CurrencyCode } from "~/money/money";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { Day } from "~/time/calendar";
import { formatDay } from "~/time/format";

import type { Route } from "./+types/invoices.recurring";

// Recurring invoices (TS-078): a template of lines for a client that makes an
// invoice every month, three months or year from its first date, until its
// last, and sends it when set to. The scheduler makes them; here they are
// listed and started.

export function meta() {
	return [{ title: "Recurring invoices · Timesifier" }];
}

const Form = z.object({
	intent: z.literal("create"),
	clientId: z.string().min(1, "Choose a client.").max(64),
	currency: z.string().trim().toUpperCase().pipe(CurrencyCode),
	startsOn: Day,
	...RecurringFields,
});

export async function loader({ request, context }: Route.LoaderArgs) {
	const { scope, organisation, today } = await billingOf(context, request);
	const [rows, clients, details] = await Promise.all([
		recurringOf(scope),
		scope.clients.select((c) => isNull(c.archivedAt), { orderBy: (c) => [asc(c.name)] }),
		invoiceDetailsOf(scope),
	]);
	return {
		slug: organisation.slug,
		today,
		currency: organisation.currency,
		paymentTermsDays: String(details.paymentTermsDays),
		clients: clients.map((c) => ({ id: c.id, label: c.name })),
		rows: rows.map((row) => ({
			id: row.id,
			to: recurringPath(organisation.slug, row.id),
			title: row.subject ? `${row.clientName} · ${row.subject}` : row.clientName,
			detail: row.stoppedAt
				? "Stopped"
				: [
						FREQUENCY_LABELS[Frequency.parse(row.frequency)],
						`next ${formatDay(row.nextIssueOn, "short")}`,
						row.endsOn ? `until ${formatDay(row.endsOn, "short")}` : null,
						row.sendAutomatically ? "sent automatically" : "kept as a draft",
					]
						.filter(Boolean)
						.join(" · "),
		})),
	};
}

export async function action({ request, context }: Route.ActionArgs) {
	const { scope, organisation, membership } = await billingOf(context, request);
	const form = await readForm(request, Form);
	if ("refusal" in form) return form.refusal;
	const { intent: _, ...input } = form.input;
	if (input.endsOn !== null && input.endsOn < input.startsOn) {
		const problem = "The last date cannot be before the first.";
		return refuse(problem, { endsOn: [problem] });
	}
	const created = await createRecurring(scope, membership.user.id, input);
	if (!created?.ok) {
		const problem = created?.problem ?? "That could not be saved.";
		return refuse(problem, { clientId: [problem] });
	}
	return redirect(recurringPath(organisation.slug, created.id));
}

export default function RecurringInvoices({ loaderData }: Route.ComponentProps) {
	const { slug, rows, clients } = loaderData;
	return (
		<>
			<PageHeading>Recurring invoices</PageHeading>
			<PageLead>
				Invoices made for a client on a schedule from the same lines, kept as drafts or sent
				automatically.
			</PageLead>
			<BillingTabs slug={slug} current="recurring" />

			<div className="mt-8 max-w-200">
				<Ledger heading="Recurring invoices" note={rows.length}>
					{rows.length > 0 ? (
						<LedgerRows label="Recurring invoices">
							{rows.map((row) => (
								<LedgerRow
									key={row.id}
									title={
										<Link to={row.to} className="wrap-anywhere underline-offset-2 hover:underline">
											{row.title}
										</Link>
									}
									detail={row.detail}
								/>
							))}
						</LedgerRows>
					) : (
						<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
							No recurring invoices yet.
						</p>
					)}
				</Ledger>
			</div>

			<Section id="new-recurring" heading="New recurring invoice">
				{clients.length === 0 ? (
					<p className="mt-4 text-body-large text-on-surface-variant">Add a client first.</p>
				) : (
					<ActionForm intent="create" submitLabel="Set up" className="mt-4 max-w-120">
						{(field) => (
							<>
								<Select label="Client" options={clients} isRequired {...field("clientId")} />
								<Select
									label="How often"
									options={FREQUENCY_OPTIONS}
									defaultValue="monthly"
									isRequired
									{...field("frequency")}
								/>
								<TextField
									label="First issue date"
									type="date"
									defaultValue={loaderData.today}
									isRequired
									{...field("startsOn")}
								/>
								<TextField
									label="Last issue date"
									type="date"
									description="Leave empty to go on until stopped."
									{...field("endsOn")}
								/>
								<TextField
									label="Currency"
									defaultValue={loaderData.currency}
									isRequired
									{...field("currency")}
								/>
								<TextField
									label="Payment terms (days)"
									inputMode="numeric"
									defaultValue={loaderData.paymentTermsDays}
									isRequired
									{...field("paymentTermsDays")}
								/>
								<TextField label="Subject" {...field("subject")} />
								<TextField label="Notes" {...field("notes")} />
								<Checkbox name="sendAutomatically" value="on">
									Send each invoice to the client's contacts when it is made
								</Checkbox>
								<Checkbox name="includeUninvoicedTime" value="on">
									Add the client's uninvoiced time and expenses
								</Checkbox>
							</>
						)}
					</ActionForm>
				)}
			</Section>
		</>
	);
}
