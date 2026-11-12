import { Form, Link } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { TextField } from "~/components/TextField";
import { BillingTabs } from "~/invoices/BillingTabs";
import { billingOf } from "~/invoices/context.server";
import { hoursMilli, quantityText } from "~/invoices/lines";
import { newInvoicePath } from "~/invoices/paths";
import { uninvoicedOf } from "~/invoices/uninvoiced.server";
import { formatMoney, totalsByCurrency } from "~/money/money";
import { ACTION_LINK } from "~/shell/links";
import { PageHeading, PageLead } from "~/shell/PageHeading";
import { Day } from "~/time/calendar";
import { formatRange } from "~/time/format";

import type { Route } from "./+types/invoices.uninvoiced";

// Uninvoiced (TS-073): for each client's project, the billable time and
// expenses not on any invoice yet, and what they come to, in a range or until
// today. Each client links to a new invoice for the same range.

export function meta() {
	return [{ title: "Uninvoiced · Timesifier" }];
}

const Range = z.object({ from: Day, to: Day });

export async function loader({ request, context }: Route.LoaderArgs) {
	const { scope, organisation, now, locale } = await billingOf(context, request);
	const search = new URL(request.url).searchParams;
	const range = Range.safeParse({ from: search.get("from"), to: search.get("to") });
	const days =
		range.success && range.data.from <= range.data.to
			? { first: range.data.from, last: range.data.to }
			: null;
	const rows = await uninvoicedOf(scope, organisation, days, now);
	const clients = [...new Set(rows.map((row) => row.clientId))].map((clientId) => {
		const own = rows.filter((row) => row.clientId === clientId);
		const query = new URLSearchParams({ client: clientId });
		if (days) {
			query.set("from", days.first);
			query.set("to", days.last);
		}
		return {
			id: clientId,
			name: own[0]?.clientName ?? "",
			invoice: `${newInvoicePath(organisation.slug)}?${query}`,
			projects: own.map((row) => ({
				id: row.projectId,
				name: row.projectName,
				detail: [
					row.minutes > 0 ? `${quantityText(hoursMilli(row.minutes))} hours` : null,
					row.expensesMinor > 0
						? `${formatMoney(row.expensesMinor, row.currency, locale)} expenses`
						: null,
					row.feeLeftMinor > 0
						? `${formatMoney(row.feeLeftMinor, row.currency, locale)} of its fee`
						: null,
					row.unpricedMinutes > 0
						? `${quantityText(hoursMilli(row.unpricedMinutes))} hours without a rate`
						: null,
				]
					.filter(Boolean)
					.join(" · "),
				amount: formatMoney(row.amountMinor, row.currency, locale),
			})),
			totals: totalsByCurrency(
				own.map(({ amountMinor, currency }) => ({ amountMinor, currency })),
			).map(({ amountMinor, currency }) => formatMoney(amountMinor, currency, locale)),
		};
	});
	return {
		slug: organisation.slug,
		from: days?.first ?? "",
		to: days?.last ?? "",
		range: days ? formatRange(days.first, days.last) : "Everything until today",
		clients,
		totals: totalsByCurrency(
			rows.map(({ amountMinor, currency }) => ({ amountMinor, currency })),
		).map(({ amountMinor, currency }) => formatMoney(amountMinor, currency, locale)),
	};
}

export default function Uninvoiced({ loaderData }: Route.ComponentProps) {
	const { slug, clients, totals } = loaderData;
	return (
		<>
			<PageHeading>Uninvoiced</PageHeading>
			<PageLead>
				Billable time and expenses on no invoice yet, and the fixed fees still to invoice, by client
				and project.
			</PageLead>
			<BillingTabs slug={slug} current="uninvoiced" />

			<Form
				method="get"
				aria-label="Choose a range"
				className="mt-8 max-w-200"
				key={`${loaderData.from}/${loaderData.to}`}
			>
				<div className="grid gap-6 medium:grid-cols-2">
					<TextField label="First day" name="from" type="date" defaultValue={loaderData.from} />
					<TextField label="Last day" name="to" type="date" defaultValue={loaderData.to} />
				</div>
				<p className="mt-2 text-body-medium text-on-surface-variant">
					Leave both empty for everything until today.
				</p>
				<div className="mt-6">
					<Button type="submit" variant="outlined">
						Show range
					</Button>
				</div>
			</Form>

			<div className="mt-10 max-w-200">
				<p className="text-title-large">{loaderData.range}</p>
				{totals.length > 0 && (
					<p className="mt-2 text-display-small tabular-nums">{totals.join(" · ")}</p>
				)}
			</div>

			<div className="mt-6 flex max-w-200 flex-col gap-6">
				{clients.length === 0 ? (
					<Ledger heading="Uninvoiced" note={0}>
						<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
							Everything billable in this range is invoiced.
						</p>
					</Ledger>
				) : (
					clients.map((client) => (
						<Ledger
							key={client.id}
							heading={<span className="wrap-anywhere">{client.name}</span>}
							note={
								<Link to={client.invoice} className={ACTION_LINK}>
									Invoice {client.name}
								</Link>
							}
						>
							<LedgerRows label={`${client.name}'s projects`}>
								{client.projects.map((project) => (
									<LedgerRow
										key={project.id}
										title={<span className="wrap-anywhere">{project.name}</span>}
										detail={project.detail}
										value={project.amount}
									/>
								))}
							</LedgerRows>
							<LedgerTotal label="Total" value={client.totals.join(" · ")} />
						</Ledger>
					))
				)}
			</div>
		</>
	);
}
