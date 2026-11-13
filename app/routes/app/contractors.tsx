import { useEffect, useState } from "react";
import { data, Link } from "react-router";
import { DownloadLink } from "~/components/DownloadLink";
import { FilterBar, useApplyFilters } from "~/components/FilterBar";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { PeriodStepper } from "~/components/PeriodStepper";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { contractorTotals } from "~/contractors/contractors";
import { contractorReport, requireSeesCost } from "~/contractors/contractors.server";
import { contractorsExportPath } from "~/contractors/paths";
import { formatMoney, type Money } from "~/money/money";
import { isAdministrator } from "~/organisations/access";
import { membershipContext } from "~/organisations/membership.server";
import { RANGE_LABELS, RANGES, type Range } from "~/reports/choices";
import { hoursAndMinutes, rangeLabel, stepUnit } from "~/reports/format";
import {
	type RangeProblem,
	type ReportDays,
	rangeDays,
	reportSearch,
	type Step,
	steppedRange,
} from "~/reports/query";
import { ReportTabs } from "~/reports/ReportTabs";
import { viewsFor } from "~/reports/view.server";
import { destination, membersPath } from "~/shell/destinations";
import { ACTION_LINK, TEXT_LINK } from "~/shell/links";
import { negotiateLocale } from "~/shell/locale";
import { PageHeading, PageLead } from "~/shell/PageHeading";
import { dayOf } from "~/time/calendar";

import type { Route } from "./+types/contractors";

// The Contractors report (TS-079, B15), a page below Reports: what each
// contractor tracked in a range of days, unrounded, and what it cost at their
// cost rates, with people who have left the organisation when they tracked in
// it. It is money, so it is shown to owners, admins and Finance alone; anybody
// else, a manager included, gets the organisation's 404 before anything is
// read. The range is chosen as on Reports: it applies as it changes, and the
// stepper moves it by its own length (TS-091).

const TITLE = "Contractors";

const { label: REPORTS } = destination("reports");

/** A date field's value once a whole date is in it. */
const WHOLE_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function meta() {
	return [{ title: `${TITLE} · ${REPORTS} · Timesifier` }];
}

export const middleware: Route.MiddlewareFunction[] = [
	({ context }) => requireSeesCost(context.get(membershipContext)),
];

/** The address of a range, without a grouping, which this report has none of. */
function searchOf(range: Range, days: ReportDays): string {
	const search = reportSearch({ range, days, group: "project" });
	search.delete("group");
	return `?${search}`;
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const { organisation } = membership;
	const now = Date.now();
	const report = await contractorReport(membership, new URL(request.url), now);
	const page = {
		organisation: organisation.name,
		/** Owners and admins mark contractors, on Members; Finance is not shown Team. */
		members: isAdministrator(membership.role) ? membersPath(organisation.slug) : null,
		slug: organisation.slug,
		views: viewsFor(membership.role),
		tabSearch: "",
	};

	// A custom range that makes no report: the form again, holding what was
	// typed, with the reason under its field, as on Reports.
	if ("problem" in report) {
		const { query, problem } = report;
		return data(
			{
				...page,
				query: { range: query.range, from: query.from ?? "", to: query.to ?? "" },
				problem: problem as RangeProblem | null,
				range: "",
				report: null,
			},
			{ status: 400 },
		);
	}

	const { query, days, lines, currency } = report;
	const locale = negotiateLocale(request.headers.get("Accept-Language"));
	/** Amounts in their currencies, never added across them; nothing, in the organisation's. */
	const costs = (amounts: readonly Money[]) =>
		amounts.length === 0
			? formatMoney(0, currency, locale)
			: amounts.map((each) => formatMoney(each.amountMinor, each.currency, locale)).join(" · ");
	const totals = contractorTotals(lines);
	const step = (by: Step) => {
		const stepped = steppedRange(query.range, days, by);
		return searchOf(stepped.range, stepped.days);
	};
	const unit = stepUnit(query.range, days);

	// The way back to the week or month holding today, while the range is another.
	const kind = steppedRange(query.range, days, 1).range;
	const back = kind === "custom" ? null : kind === "week" ? "this-week" : "this-month";
	const holdingToday =
		back &&
		rangeDays(
			{ range: back, group: "project" },
			dayOf(now, organisation.timeZone),
			organisation.weekStartsOn,
		);
	const current =
		back && holdingToday && holdingToday.first !== days.first
			? { to: searchOf(back, holdingToday), label: RANGE_LABELS[back] }
			: undefined;

	return data(
		{
			...page,
			tabSearch: searchOf(query.range, days),
			query: { range: query.range, from: days.first, to: days.last },
			problem: null as RangeProblem | null,
			range: rangeLabel(days.first, days.last),
			report: {
				steps: {
					previous: { to: step(-1), label: `Previous ${unit}` },
					next: { to: step(1), label: `Next ${unit}` },
					current,
				},
				lines: lines.map((line) => ({
					id: line.id,
					name: line.name,
					cost: costs(line.costs),
					detail: [
						`${hoursAndMinutes(line.seconds)} hours`,
						line.missingSeconds > 0
							? `Missing rate for ${hoursAndMinutes(line.missingSeconds)}`
							: null,
						line.left ? "Left the organisation" : null,
					]
						.filter(Boolean)
						.join(" · "),
				})),
				total: {
					hours: hoursAndMinutes(totals.seconds),
					cost: costs(totals.costs),
					missing: totals.missingSeconds > 0 ? hoursAndMinutes(totals.missingSeconds) : null,
				},
				hasContractors: report.hasContractors,
				exportPath: contractorsExportPath(organisation.slug, searchOf(query.range, days)),
			},
		},
		{ status: 200 },
	);
}

export default function Contractors({ loaderData }: Route.ComponentProps) {
	const { report, members } = loaderData;

	return (
		<>
			<PageHeading>{REPORTS}</PageHeading>
			<PageLead>
				What each contractor in {loaderData.organisation} tracked, unrounded, and what it cost at
				their cost rates, including people who have left.
			</PageLead>
			<ReportTabs
				slug={loaderData.slug}
				current="contractors"
				views={loaderData.views}
				search={loaderData.tabSearch}
			/>

			<div className="mt-8 max-w-200">
				<FilterBar name="Choose a range">
					<RangeFields
						query={loaderData.query}
						range={loaderData.range}
						problem={loaderData.problem}
					/>
				</FilterBar>
			</div>

			{report && (
				<>
					<div className="mt-8">
						<PeriodStepper
							label="Report range"
							period={loaderData.range}
							previous={report.steps.previous}
							next={report.steps.next}
							current={report.steps.current}
						/>
					</div>

					<div className="mt-4 max-w-200">
						<Ledger heading="Hours and cost" note={loaderData.range}>
							{report.lines.length > 0 ? (
								<LedgerRows label="Contractors' hours and cost">
									{report.lines.map((line) => (
										<LedgerRow
											key={line.id}
											title={<span className="wrap-anywhere">{line.name}</span>}
											detail={line.detail}
											value={line.cost}
										/>
									))}
								</LedgerRows>
							) : (
								<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
									{report.hasContractors ? (
										"No contractor tracked time in this range."
									) : members ? (
										<>
											Nobody here is a contractor yet.{" "}
											<Link to={members} className={TEXT_LINK}>
												Mark a member as a contractor
											</Link>{" "}
											from their Actions on Members.
										</>
									) : (
										"Nobody here is a contractor yet. Owners and admins mark them on Members."
									)}
								</p>
							)}
							<LedgerTotal label={`Total, ${report.total.hours} hours`} value={report.total.cost} />
						</Ledger>
						{report.total.missing && (
							<p className="mt-4 max-w-160 text-body-medium text-on-surface-variant">
								{report.total.missing} hours have no cost rate in force and count as nothing until
								one covers them.
							</p>
						)}
						<p className="mt-2">
							<DownloadLink href={report.exportPath} className={ACTION_LINK}>
								Export as CSV
							</DownloadLink>
						</p>
					</div>
				</>
			)}
		</>
	);
}

/** Each field of the choice grows to share its row, as on Reports. */
const FIELD = "min-w-0 grow basis-44";

/**
 * The fields that choose the range, sent in the address, so a report is a
 * link. Range applies as soon as it changes; the days of a custom range apply
 * once both hold a whole date, or on Enter, as on Reports.
 */
function RangeFields({
	query,
	range: shown,
	problem,
}: Pick<Route.ComponentProps["loaderData"], "query" | "range" | "problem">) {
	const apply = useApplyFilters();
	// The hidden select and the inputs hold the new value once React has drawn it.
	const applySoon = () => setTimeout(apply, 0);

	const [range, setRange] = useState<Range>(query.range);
	const [from, setFrom] = useState(query.from);
	const [to, setTo] = useState(query.to);
	// The address changed (applied, Back, a step): show what it holds.
	useEffect(() => {
		setRange(query.range);
		setFrom(query.from);
		setTo(query.to);
	}, [query.range, query.from, query.to]);

	// A week or a month the stepper moved to is offered while it is shown, by its days.
	const stepped = (id: Range) => id === "week" || id === "month";
	const ranges = RANGES.filter((id) => !stepped(id) || id === query.range);
	const applyDays = (first: string, last: string) => {
		if (WHOLE_DATE.test(first) && WHOLE_DATE.test(last)) applySoon();
	};
	const fieldError = (field: RangeProblem["field"]) =>
		problem?.field === field ? { isInvalid: true, errorMessage: problem.message } : {};

	return (
		<>
			<div className={FIELD}>
				<Select
					label="Range"
					name="range"
					options={ranges.map((id) => ({ id, label: stepped(id) ? shown : RANGE_LABELS[id] }))}
					value={range}
					onChange={(id) => {
						const next = RANGES.find((each) => each === id) ?? range;
						setRange(next);
						// A custom range waits for its days.
						if (next !== "custom") applySoon();
					}}
				/>
			</div>
			{range === "custom" && (
				<>
					<div className={FIELD}>
						<TextField
							label="First day"
							name="from"
							type="date"
							value={from}
							onChange={(value) => {
								setFrom(value);
								applyDays(value, to);
							}}
							{...fieldError("from")}
						/>
					</div>
					<div className={FIELD}>
						<TextField
							label="Last day"
							name="to"
							type="date"
							value={to}
							min={WHOLE_DATE.test(from) ? from : undefined}
							onChange={(value) => {
								setTo(value);
								applyDays(from, value);
							}}
							{...fieldError("to")}
						/>
					</div>
				</>
			)}
			{stepped(range) && <input type="hidden" name="from" value={query.from} />}
		</>
	);
}
