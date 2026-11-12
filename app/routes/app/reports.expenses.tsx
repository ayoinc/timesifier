import { data, type To } from "react-router";

import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { EXPENSE_GROUP_LABELS, EXPENSE_GROUPS, type ExpenseGrouping } from "~/expenses/expenses";
import { expenseReportExportPath } from "~/expenses/paths";
import {
	expenseReportRequest,
	expenseTotals,
	groupExpenses,
	reportedExpenses,
} from "~/expenses/report.server";
import { formatMoney, type Money } from "~/money/money";
import { membershipContext } from "~/organisations/membership.server";
import { Headline, RangeSteps } from "~/reports/RangeSteps";
import { ReportChoice } from "~/reports/ReportChoice";
import { ReportTabs } from "~/reports/ReportTabs";
import { viewFrame, viewsFor } from "~/reports/view.server";
import { destination } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading, PageLead } from "~/shell/PageHeading";
import { tagOptions } from "~/tags/tags.server";

import type { Route } from "./+types/reports.expenses";

// The Expenses view of Reports (TS-070, B9): the expenses dated in a range,
// by category, project or person, with what they come to, what is billable and
// what is to be paid back, in each currency. Whose expenses it holds is whose
// time the viewer may see, as on Reports, and it is chosen as the time report
// is (TS-092): the shared fields apply as they change, a custom range that
// makes no report shows why under its field, the stepper moves the range by
// its own length, and a tag narrows it (TS-085). Its export is the same report
// as CSV.

const { label } = destination("reports");

export function meta() {
	return [{ title: `Expenses · ${label} · Timesifier` }];
}

/** Totals in several currencies, side by side: "£12.00 + €5.00", or "None". */
function moneyWords(totals: readonly Money[]): string {
	if (totals.length === 0) return "None";
	return totals
		.map(({ amountMinor, currency }) => formatMoney(amountMinor, currency, "en-GB"))
		.join(" + ");
}

/** `to` (a "?…" search or a path) with this view's own grouping, and its tag when it has one. */
function withGroup(to: To, group: ExpenseGrouping, tag: string | undefined): string {
	const params = new URLSearchParams(typeof to === "string" ? to : (to.search ?? ""));
	params.set("group", group);
	if (tag !== undefined) params.set("tag", tag);
	return `?${params}`;
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const report = await expenseReportRequest(membership, new URL(request.url), Date.now());
	const { query, choices, seesEveryone, expenseGroup, tag } = report;
	const { slug } = membership.organisation;
	const frame = viewFrame(report, { grouped: false, tags: await tagOptions(report.scope) });
	const chosen = choices.find(({ id }) => id === query.person);
	const others = choices.length > 1;

	const page = {
		...frame,
		// The steps keep the view's own grouping and the tag, as the time report's keep theirs.
		steps: frame.steps && {
			previous: {
				...frame.steps.previous,
				to: withGroup(frame.steps.previous.to, expenseGroup, tag),
			},
			next: { ...frame.steps.next, to: withGroup(frame.steps.next.to, expenseGroup, tag) },
			current: frame.steps.current && {
				...frame.steps.current,
				to: withGroup(frame.steps.current.to, expenseGroup, tag),
			},
		},
		expenseGroup,
		views: viewsFor(membership.role),
		slug,
		whose: chosen
			? `The expenses of ${chosen.name}.`
			: seesEveryone
				? `Everyone's expenses in ${membership.organisation.name}.`
				: others
					? "Your expenses, and those of the people in the teams you manage."
					: "Your expenses.",
	};

	// A custom range that makes no report: the fields again, holding what was
	// typed, with the reason under its field, as on the time report.
	if ("problem" in report) return data({ ...page, report: null }, { status: 400 });

	const expenses = await reportedExpenses(report);
	const groups = groupExpenses(expenses, expenseGroup);
	const totals = expenseTotals(expenses);
	const exportSearch = withGroup(frame.tabSearch, expenseGroup, tag);

	return data(
		{
			...page,
			report: {
				groups: groups.map((group) => ({
					key: group.key,
					label: group.label,
					detail: `${group.count} ${group.count === 1 ? "expense" : "expenses"} · Billable ${moneyWords(group.billable)} · To pay back ${moneyWords(group.reimbursable)}`,
					total: moneyWords(group.total),
				})),
				count: totals.count,
				total: moneyWords(totals.total),
				billable: moneyWords(totals.billable),
				reimbursable: moneyWords(totals.reimbursable),
				exportPath: expenseReportExportPath(slug, exportSearch),
			},
		},
		{ status: 200 },
	);
}

export default function ExpenseReport({ loaderData }: Route.ComponentProps) {
	const { report, expenseGroup } = loaderData;
	const by = EXPENSE_GROUP_LABELS[expenseGroup].toLowerCase();

	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>
				{loaderData.whose}
			</PageLead>
			<ReportTabs
				slug={loaderData.slug}
				current="expenses"
				views={loaderData.views}
				search={loaderData.tabSearch}
			/>
			<ReportChoice
				{...loaderData}
				ownGroups={{
					options: EXPENSE_GROUPS.map((id) => ({ id, label: EXPENSE_GROUP_LABELS[id] })),
					value: expenseGroup,
				}}
			/>
			<RangeSteps range={loaderData.range} steps={loaderData.steps} />

			{report && (
				<>
					<Headline label="Total" value={report.total} />
					<div className="mt-6 max-w-200">
						<Ledger heading={`By ${by}`} note={loaderData.range}>
							{report.groups.length > 0 ? (
								<LedgerRows label={`Expenses by ${by}`}>
									{report.groups.map((group) => (
										<LedgerRow
											key={group.key}
											title={<span className="wrap-anywhere">{group.label}</span>}
											detail={group.detail}
											value={group.total}
										/>
									))}
								</LedgerRows>
							) : (
								<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
									No expenses in this range.
								</p>
							)}
							<LedgerTotal label="Billable" value={report.billable} />
							<LedgerTotal label="To pay back" value={report.reimbursable} />
							<LedgerTotal label="Total" value={report.total} />
						</Ledger>
						<p className="mt-4">
							<a href={report.exportPath} download className={TEXT_LINK}>
								Export as CSV
							</a>
						</p>
					</div>
				</>
			)}
		</>
	);
}
