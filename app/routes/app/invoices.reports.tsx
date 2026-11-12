import { Link } from "react-router";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { LinkTabs } from "~/components/LinkTabs";
import { PeriodStepper } from "~/components/PeriodStepper";
import { BillingTabs } from "~/invoices/BillingTabs";
import {
	BILLING_REPORT_LABELS,
	type BillingReportName,
	billingReportOf,
	billingReportRequest,
} from "~/invoices/billing-reports.server";
import { billingOf } from "~/invoices/context.server";
import { billingReportExportPath, invoicePath, invoicesPath } from "~/invoices/paths";
import { AGE_LABELS, AGES } from "~/invoices/status";
import { formatMoney } from "~/money/money";
import { ACTION_LINK } from "~/shell/links";
import { PageHeading, PageLead } from "~/shell/PageHeading";
import { addDays } from "~/time/calendar";
import { formatDay, formatRange } from "~/time/format";

import type { Route } from "./+types/invoices.reports";

// The reports of Invoices (TS-074): Invoiced and Payments received in a
// month or a chosen range, and Receivables now, by how overdue each invoice
// is. Each has its own address and a CSV of the same rows.

export function meta() {
	return [{ title: "Invoice reports · Timesifier" }];
}

const REPORTS: BillingReportName[] = ["invoiced", "payments", "receivables"];

/** The month before or after the one holding `day`, as its first and last day. */
function monthAround(day: string, step: -1 | 1) {
	const first =
		step === 1 ? addDays(`${day.slice(0, 8)}01`, 31) : addDays(`${day.slice(0, 8)}01`, -1);
	const start = `${first.slice(0, 8)}01`;
	return { first: start, last: addDays(`${addDays(start, 31).slice(0, 8)}01`, -1) };
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const { scope, organisation, today, locale } = await billingOf(context, request);
	const search = new URL(request.url).searchParams;
	const { report, days } = billingReportRequest(search, today);
	const result = await billingReportOf(scope, report, days, today);
	const slug = organisation.slug;
	const base = invoicesPath(slug);
	const at = (first: string, last: string) =>
		`${base}/reports?${new URLSearchParams({ report, from: first, to: last })}`;
	const previous = monthAround(days.first, -1);
	const next = monthAround(days.first, 1);
	const thisMonth = billingReportRequest(new URLSearchParams(), today).days;
	const money = (minor: number, currency: string) => formatMoney(minor, currency, locale);
	return {
		slug,
		report,
		// The page reads it here: billing-reports.server is not sent to the browser.
		label: BILLING_REPORT_LABELS[report],
		range: formatRange(days.first, days.last),
		steps: {
			previous: { to: at(previous.first, previous.last), label: "Previous month" },
			next: { to: at(next.first, next.last), label: "Next month" },
			current:
				days.first === thisMonth.first && days.last === thisMonth.last
					? undefined
					: { to: at(thisMonth.first, thisMonth.last), label: "This month" },
		},
		tabs: REPORTS.map((id) => ({
			id,
			label: BILLING_REPORT_LABELS[id],
			to: `${base}/reports?${new URLSearchParams(
				id === "receivables" ? { report: id } : { report: id, from: days.first, to: days.last },
			)}`,
		})),
		csv: billingReportExportPath(
			slug,
			`?${new URLSearchParams(
				report === "receivables" ? { report } : { report, from: days.first, to: days.last },
			)}`,
		),
		rows: result.rows.map((row) => ({
			key: row.key,
			to: invoicePath(slug, row.invoiceId),
			title: `${row.number} · ${row.client}`,
			detail:
				report === "invoiced"
					? `Issued ${formatDay(row.day, "short")}`
					: report === "payments"
						? `Paid ${formatDay(row.day, "short")}`
						: `Due ${formatDay(row.day, "short")} · ${AGE_LABELS[row.age ?? "current"]}`,
			amount: money(row.amountMinor, row.currency),
		})),
		total: result.totals.map((t) => money(t.amountMinor, t.currency)).join(" · "),
		aged: result.aged.map((group) => ({
			currency: group.currency,
			ages: AGES.map((age) => ({
				age,
				label: AGE_LABELS[age],
				amount: money(group.byAge[age], group.currency),
			})),
			total: money(group.totalMinor, group.currency),
		})),
	};
}

const EMPTY: Record<BillingReportName, string> = {
	invoiced: "No invoices issued in this range.",
	payments: "No payments received in this range.",
	receivables: "Nothing is owed: every issued invoice is paid.",
};

export default function InvoiceReports({ loaderData }: Route.ComponentProps) {
	const { slug, report, rows, label } = loaderData;
	return (
		<>
			<PageHeading>Invoice reports</PageHeading>
			<PageLead>
				What was invoiced and paid in a range, and what clients owe now by how overdue it is.
				Amounts in different currencies are never added together.
			</PageLead>
			<BillingTabs slug={slug} current="reports" />

			<div className="mt-8 max-w-200 overflow-x-auto">
				<LinkTabs label="Invoice report" current={report} tabs={loaderData.tabs} />
			</div>

			<div className="mt-6 flex max-w-200 flex-wrap items-center justify-between gap-4">
				{report === "receivables" ? (
					<p className="text-title-large">As of today</p>
				) : (
					<PeriodStepper
						label="Report range"
						period={loaderData.range}
						previous={loaderData.steps.previous}
						next={loaderData.steps.next}
						current={loaderData.steps.current}
					/>
				)}
				<a href={loaderData.csv} className={ACTION_LINK} download>
					Download CSV
				</a>
			</div>

			{report === "receivables" &&
				loaderData.aged.map((group) => (
					<div key={group.currency} className="mt-6 max-w-200">
						<Ledger heading={`Owed in ${group.currency}`} note={group.total}>
							<LedgerRows label={`${group.currency} owed by age`}>
								{group.ages.map((age) => (
									<LedgerRow key={age.age} title={age.label} value={age.amount} />
								))}
							</LedgerRows>
							<LedgerTotal label="Total" value={group.total} />
						</Ledger>
					</div>
				))}

			<div className="mt-6 max-w-200">
				<Ledger heading={label} note={rows.length}>
					{rows.length > 0 ? (
						<LedgerRows label={label}>
							{rows.map((row) => (
								<LedgerRow
									key={row.key}
									title={
										<Link to={row.to} className="wrap-anywhere underline-offset-2 hover:underline">
											{row.title}
										</Link>
									}
									detail={row.detail}
									value={row.amount}
								/>
							))}
						</LedgerRows>
					) : (
						<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
							{EMPTY[report]}
						</p>
					)}
					{rows.length > 0 && <LedgerTotal label="Total" value={loaderData.total} />}
				</Ledger>
			</div>
		</>
	);
}
