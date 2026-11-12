import { data, Link } from "react-router";

import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { dashboardOf } from "~/dashboards/dashboard.server";
import { newInvoicePath, receivablesPath, uninvoicedPath } from "~/invoices/paths";
import { halfDaysLabel } from "~/leave/kinds";
import { formatMoney } from "~/money/money";
import { membershipContext } from "~/organisations/membership.server";
import { hoursAndMinutes } from "~/reports/format";
import { reportSearch } from "~/reports/query";
import { Headline, RangeSteps } from "~/reports/RangeSteps";
import { ReportChoice } from "~/reports/ReportChoice";
import { reportRequest } from "~/reports/reports.server";
import { percentLabel, shareOfCapacity } from "~/reports/utilisation";
import { viewFrame } from "~/reports/view.server";
import { reportViewPath } from "~/reports/views";
import { destination, destinationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { DEFAULT_LOCALE } from "~/shell/locale";
import { PageHeading, PageLead } from "~/shell/PageHeading";
import { formatDuration } from "~/time/format";

import type { Route } from "./+types/dashboards";

// Dashboards (TS-086): a range's figures on one page, each read by the
// function its report reads and linking to it, so a panel's figure is the
// report's. Owners, admins, Finance and team managers are shown it (the
// destination's audience); time panels hold the people the viewer may see
// (`timeScopeOf`), and money panels only reach those who see rates. What is
// owed and what is waiting to be invoiced are as of today, whatever the range,
// as their pages are, with one figure per currency: amounts in different
// currencies are never added.

const { label } = destination("dashboards");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const report = await reportRequest(membership, new URL(request.url), Date.now());
	const frame = { ...viewFrame(report, { grouped: false }), choices: [] };
	// A custom range that makes no report: the fields again, with the reason (TS-091, W05).
	if ("problem" in report) return data({ ...frame, board: null }, { status: 400 });
	const board = await dashboardOf(membership, report);
	const slug = membership.organisation.slug;
	const search = `?${reportSearch({ range: report.query.range, days: report.days, group: "project" })}`;
	const { utilisation } = board;
	const shown = {
		total: hoursAndMinutes(board.totalSeconds),
		expected: `of ${formatDuration(board.expectedMinutes * 60)} expected`,
		billableShare: percentLabel(
			board.totalSeconds > 0 ? board.billableSeconds / board.totalSeconds : null,
		),
		billable: hoursAndMinutes(board.billableSeconds),
		utilisation: percentLabel(
			shareOfCapacity(utilisation.total.loggedSeconds, utilisation.total.capacityMinutes),
		),
		billableUtilisation: percentLabel(
			shareOfCapacity(utilisation.total.billableSeconds, utilisation.total.capacityMinutes),
		),
		topProjects: board.topProjects.map((p) => ({ ...p, time: hoursAndMinutes(p.seconds) })),
		budgets: board.budgets.map((b) => ({
			id: b.projectId,
			name: b.project,
			figure: b.hours
				? `${formatDuration(b.spent * 60)} of ${formatDuration(b.amount * 60)}`
				: `${formatMoney(b.spent, b.currency, DEFAULT_LOCALE)} of ${formatMoney(b.amount, b.currency, DEFAULT_LOCALE)}`,
			percent: b.percent === null ? "—" : `${b.percent}%`,
		})),
		onLeave: board.onLeave.map((p) => ({
			id: p.id,
			name: p.name,
			leave: `${formatDuration(p.leaveMinutes * 60)} (${halfDaysLabel(p.halfDays)})`,
		})),
		money: board.money && {
			revenue: formatMoney(board.money.totals.revenueMinor, board.money.currency, DEFAULT_LOCALE),
			cost: formatMoney(board.money.totals.costMinor, board.money.currency, DEFAULT_LOCALE),
			profit: formatMoney(board.money.totals.profitMinor, board.money.currency, DEFAULT_LOCALE),
			margin: percentLabel(board.money.totals.margin),
		},
		receivables: board.receivables && {
			outstanding: board.receivables.map((r) =>
				formatMoney(r.outstandingMinor, r.currency, DEFAULT_LOCALE),
			),
			overdue: board.receivables
				.filter((r) => r.overdueMinor > 0)
				.map((r) => formatMoney(r.overdueMinor, r.currency, DEFAULT_LOCALE)),
		},
		uninvoiced:
			board.uninvoiced &&
			board.uninvoiced.map((u) => formatMoney(u.amountMinor, u.currency, DEFAULT_LOCALE)),
		links: {
			time: reportViewPath(slug, "time", search),
			utilisation: reportViewPath(slug, "utilisation", search),
			profitability: reportViewPath(slug, "profitability", search),
			leave: reportViewPath(slug, "leave"),
			projects: destinationPath(slug, "projects"),
			receivables: receivablesPath(slug),
			uninvoiced: uninvoicedPath(slug),
			newInvoice: newInvoicePath(slug),
		},
	};
	return data({ ...frame, board: shown }, { status: 200 });
}

function Panel({
	heading,
	value,
	children,
	href,
	linkLabel,
}: {
	heading: string;
	value?: string;
	children?: React.ReactNode;
	href: string;
	linkLabel: string;
}) {
	return (
		<Ledger heading={heading} note={value}>
			<div className="border-t border-outline-variant px-4 py-3 @sm:px-5">
				{children}
				<Link to={href} className={TEXT_LINK}>
					{linkLabel}
				</Link>
			</div>
		</Ledger>
	);
}

export default function Dashboards({ loaderData: d }: Route.ComponentProps) {
	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>
				The range at a glance: time, utilisation, budgets, leave and, for those who see rates,
				money.
			</PageLead>
			<ReportChoice {...d} />
			<RangeSteps range={d.range} steps={d.steps} />
			{d.board && <Board {...d.board} />}
		</>
	);
}

type Shown = NonNullable<Route.ComponentProps["loaderData"]["board"]>;

/** The panels. */
function Board(d: Shown) {
	return (
		<>
			<Headline label="Total" value={d.total} beside={d.expected} />

			<div className="mt-10 grid max-w-200 gap-6 medium:grid-cols-2">
				<Panel
					heading="Billable share"
					value={d.billableShare}
					href={d.links.time}
					linkLabel="Open the time report"
				>
					<p className="mb-2 text-body-medium text-on-surface-variant">
						{d.billable} of {d.total} billable.
					</p>
				</Panel>
				<Panel
					heading="Utilisation"
					value={d.utilisation}
					href={d.links.utilisation}
					linkLabel="Open utilisation"
				>
					<p className="mb-2 text-body-medium text-on-surface-variant">
						Billable utilisation {d.billableUtilisation}.
					</p>
				</Panel>
				<Ledger heading="Top projects" note={d.topProjects.length}>
					<LedgerRows label="Top projects by time">
						{d.topProjects.map((p) => (
							<LedgerRow
								key={p.id}
								title={<span className="wrap-anywhere">{p.name}</span>}
								value={p.time}
							/>
						))}
					</LedgerRows>
					<p className="border-t border-outline-variant px-4 py-3 @sm:px-5">
						<Link to={d.links.time} className={TEXT_LINK}>
							By project
						</Link>
					</p>
				</Ledger>
				<Ledger heading="Budgets nearest their limit" note={d.budgets.length}>
					{d.budgets.length > 0 ? (
						<LedgerRows label="Budgets nearest their limit">
							{d.budgets.map((b) => (
								<LedgerRow
									key={b.id}
									title={<span className="wrap-anywhere">{b.name}</span>}
									detail={b.figure}
									value={b.percent}
								/>
							))}
						</LedgerRows>
					) : (
						<p className="border-t border-outline-variant px-4 py-3 text-body-medium text-on-surface-variant @sm:px-5">
							No project has a budget. Set one on Projects.
						</p>
					)}
					<p className="border-t border-outline-variant px-4 py-3 @sm:px-5">
						<Link to={d.links.projects} className={TEXT_LINK}>
							Projects
						</Link>
					</p>
				</Ledger>
				<Ledger heading="On leave" note={d.onLeave.length}>
					{d.onLeave.length > 0 ? (
						<LedgerRows label="People on leave in the range">
							{d.onLeave.map((p) => (
								<LedgerRow
									key={p.id}
									title={<span className="wrap-anywhere">{p.name}</span>}
									value={p.leave}
								/>
							))}
						</LedgerRows>
					) : (
						<p className="border-t border-outline-variant px-4 py-3 text-body-medium text-on-surface-variant @sm:px-5">
							Nobody shown is on leave in this range.
						</p>
					)}
					<p className="border-t border-outline-variant px-4 py-3 @sm:px-5">
						<Link to={d.links.leave} className={TEXT_LINK}>
							Leave report
						</Link>
					</p>
				</Ledger>
				{d.money && (
					<Panel
						heading="Profit"
						value={d.money.profit}
						href={d.links.profitability}
						linkLabel="Open profitability"
					>
						<p className="mb-2 text-body-medium text-on-surface-variant">
							Revenue {d.money.revenue} · cost {d.money.cost} · margin {d.money.margin}.
						</p>
					</Panel>
				)}
				{d.uninvoiced && (
					<Panel
						heading="Uninvoiced"
						value={d.uninvoiced.join(" · ")}
						href={d.links.uninvoiced}
						linkLabel="Open uninvoiced"
					>
						<p className="mb-2 text-body-medium text-on-surface-variant">
							{d.uninvoiced.length > 0
								? "Billable time, expenses and fees on no invoice yet, until today."
								: "Nothing billable is waiting to be invoiced."}
						</p>
					</Panel>
				)}
				{d.receivables && (
					<Panel
						heading="Outstanding"
						value={d.receivables.outstanding.join(" · ")}
						href={d.links.receivables}
						linkLabel="Open receivables"
					>
						<p className="mb-2 text-body-medium text-on-surface-variant">
							{d.receivables.outstanding.length === 0 ? (
								<>
									Nothing is owed: every issued invoice is paid.{" "}
									<Link to={d.links.newInvoice} className={TEXT_LINK}>
										Create an invoice
									</Link>
								</>
							) : d.receivables.overdue.length > 0 ? (
								`Overdue ${d.receivables.overdue.join(" · ")}.`
							) : (
								"Nothing is overdue."
							)}
						</p>
					</Panel>
				)}
			</div>
		</>
	);
}
