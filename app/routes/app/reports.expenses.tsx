import { useState } from "react";
import { Form, Link } from "react-router";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { EXPENSE_GROUP_LABELS, EXPENSE_GROUPS } from "~/expenses/expenses";
import { expenseReportExportPath, expenseReportPath } from "~/expenses/paths";
import {
	expenseReportRequest,
	expenseTotals,
	groupExpenses,
	reportedExpenses,
} from "~/expenses/report.server";
import { formatMoney, type Money } from "~/money/money";
import { membershipContext } from "~/organisations/membership.server";
import { EVERYONE, RANGE_LABELS, RANGES, type Range } from "~/reports/choices";
import { rangeLabel, stepUnit } from "~/reports/format";
import { reportSearch, type Step, steppedRange } from "~/reports/query";
import { destination, destinationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading, PageLead } from "~/shell/PageHeading";

import type { Route } from "./+types/reports.expenses";

// The Expenses view of Reports (TS-070, B9): the expenses dated in a range,
// by category, project or person, with what they come to, what is billable and
// what is to be paid back, in each currency. Whose expenses it holds is whose
// time the viewer may see, as on Reports; its export is the same report as CSV.

const { label } = destination("reports");

export function meta() {
	return [{ title: `Expense report · ${label} · Timesifier` }];
}

/** Totals in several currencies, side by side: "£12.00 + €5.00", or "None". */
function moneyWords(totals: readonly Money[]): string {
	if (totals.length === 0) return "None";
	return totals
		.map(({ amountMinor, currency }) => formatMoney(amountMinor, currency, "en-GB"))
		.join(" + ");
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const report = await expenseReportRequest(membership, new URL(request.url), Date.now());
	const { query, days, choices, seesEveryone, expenseGroup } = report;
	const expenses = await reportedExpenses(report);
	const groups = groupExpenses(expenses, expenseGroup);
	const totals = expenseTotals(expenses);
	const { slug } = membership.organisation;

	const searchOf = (range: Range, of: typeof days) => {
		const search = reportSearch({ range, days: of, group: "project", person: query.person });
		search.set("group", expenseGroup);
		return `?${search}`;
	};
	const step = (by: Step) => {
		const stepped = steppedRange(query.range, days, by);
		return expenseReportPath(slug, searchOf(stepped.range, stepped.days));
	};
	const chosen = choices.find(({ id }) => id === query.person);
	const others = choices.length > 1;

	return {
		query: {
			range: query.range,
			from: days.first,
			to: days.last,
			group: expenseGroup,
			person: query.person ?? EVERYONE,
		},
		choices: others ? choices : [],
		everyone: seesEveryone ? "Everyone" : "You and your teams",
		whose: chosen
			? `The expenses of ${chosen.name}.`
			: seesEveryone
				? `Everyone's expenses in ${membership.organisation.name}.`
				: others
					? "Your expenses, and those of the people in the teams you manage."
					: "Your expenses.",
		range: rangeLabel(days.first, days.last),
		steps: { unit: stepUnit(query.range, days), previous: step(-1), next: step(1) },
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
		timePath: destinationPath(slug, "reports"),
		exportPath: expenseReportExportPath(slug, searchOf(query.range, days)),
	};
}

export default function ExpenseReport({ loaderData }: Route.ComponentProps) {
	const { query, groups, steps, exportPath } = loaderData;
	const by = EXPENSE_GROUP_LABELS[query.group].toLowerCase();

	return (
		<>
			<PageHeading>Expense report</PageHeading>
			<PageLead>
				{loaderData.whose} Amounts in different currencies are totalled apart; nothing is converted.{" "}
				<Link to={loaderData.timePath} className={TEXT_LINK}>
					Report on time
				</Link>
			</PageLead>

			<ExpenseChoice key={exportPath} {...loaderData} />

			<div className="mt-10 flex max-w-200 flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
				<p className="text-title-large">{loaderData.range}</p>
				<p className="flex flex-wrap gap-x-6 gap-y-2 text-body-large">
					<Link to={steps.previous} preventScrollReset className={TEXT_LINK}>
						← Previous {steps.unit}
					</Link>
					<Link to={steps.next} preventScrollReset className={TEXT_LINK}>
						Next {steps.unit} →
					</Link>
				</p>
			</div>

			<div className="mt-6 max-w-200">
				<Ledger heading={`By ${by}`} note={loaderData.range}>
					{groups.length > 0 ? (
						<LedgerRows label={`Expenses by ${by}`}>
							{groups.map((group) => (
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
					<LedgerTotal label="Billable" value={loaderData.billable} />
					<LedgerTotal label="To pay back" value={loaderData.reimbursable} />
					<LedgerTotal label="Total" value={loaderData.total} />
				</Ledger>
				<p className="mt-4">
					<a href={exportPath} download className={TEXT_LINK}>
						Export as CSV
					</a>
				</p>
			</div>
		</>
	);
}

/** The fields that choose the report. They are sent in the address, so a report is a link. */
function ExpenseChoice({
	query,
	choices,
	everyone,
	range: shown,
}: Pick<Route.ComponentProps["loaderData"], "query" | "choices" | "everyone" | "range">) {
	const [range, setRange] = useState<Range>(query.range);
	const stepped = (id: Range) => id === "week" || id === "month";
	const ranges = RANGES.filter((id) => !stepped(id) || id === query.range);

	return (
		<Form method="get" aria-label="Choose a report of expenses" className="mt-8 max-w-200">
			<div className="grid gap-6 medium:grid-cols-2">
				<Select
					label="Range"
					name="range"
					options={ranges.map((id) => ({ id, label: stepped(id) ? shown : RANGE_LABELS[id] }))}
					value={range}
					onChange={(id) => setRange(RANGES.find((each) => each === id) ?? range)}
				/>
				<Select
					label="Group by"
					name="group"
					options={EXPENSE_GROUPS.map((id) => ({ id, label: EXPENSE_GROUP_LABELS[id] }))}
					defaultValue={query.group}
				/>
				{range === "custom" && (
					<>
						<TextField
							label="First day"
							name="from"
							type="date"
							defaultValue={query.from}
							isRequired
						/>
						<TextField label="Last day" name="to" type="date" defaultValue={query.to} isRequired />
					</>
				)}
				{stepped(range) && <input type="hidden" name="from" value={query.from} />}
				{choices.length > 0 && (
					<Select
						label="Person"
						name="person"
						options={[
							{ id: EVERYONE, label: everyone },
							...choices.map(({ id, name }) => ({ id, label: name })),
						]}
						defaultValue={query.person}
					/>
				)}
			</div>
			<div className="mt-6">
				<Button type="submit">Show report</Button>
			</div>
		</Form>
	);
}
