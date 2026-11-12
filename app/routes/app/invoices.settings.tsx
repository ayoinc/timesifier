import * as z from "zod";

import { Checkbox } from "~/components/Checkbox";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { TextField } from "~/components/TextField";
import { ActionForm } from "~/invoices/ActionForm";
import { BillingTabs } from "~/invoices/BillingTabs";
import { billingOf } from "~/invoices/context.server";
import { invoiceDetailsOf, percentText, taxesOf } from "~/invoices/documents.server";
import { answered, readForm, refuse } from "~/invoices/form.server";
import {
	addTax,
	MOST_ACTIVE_TAXES,
	saveInvoiceDetails,
	setTaxArchived,
} from "~/invoices/settings.server";
import { parsePercent } from "~/money/typed";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";

import type { Route } from "./+types/invoices.settings";

// Invoice settings (TS-074): what every invoice and estimate prints about the
// organisation, its payment terms and default notes, when overdue invoices
// are reminded, and its taxes, at most two active at once.

export function meta() {
	return [{ title: "Invoice settings · Timesifier" }];
}

/** Text that may be left empty: empty is none. */
const Optional = (max: number) =>
	z
		.string()
		.trim()
		.max(max, `Use up to ${max} characters.`)
		.transform((value) => (value === "" ? null : value));

/** A number of days from `min` to 365, as typed. */
const daysProblem = (min: number) => `Enter a whole number of days from ${min} to 365.`;
const isDays = (value: string, min: number) =>
	/^\d{1,3}$/.test(value) && Number(value) >= min && Number(value) <= 365;

const OptionalDays = z
	.string()
	.trim()
	.refine((value) => value === "" || isDays(value, 1), `${daysProblem(1)} Or leave it empty.`)
	.transform((value) => (value === "" ? null : Number(value)));

const Id = z.string().min(1).max(64);

const Form = z.discriminatedUnion("intent", [
	z.object({
		intent: z.literal("details"),
		legalName: Optional(200),
		address: Optional(500),
		taxNumber: Optional(100),
		paymentTermsDays: z
			.string()
			.trim()
			.refine((value) => isDays(value, 0), daysProblem(0))
			.transform(Number),
		defaultNotes: Optional(2000),
		lateReminderAfterDays: OptionalDays,
		lateReminderEveryDays: OptionalDays,
	}),
	z.object({
		intent: z.literal("add-tax"),
		name: z.string().trim().min(1, "Name the tax.").max(50, "Use up to 50 characters."),
		rate: z
			.string()
			.trim()
			.refine(
				(value) => parsePercent(value) !== null,
				"Enter a rate from 0 to 100, such as 20 or 17.5.",
			),
		compound: z.literal("on").optional(),
	}),
	z.object({ intent: z.literal("archive-tax"), taxId: Id }),
	z.object({ intent: z.literal("restore-tax"), taxId: Id }),
]);

export async function loader({ request, context }: Route.LoaderArgs) {
	const { scope, organisation } = await billingOf(context, request);
	const [details, taxes] = await Promise.all([invoiceDetailsOf(scope), taxesOf(scope)]);
	return {
		slug: organisation.slug,
		// The page reads it here: settings.server is not sent to the browser.
		mostTaxes: MOST_ACTIVE_TAXES,
		details: {
			legalName: details.legalName ?? "",
			address: details.address ?? "",
			taxNumber: details.taxNumber ?? "",
			paymentTermsDays: String(details.paymentTermsDays),
			defaultNotes: details.defaultNotes ?? "",
			lateReminderAfterDays: details.lateReminderAfterDays?.toString() ?? "",
			lateReminderEveryDays: details.lateReminderEveryDays?.toString() ?? "",
		},
		taxes: taxes.map((tax) => ({
			id: tax.id,
			name: tax.name,
			rate: percentText(tax.rateBasisPoints),
			compound: tax.compound,
			archived: tax.archivedAt !== null,
		})),
	};
}

export async function action({ request, context }: Route.ActionArgs) {
	const { scope } = await billingOf(context, request);
	const form = await readForm(request, Form);
	if ("refusal" in form) return form.refusal;
	const { input } = form;
	switch (input.intent) {
		case "details": {
			if (input.lateReminderEveryDays !== null && input.lateReminderAfterDays === null) {
				return refuse("Say when the first reminder goes before how often it repeats.", {
					lateReminderAfterDays: ["Enter the days after the due date of the first reminder."],
				});
			}
			const { intent: _, ...details } = input;
			await saveInvoiceDetails(scope, details);
			return answered("Invoice settings saved.");
		}
		case "add-tax": {
			const result = await addTax(scope, {
				name: input.name,
				rateBasisPoints: parsePercent(input.rate) ?? 0,
				compound: input.compound === "on",
			});
			if (!result?.ok) return refuse(result?.problem ?? "That tax could not be added.");
			return answered(`${input.name} added.`);
		}
		case "archive-tax":
		case "restore-tax": {
			const result = await setTaxArchived(scope, input.taxId, input.intent === "archive-tax");
			if (result === null) return refuse("That tax is not one of this organisation's.", {}, 404);
			if (!result.ok) return refuse(result.problem);
			return answered(input.intent === "archive-tax" ? "Tax archived." : "Tax restored.");
		}
	}
}

export default function InvoiceSettings({ loaderData }: Route.ComponentProps) {
	const { slug, details, taxes, mostTaxes } = loaderData;
	return (
		<>
			<PageHeading>Invoice settings</PageHeading>
			<PageLead>
				What your invoices and estimates say about you, when payment is due, and when clients are
				reminded of an overdue invoice.
			</PageLead>
			<BillingTabs slug={slug} current="invoices" />

			<Section id="details" heading="Details">
				<ActionForm intent="details" submitLabel="Save settings" className="mt-4 max-w-120">
					{(field) => (
						<>
							<TextField
								label="Legal name"
								defaultValue={details.legalName}
								{...field("legalName")}
							/>
							<TextField
								label="Address"
								description="As it prints on invoices."
								defaultValue={details.address}
								{...field("address")}
							/>
							<TextField
								label="Tax number"
								defaultValue={details.taxNumber}
								{...field("taxNumber")}
							/>
							<TextField
								label="Payment terms (days)"
								inputMode="numeric"
								isRequired
								defaultValue={details.paymentTermsDays}
								{...field("paymentTermsDays")}
							/>
							<TextField
								label="Default notes"
								defaultValue={details.defaultNotes}
								{...field("defaultNotes")}
							/>
							<TextField
								label="First late reminder (days after due)"
								description="Leave empty to send no reminders."
								inputMode="numeric"
								defaultValue={details.lateReminderAfterDays}
								{...field("lateReminderAfterDays")}
							/>
							<TextField
								label="Repeat reminder every (days)"
								description="Leave empty to remind once."
								inputMode="numeric"
								defaultValue={details.lateReminderEveryDays}
								{...field("lateReminderEveryDays")}
							/>
						</>
					)}
				</ActionForm>
			</Section>

			<Section id="taxes" heading="Taxes">
				<p className="mt-2 max-w-120 text-body-medium text-on-surface-variant">
					A line bears at most {mostTaxes} taxes. A tax is archived rather than deleted: invoices
					already issued name it.
				</p>
				<div className="mt-4 max-w-200">
					<Ledger heading="Taxes" note={taxes.length}>
						{taxes.length > 0 ? (
							<LedgerRows label="Taxes">
								{taxes.map((tax) => (
									<LedgerRow
										key={tax.id}
										title={<span className="wrap-anywhere">{tax.name}</span>}
										detail={[tax.compound ? "Compound" : null, tax.archived ? "Archived" : null]
											.filter(Boolean)
											.join(" · ")}
										value={tax.rate}
										action={
											<ActionForm
												intent={tax.archived ? "restore-tax" : "archive-tax"}
												hidden={{ taxId: tax.id }}
												variant="text"
												submitLabel={tax.archived ? "Restore" : "Archive"}
												submitName={`${tax.archived ? "Restore" : "Archive"} ${tax.name}`}
											/>
										}
									/>
								))}
							</LedgerRows>
						) : (
							<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
								No taxes yet.
							</p>
						)}
					</Ledger>
				</div>
				<ActionForm
					intent="add-tax"
					submitLabel="Add tax"
					variant="outlined"
					className="mt-6 max-w-120"
				>
					{(field) => (
						<>
							<TextField label="Name" isRequired {...field("name")} />
							<TextField label="Rate (%)" inputMode="decimal" isRequired {...field("rate")} />
							<Checkbox name="compound" value="on">
								Compound: charged on the amount with the other tax
							</Checkbox>
						</>
					)}
				</ActionForm>
			</Section>
		</>
	);
}
