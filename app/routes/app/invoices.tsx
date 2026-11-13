import { desc, inArray } from "drizzle-orm";
import { Link, useNavigate } from "react-router";

import { Button } from "~/components/Button";
import { cx } from "~/components/cx";
import { DownloadLink } from "~/components/DownloadLink";
import { FilterBar, useApplyFilters } from "~/components/FilterBar";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { BillingTabs } from "~/invoices/BillingTabs";
import { billingOf } from "~/invoices/context.server";
import { settledOf } from "~/invoices/invoices.server";
import { invoicePath, invoiceSettingsPath, newInvoicePath, xeroExportPath } from "~/invoices/paths";
import { receivablesOf } from "~/invoices/receivables.server";
import { balanceOf, type InvoiceStatus, OWING, STATE_LABELS, stateOf } from "~/invoices/status";
import { formatMoney } from "~/money/money";
import { destination } from "~/shell/destinations";
import { ACTION_LINK, TEXT_LINK } from "~/shell/links";
import { PageHeading, PageLead } from "~/shell/PageHeading";
import { formatDay } from "~/time/format";

import type { Route } from "./+types/invoices";

// Invoices (TS-073, TS-074): what the organisation charges its clients, with
// what is owed on each. Owners, admins and Finance are shown it; everyone
// else gets the organisation layout's 404. The headline is what clients owe
// now, and how much of it is overdue; the list is the invoices of one state.

const { label } = destination("invoices");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

/** Which invoices the list shows, in the address as `?show=`. */
const SHOWN = ["open", "draft", "paid", "void", "all"] as const;
type Shown = (typeof SHOWN)[number];
const SHOWN_LABELS: Record<Shown, string> = {
	open: "Open",
	draft: "Drafts",
	paid: "Paid",
	void: "Void",
	all: "All",
};
const STATUSES: Record<Shown, readonly InvoiceStatus[] | null> = {
	open: OWING,
	draft: ["draft"],
	paid: ["paid"],
	void: ["void"],
	all: null,
};

export async function loader({ request, context }: Route.LoaderArgs) {
	const { scope, organisation, today, locale } = await billingOf(context, request);
	const asked = new URL(request.url).searchParams.get("show");
	const show: Shown = SHOWN.find((each) => each === asked) ?? "open";
	const statuses = STATUSES[show];
	const [rows, clients, receivables, any] = await Promise.all([
		scope.invoices.select((i) => (statuses ? inArray(i.status, [...statuses]) : undefined), {
			orderBy: (i) => [desc(i.issuedOn), desc(i.createdAt)],
		}),
		scope.clients.select(),
		receivablesOf(scope, today),
		scope.invoices.select(undefined, { limit: 1 }),
	]);
	const settled = await settledOf(
		scope,
		rows.map((row) => row.id),
	);
	const clientName = new Map(clients.map((c) => [c.id, c.name]));
	return {
		slug: organisation.slug,
		show,
		hasInvoices: any.length > 0,
		hasClients: clients.length > 0,
		receivables: receivables.map((r) => ({
			currency: r.currency,
			outstanding: formatMoney(r.outstandingMinor, r.currency, locale),
			overdue: r.overdueMinor > 0 ? formatMoney(r.overdueMinor, r.currency, locale) : null,
		})),
		invoices: rows.map((row) => {
			const sums = settled.get(row.id) ?? { paidMinor: 0, writtenOffMinor: 0 };
			const state = stateOf(row, sums, today);
			return {
				id: row.id,
				number: row.number,
				client: clientName.get(row.clientId) ?? "",
				detail:
					row.status === "draft"
						? `Draft · ${formatDay(row.issuedOn)}`
						: `Issued ${formatDay(row.issuedOn)} · due ${formatDay(row.dueOn)}`,
				state,
				stateLabel: STATE_LABELS[state],
				amount: formatMoney(
					row.status === "draft" || row.status === "void"
						? row.totalMinor
						: balanceOf(row.totalMinor, sums),
					row.currency,
					locale,
				),
				amountLabel: row.status === "draft" || row.status === "void" ? "Total" : "Balance",
			};
		}),
	};
}

export default function Invoices({ loaderData }: Route.ComponentProps) {
	const { slug, show, invoices, receivables, hasInvoices, hasClients } = loaderData;
	const navigate = useNavigate();
	const create = (
		<Button onPress={() => navigate(newInvoicePath(slug))} isDisabled={!hasClients}>
			New invoice
		</Button>
	);

	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>
				What you charge your clients, with your legal name, taxes and terms in{" "}
				<Link to={invoiceSettingsPath(slug)} className={TEXT_LINK}>
					invoice settings
				</Link>
				.
			</PageLead>
			<BillingTabs slug={slug} current="invoices" />

			{/* The one big number: what clients owe now. */}
			<div className="mt-8 max-w-200">
				{receivables.length === 0 ? (
					<p className="text-title-large text-on-surface-variant">Nothing is owed to you now.</p>
				) : (
					<dl className="flex flex-wrap gap-x-12 gap-y-4">
						{receivables.map((r) => (
							<div key={r.currency}>
								<dt className="text-label-large text-on-surface-variant">Outstanding</dt>
								<dd className="text-display-small tabular-nums">{r.outstanding}</dd>
								{r.overdue && (
									<dd className="mt-1 text-body-large text-error">{r.overdue} overdue</dd>
								)}
							</div>
						))}
					</dl>
				)}
			</div>

			<div className="mt-8 max-w-200">
				{!hasInvoices ? (
					<Ledger heading="Invoices" note={0}>
						<div className="flex flex-col items-start gap-4 border-t border-outline-variant px-4 py-6 @sm:px-5">
							<h2 className="text-title-large">No invoices yet</h2>
							<p className="max-w-160 text-body-large text-on-surface-variant">
								{hasClients
									? "Choose a client and a range: the billable time and expenses not yet invoiced become the lines of a draft."
									: "An invoice is for a client. Add one on Clients, give it projects, and its billable time can be invoiced here."}
							</p>
							{create}
						</div>
					</Ledger>
				) : (
					<>
						<div className="flex flex-wrap items-center gap-4">
							{create}
							<DownloadLink href={xeroExportPath(slug)} className={ACTION_LINK}>
								Export for Xero
							</DownloadLink>
						</div>
						<div className="mt-6">
							<FilterBar name="Filter invoices">
								<StatusChoice show={show} />
							</FilterBar>
						</div>
						<div className="mt-4">
							<Ledger heading={`${SHOWN_LABELS[show]} invoices`} note={invoices.length}>
								{invoices.length === 0 ? (
									<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
										No {SHOWN_LABELS[show].toLowerCase()} invoices.
									</p>
								) : (
									<LedgerRows label={`${SHOWN_LABELS[show]} invoices`}>
										{invoices.map((invoice) => (
											<LedgerRow
												key={invoice.id}
												title={
													<Link to={invoicePath(slug, invoice.id)} className={TEXT_LINK}>
														<span className="wrap-anywhere">
															{invoice.number} · {invoice.client}
														</span>
													</Link>
												}
												detail={invoice.detail}
												aside={
													<span className={cx(invoice.state === "overdue" && "text-error")}>
														{invoice.stateLabel}
													</span>
												}
												value={
													<span>
														<span className="sr-only">{invoice.amountLabel} </span>
														{invoice.amount}
													</span>
												}
											/>
										))}
									</LedgerRows>
								)}
							</Ledger>
						</div>
					</>
				)}
			</div>
		</>
	);
}

/** Which invoices the list shows: applies as soon as it changes. */
function StatusChoice({ show }: { show: Shown }) {
	const apply = useApplyFilters();
	return (
		<div className="min-w-0 grow basis-44">
			<Select
				label="Show"
				name="show"
				options={SHOWN.map((id) => ({ id, label: SHOWN_LABELS[id] }))}
				defaultValue={show}
				onChange={() => setTimeout(apply, 0)}
			/>
		</div>
	);
}
