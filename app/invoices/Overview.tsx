import { Link } from "react-router";

import { cx } from "~/components/cx";
import { formatMoney } from "~/money/money";
import { TEXT_LINK } from "~/shell/links";
import type { Day } from "~/time/calendar";
import { formatMonth } from "~/time/format";

import type { InvoiceOverview } from "./overview.server";
import { invoicesPath, receivablesPath } from "./paths";

// The overview Invoices opens on (TS-119, S2-11): two figures in the
// headline's style, what is outstanding with what of it is overdue and what
// was paid this year, each linking to its list; then a bar pair a month for
// the last twelve, issued against paid, drawn from tokens alone, with the
// same figures in a table beside them that is what a screen reader reads.

/** A bar's height, in steps of the spacing scale: a step is 4px, the tallest 128px. */
const HEIGHTS = [
	"h-0",
	"h-1",
	"h-2",
	"h-3",
	"h-4",
	"h-5",
	"h-6",
	"h-7",
	"h-8",
	"h-9",
	"h-10",
	"h-11",
	"h-12",
	"h-13",
	"h-14",
	"h-15",
	"h-16",
	"h-17",
	"h-18",
	"h-19",
	"h-20",
	"h-21",
	"h-22",
	"h-23",
	"h-24",
	"h-25",
	"h-26",
	"h-27",
	"h-28",
	"h-29",
	"h-30",
	"h-31",
	"h-32",
] as const;

const TALLEST = HEIGHTS.length - 1;

/**
 * The step of `minor` against the largest figure of the year: 0 for nothing,
 * at least 1 for anything, so a small sum still shows.
 */
export function barStep(minor: number, largest: number): number {
	if (minor <= 0 || largest <= 0) return 0;
	return Math.max(1, Math.round((minor / largest) * TALLEST));
}

/** How the issued and paid bars are drawn, in the legend as on the bars. */
const ISSUED = "bg-outline";
const PAID = "bg-primary";

export interface OverviewData {
	currency: string;
	outstanding: string;
	/** Null when nothing is overdue. */
	overdue: string | null;
	paidThisYear: string;
	year: string;
	months: {
		month: Day;
		label: string;
		short: string;
		issued: string;
		paid: string;
		issuedStep: number;
		paidStep: number;
	}[];
	otherCurrencies: string[];
}

/** The overview as the page is sent it: amounts written out, and each bar's step. */
export function overviewData(overview: InvoiceOverview, today: Day, locale: string): OverviewData {
	const money = (minor: number) => formatMoney(minor, overview.currency, locale);
	const largest = Math.max(0, ...overview.months.flatMap((m) => [m.issuedMinor, m.paidMinor]));
	return {
		currency: overview.currency,
		outstanding: money(overview.outstandingMinor),
		overdue: overview.overdueMinor > 0 ? money(overview.overdueMinor) : null,
		paidThisYear: money(overview.paidThisYearMinor),
		year: today.slice(0, 4),
		months: overview.months.map((m) => {
			const label = formatMonth(m.month);
			return {
				month: m.month,
				label,
				short: label.slice(0, 3),
				issued: money(m.issuedMinor),
				paid: money(m.paidMinor),
				issuedStep: barStep(m.issuedMinor, largest),
				paidStep: barStep(m.paidMinor, largest),
			};
		}),
		otherCurrencies: overview.otherCurrencies,
	};
}

export function Overview({ slug, data }: { slug: string; data: OverviewData }) {
	const first = data.months[0]?.label ?? "";
	const last = data.months.at(-1)?.label ?? "";
	const caption = `Issued and paid each month, ${first} to ${last}, in ${data.currency}`;
	return (
		<section aria-labelledby="overview" className="mt-8 max-w-200">
			<h2 id="overview" className="sr-only">
				Overview
			</h2>
			<dl className="grid gap-6 medium:grid-cols-2">
				<div>
					<dt className="text-label-large text-on-surface-variant">Outstanding</dt>
					<dd className="text-display-small tabular-nums">{data.outstanding}</dd>
					<dd
						className={cx(
							"mt-1 text-body-large",
							data.overdue ? "text-error" : "text-on-surface-variant",
						)}
					>
						{data.overdue ? `${data.overdue} overdue` : "Nothing overdue"}
					</dd>
					<dd className="mt-2 text-body-large">
						<Link to={`${invoicesPath(slug)}?show=open`} className={TEXT_LINK}>
							Open invoices
						</Link>
					</dd>
				</div>
				<div>
					<dt className="text-label-large text-on-surface-variant">Paid in {data.year}</dt>
					<dd className="text-display-small tabular-nums">{data.paidThisYear}</dd>
					<dd className="mt-1 text-body-large text-on-surface-variant">
						Payments received since 1 January
					</dd>
					<dd className="mt-2 text-body-large">
						<Link to={`${invoicesPath(slug)}?show=paid`} className={TEXT_LINK}>
							Paid invoices
						</Link>
					</dd>
				</div>
			</dl>
			{data.otherCurrencies.length > 0 && (
				<p className="mt-4 max-w-160 text-body-medium text-on-surface-variant">
					Invoices in {data.otherCurrencies.join(", ")} are not in these figures, which are in{" "}
					{data.currency}.{" "}
					<Link to={receivablesPath(slug)} className={TEXT_LINK}>
						Receivables
					</Link>{" "}
					shows what is owed in each currency.
				</p>
			)}

			<figure className="mt-8 grid gap-6 expanded:grid-cols-2">
				<figcaption className="text-label-large text-on-surface-variant expanded:col-span-2">
					{caption}
					<span className="ms-4 inline-flex flex-wrap items-center gap-x-4" aria-hidden="true">
						<span className="inline-flex items-center gap-2">
							<span className={cx("inline-block size-3 rounded-extra-small", ISSUED)} />
							Issued
						</span>
						<span className="inline-flex items-center gap-2">
							<span className={cx("inline-block size-3 rounded-extra-small", PAID)} />
							Paid
						</span>
					</span>
				</figcaption>
				{/* The bars; the table beside them is what assistive technology reads. */}
				<div aria-hidden="true" className="flex self-start">
					{data.months.map((m) => (
						<div key={m.month} className="flex min-w-0 flex-1 flex-col items-center gap-2">
							{/* The rule under each pair meets its neighbours': one line under the year. */}
							<div className="flex h-32 w-full items-end justify-center gap-px border-b border-outline-variant px-0.5">
								<span
									className={cx("w-1/2 rounded-t-extra-small", ISSUED, HEIGHTS[m.issuedStep])}
								/>
								<span className={cx("w-1/2 rounded-t-extra-small", PAID, HEIGHTS[m.paidStep])} />
							</div>
							<span className="text-label-small text-on-surface-variant">
								<span className="medium:hidden">{m.short.slice(0, 1)}</span>
								<span className="max-medium:hidden">{m.short}</span>
							</span>
						</div>
					))}
				</div>
				<table className="w-full border-collapse text-body-medium">
					<caption className="sr-only">{caption}</caption>
					<thead>
						<tr className="border-b-2 border-on-surface text-label-large">
							<th scope="col" className="py-2 pe-3 text-start">
								Month
							</th>
							<th scope="col" className="px-3 py-2 text-end">
								Issued
							</th>
							<th scope="col" className="py-2 ps-3 text-end">
								Paid
							</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-outline-variant">
						{data.months.map((m) => (
							<tr key={m.month}>
								<th scope="row" className="py-1.5 pe-3 text-start font-normal">
									{m.label}
								</th>
								<td className="px-3 py-1.5 text-end tabular-nums">{m.issued}</td>
								<td className="py-1.5 ps-3 text-end tabular-nums">{m.paid}</td>
							</tr>
						))}
					</tbody>
				</table>
			</figure>
		</section>
	);
}
