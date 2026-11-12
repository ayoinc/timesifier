import { and, eq, isNull } from "drizzle-orm";
import { Link } from "react-router";
import * as z from "zod";

import { Checkbox } from "~/components/Checkbox";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { ActionForm, LineFields } from "~/invoices/ActionForm";
import { BillingTabs } from "~/invoices/BillingTabs";
import { billingOf } from "~/invoices/context.server";
import { percentText, taxesOf } from "~/invoices/documents.server";
import { answered, lineRefusal, outcomeOf, readForm, refuse } from "~/invoices/form.server";
import { LineFields as LineFieldSchema, parseLine } from "~/invoices/line-input";
import { quantityText } from "~/invoices/lines";
import { recurringListPath } from "~/invoices/paths";
import { FREQUENCY_LABELS, Frequency } from "~/invoices/recurring";
import {
	addRecurringLine,
	findRecurring,
	removeRecurringLine,
	stopRecurring,
} from "~/invoices/recurring.server";
import { FREQUENCY_OPTIONS, RecurringFields } from "~/invoices/recurring-form";
import { formatMoney, lineAmount } from "~/money/money";
import { moneyText } from "~/money/typed";
import { notFound } from "~/organisations/membership.server";
import { ACTION_LINK } from "~/shell/links";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { Day } from "~/time/calendar";
import { formatDay, formatDayAndTime } from "~/time/format";

import type { Route } from "./+types/invoices.recurring.$recurring";

// One recurring invoice (TS-078): its schedule and terms, the lines each
// invoice is made with, and stopping it. The invoices already made keep what
// they were made with.

export function meta() {
	return [{ title: "Recurring invoice · Timesifier" }];
}

const Form = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("change"), nextIssueOn: Day, ...RecurringFields }),
	z.object({ intent: z.literal("add-line"), ...LineFieldSchema }),
	z.object({ intent: z.literal("remove-line"), lineId: z.string().min(1).max(64) }),
	z.object({ intent: z.literal("stop") }),
]);

export async function loader({ request, context, params }: Route.LoaderArgs) {
	const { scope, organisation, locale } = await billingOf(context, request);
	const [found, taxes] = await Promise.all([
		findRecurring(scope, params.recurring),
		taxesOf(scope),
	]);
	if (!found) throw notFound();
	const { recurring, lines, clientName } = found;
	const frequency = Frequency.parse(recurring.frequency);
	const currency = recurring.currency;
	return {
		slug: organisation.slug,
		clientName,
		recurring: {
			currency,
			frequency,
			frequencyLabel: FREQUENCY_LABELS[frequency],
			nextIssueOn: recurring.nextIssueOn,
			nextIssueText: formatDay(recurring.nextIssueOn),
			endsOn: recurring.endsOn ?? "",
			sendAutomatically: recurring.sendAutomatically,
			includeUninvoicedTime: recurring.includeUninvoicedTime,
			paymentTermsDays: String(recurring.paymentTermsDays),
			subject: recurring.subject ?? "",
			notes: recurring.notes ?? "",
			stopped: recurring.stoppedAt
				? formatDayAndTime(recurring.stoppedAt.getTime(), organisation.timeZone)
				: null,
		},
		lines: lines.map((line) => ({
			id: line.id,
			description: line.description,
			detail: `${quantityText(line.quantityMilli)} × ${moneyText(line.unitPriceMinor, currency)}`,
			amount: formatMoney(lineAmount(line.quantityMilli, line.unitPriceMinor), currency, locale),
		})),
		taxes: taxes
			.filter((tax) => tax.archivedAt === null)
			.map((tax) => ({ id: tax.id, label: `${tax.name} (${percentText(tax.rateBasisPoints)})` })),
	};
}

export async function action({ request, context, params }: Route.ActionArgs) {
	const { scope, now } = await billingOf(context, request);
	const form = await readForm(request, Form);
	if ("refusal" in form) return form.refusal;
	const { input } = form;
	const id = params.recurring;
	const found = await findRecurring(scope, id);
	if (!found) throw notFound();

	switch (input.intent) {
		case "change": {
			const { intent: _, ...change } = input;
			if (change.endsOn !== null && change.endsOn < change.nextIssueOn) {
				const problem = "The last date cannot be before the next.";
				return refuse(problem, { endsOn: [problem] });
			}
			const changed = await scope.recurringInvoices.update(
				{ ...change, updatedAt: new Date(now) },
				(r) => and(eq(r.id, id), isNull(r.stoppedAt)),
			);
			return changed.length > 0
				? answered("The recurring invoice is saved.")
				: refuse("That recurring invoice has stopped.");
		}
		case "add-line": {
			const parsed = parseLine(input, found.recurring.currency);
			if (!parsed.ok) return lineRefusal(parsed.problem);
			return outcomeOf(await addRecurringLine(scope, id, parsed.line), () => "Line added.");
		}
		case "remove-line":
			return outcomeOf(await removeRecurringLine(scope, id, input.lineId), () => "Line removed.");
		case "stop": {
			const stopped = await stopRecurring(scope, id, new Date(now));
			return stopped
				? answered("Stopped. No more invoices are made from it.")
				: refuse("That recurring invoice has stopped already.");
		}
	}
}

export default function RecurringInvoice({ loaderData }: Route.ComponentProps) {
	const { slug, recurring, lines, taxes } = loaderData;
	const running = recurring.stopped === null;
	return (
		<>
			<p>
				<Link to={recurringListPath(slug)} className={ACTION_LINK}>
					Recurring invoices
				</Link>
			</p>
			<PageHeading>
				{loaderData.clientName}
				{recurring.subject ? ` · ${recurring.subject}` : ""}
			</PageHeading>
			<PageLead>
				{running
					? `${recurring.frequencyLabel}. The next invoice is made on ${recurring.nextIssueText}${recurring.sendAutomatically ? " and sent" : " as a draft"}.`
					: `Stopped ${recurring.stopped}.`}
			</PageLead>
			<BillingTabs slug={slug} current="recurring" />

			<Section id="lines" heading="Lines">
				<div className="mt-4 max-w-200">
					<Ledger heading="Lines" note={lines.length}>
						{lines.length > 0 ? (
							<LedgerRows label="Lines">
								{lines.map((line) => (
									<LedgerRow
										key={line.id}
										title={<span className="wrap-anywhere">{line.description}</span>}
										detail={line.detail}
										value={line.amount}
										action={
											running ? (
												<ActionForm
													intent="remove-line"
													hidden={{ lineId: line.id }}
													variant="text"
													submitLabel="Remove"
													submitName={`Remove ${line.description}`}
												/>
											) : null
										}
									/>
								))}
							</LedgerRows>
						) : (
							<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
								No lines yet. An invoice is made only with lines or uninvoiced time.
							</p>
						)}
					</Ledger>
				</div>
				{running && (
					<ActionForm intent="add-line" submitLabel="Add line" className="mt-6 max-w-120">
						{(field) => <LineFields field={field} taxes={taxes} currency={recurring.currency} />}
					</ActionForm>
				)}
			</Section>

			{running && (
				<>
					<Section id="schedule" heading="Schedule and terms">
						<ActionForm intent="change" submitLabel="Save" className="mt-4 max-w-120">
							{(field) => (
								<>
									<Select
										label="How often"
										options={FREQUENCY_OPTIONS}
										defaultValue={recurring.frequency}
										isRequired
										{...field("frequency")}
									/>
									<TextField
										label="Next issue date"
										type="date"
										defaultValue={recurring.nextIssueOn}
										isRequired
										{...field("nextIssueOn")}
									/>
									<TextField
										label="Last issue date"
										type="date"
										description="Leave empty to go on until stopped."
										defaultValue={recurring.endsOn}
										{...field("endsOn")}
									/>
									<TextField
										label="Payment terms (days)"
										inputMode="numeric"
										defaultValue={recurring.paymentTermsDays}
										isRequired
										{...field("paymentTermsDays")}
									/>
									<TextField
										label="Subject"
										defaultValue={recurring.subject}
										{...field("subject")}
									/>
									<TextField label="Notes" defaultValue={recurring.notes} {...field("notes")} />
									<Checkbox
										name="sendAutomatically"
										value="on"
										defaultSelected={recurring.sendAutomatically}
									>
										Send each invoice to the client's contacts when it is made
									</Checkbox>
									<Checkbox
										name="includeUninvoicedTime"
										value="on"
										defaultSelected={recurring.includeUninvoicedTime}
									>
										Add the client's uninvoiced time and expenses
									</Checkbox>
								</>
							)}
						</ActionForm>
					</Section>

					<Section id="stop" heading="Stop">
						<p className="mt-2 max-w-120 text-body-medium text-on-surface-variant">
							No more invoices are made from it. The ones already made stay.
						</p>
						<ActionForm
							intent="stop"
							submitLabel="Stop recurring invoice"
							variant="outlined-danger"
							className="mt-4"
						/>
					</Section>
				</>
			)}
		</>
	);
}
