import { asc, isNull } from "drizzle-orm";
import { Link, redirect } from "react-router";
import * as z from "zod";

import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import {
	createEstimate,
	ESTIMATE_LABELS,
	EstimateStatus,
	listEstimates,
} from "~/estimates/estimates.server";
import { ActionForm } from "~/invoices/ActionForm";
import { billingOf } from "~/invoices/context.server";
import { readForm, refuse } from "~/invoices/form.server";
import { estimatePath } from "~/invoices/paths";
import { CurrencyCode, formatMoney } from "~/money/money";
import { destination } from "~/shell/destinations";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { Day } from "~/time/calendar";
import { formatDay } from "~/time/format";

import type { Route } from "./+types/estimates";

// Estimates (TS-077): quotes to a client, sent with a link where the client
// accepts or declines, and made into an invoice once accepted. The list, and
// the form that starts one; the estimate's own page does the rest.

const { label } = destination("estimates");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

const Form = z.object({
	intent: z.literal("create"),
	clientId: z.string().min(1, "Choose a client.").max(64),
	currency: z.string().trim().toUpperCase().pipe(CurrencyCode),
	issuedOn: Day,
	subject: z
		.string()
		.trim()
		.max(200, "Use up to 200 characters.")
		.transform((value) => (value === "" ? null : value)),
});

export async function loader({ request, context }: Route.LoaderArgs) {
	const { scope, organisation, today, locale } = await billingOf(context, request);
	const [estimates, clients] = await Promise.all([
		listEstimates(scope),
		scope.clients.select((c) => isNull(c.archivedAt), { orderBy: (c) => [asc(c.name)] }),
	]);
	return {
		today,
		currency: organisation.currency,
		clients: clients.map((c) => ({ id: c.id, label: c.name })),
		estimates: estimates.map((e) => ({
			id: e.id,
			to: estimatePath(organisation.slug, e.id),
			title: `${e.number} · ${e.clientName}`,
			detail: [
				ESTIMATE_LABELS[EstimateStatus.parse(e.status)],
				e.subject,
				`Issued ${formatDay(e.issuedOn, "short")}`,
			]
				.filter(Boolean)
				.join(" · "),
			total: formatMoney(e.totalMinor, e.currency, locale),
		})),
	};
}

export async function action({ request, context }: Route.ActionArgs) {
	const { scope, organisation, membership } = await billingOf(context, request);
	const form = await readForm(request, Form);
	if ("refusal" in form) return form.refusal;
	const { intent: _, ...input } = form.input;
	const created = await createEstimate(scope, membership.user.id, {
		...input,
		poNumber: null,
		notes: null,
		discountBasisPoints: 0,
	});
	if (!created?.ok) {
		return refuse(created?.problem ?? "That estimate could not be started.", {
			clientId: [created?.problem ?? "Choose an active client."],
		});
	}
	return redirect(estimatePath(organisation.slug, created.id));
}

export default function Estimates({ loaderData }: Route.ComponentProps) {
	const { estimates, clients } = loaderData;
	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>
				Quotes for your clients. Send one and the client accepts or declines it on its link; an
				accepted estimate becomes an invoice.
			</PageLead>

			<div className="mt-8 max-w-200">
				<Ledger heading="Estimates" note={estimates.length}>
					{estimates.length > 0 ? (
						<LedgerRows label="Estimates">
							{estimates.map((estimate) => (
								<LedgerRow
									key={estimate.id}
									title={
										<Link
											to={estimate.to}
											className="wrap-anywhere underline-offset-2 hover:underline"
										>
											{estimate.title}
										</Link>
									}
									detail={estimate.detail}
									value={estimate.total}
								/>
							))}
						</LedgerRows>
					) : (
						<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
							No estimates yet. Start one below.
						</p>
					)}
				</Ledger>
			</div>

			<Section id="new-estimate" heading="New estimate">
				{clients.length === 0 ? (
					<p className="mt-4 text-body-large text-on-surface-variant">
						Add a client first: an estimate is for one client.
					</p>
				) : (
					<ActionForm intent="create" submitLabel="Start estimate" className="mt-4 max-w-120">
						{(field) => (
							<>
								<Select label="Client" options={clients} isRequired {...field("clientId")} />
								<TextField
									label="Currency"
									defaultValue={loaderData.currency}
									isRequired
									{...field("currency")}
								/>
								<TextField
									label="Issue date"
									type="date"
									defaultValue={loaderData.today}
									isRequired
									{...field("issuedOn")}
								/>
								<TextField label="Subject" {...field("subject")} />
							</>
						)}
					</ActionForm>
				)}
			</Section>
		</>
	);
}
