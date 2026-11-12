import { useEffect, useState } from "react";
import { data } from "react-router";

import { FilterBar, useApplyFilters } from "~/components/FilterBar";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { PeriodStepper } from "~/components/PeriodStepper";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { halfDaysLabel } from "~/leave/kinds";
import { membershipContext } from "~/organisations/membership.server";
import {
	EVERYONE,
	GROUP_LABELS,
	GROUPS,
	type Grouping,
	RANGE_LABELS,
	RANGES,
	type Range,
} from "~/reports/choices";
import { dayLabel, hoursAndMinutes, rangeLabel, stepUnit } from "~/reports/format";
import { reportExportPath } from "~/reports/paths";
import {
	type RangeProblem,
	rangeDays,
	reportSearch,
	type Step,
	steppedRange,
} from "~/reports/query";
import { byStart, totalsOf } from "~/reports/report";
import { peopleOfReport, reportRequest, rowsOfReport } from "~/reports/reports.server";
import { destination } from "~/shell/destinations";
import { ACTION_LINK } from "~/shell/links";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { dayOf } from "~/time/calendar";
import { formatDuration, formatTimeRange } from "~/time/format";

import type { Route } from "./+types/reports";

// Reports (TS-014a): the time in a range of days, grouped by project, client
// or day, with each entry under it, and its export as CSV (TS-014b). Whose time
// it holds is the viewer's to see: their own, their teams' as a manager,
// everyone's as an owner or admin (app/reports/reports.server.ts). An entry
// counts whole on the day it starts in the viewer's zone, as on the Timesheet
// (docs/decisions.md entry 26). The filters apply as they change; the stepper
// moves the range by its own length (TS-059, TS-091).

const { label } = destination("reports");

/** The most entries the page lists. The export holds all of them. */
const ENTRIES_SHOWN = 200;

/** A date field's value once a whole date is in it. */
const WHOLE_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const report = await reportRequest(membership, new URL(request.url), Date.now());
	const { query, grouping, zone, choices, showClients, seesEveryone } = report;
	// Whether the viewer may see anybody's time but their own.
	const others = choices.length > 1;
	const chosen = choices.find(({ id }) => id === query.person);

	const page = {
		whose: chosen
			? `The time of ${chosen.name}.`
			: seesEveryone
				? `Everyone's time in ${membership.organisation.name}.`
				: others
					? "Your time, and that of the people in the teams you manage."
					: "Your time.",
		zone,
		groupings: showClients ? [...GROUPS] : GROUPS.filter((each) => each !== "client"),
		choices: others ? choices : [],
		everyone: seesEveryone ? "Everyone" : "You and your teams",
	};

	// A custom range that makes no report: the form again, holding what was
	// typed, with the reason under its field (TS-091, W05).
	if ("problem" in report) {
		return data(
			{
				...page,
				query: {
					range: query.range,
					from: query.from ?? "",
					to: query.to ?? "",
					group: grouping,
					person: query.person ?? EVERYONE,
				},
				problem: report.problem as RangeProblem | null,
				range: "",
				report: null,
			},
			{ status: 400 },
		);
	}

	const { days } = report;
	const rows = (await rowsOfReport(report)).sort(byStart);
	const totals = totalsOf(rows, grouping);
	const lines = await peopleOfReport(report, rows);
	const kept = { group: grouping, person: query.person };
	// The address of the export: the report as the page reads it, written out
	// in full, so the file holds the rows on this page.
	const search = reportSearch({ ...kept, range: query.range, days });
	// The ranges before and after, as links that keep the grouping and the person.
	const step = (by: Step) =>
		`?${reportSearch({ ...kept, ...steppedRange(query.range, days, by) })}`;
	const unit = stepUnit(query.range, days);

	// The way back to the week or month holding today, while the range is another.
	const kind = steppedRange(query.range, days, 1).range;
	const today = dayOf(report.now, zone);
	const weekStartsOn = membership.organisation.weekStartsOn;
	const back =
		kind === "custom"
			? null
			: ({ range: kind === "week" ? "this-week" : "this-month", group: grouping } as const);
	const holdingToday = back && rangeDays(back, today, weekStartsOn);
	const current =
		back && holdingToday && holdingToday.first !== days.first
			? {
					to: `?${reportSearch({ ...kept, range: back.range, days: holdingToday })}`,
					label: RANGE_LABELS[back.range],
				}
			: undefined;

	return data(
		{
			...page,
			query: {
				range: query.range,
				from: days.first,
				to: days.last,
				group: grouping,
				person: query.person ?? EVERYONE,
			},
			problem: null as RangeProblem | null,
			range: rangeLabel(days.first, days.last),
			report: {
				steps: {
					previous: { to: step(-1), label: `Previous ${unit}` },
					next: { to: step(1), label: `Next ${unit}` },
					current,
				},
				groups: totals.groups.map((group) => ({
					key: group.key,
					label: grouping === "day" ? dayLabel(group.key) : (group.label ?? "No client"),
					duration: hoursAndMinutes(group.minutes * 60),
				})),
				total: hoursAndMinutes(totals.minutes * 60),
				entries: rows.slice(0, ENTRIES_SHOWN).map((row) => {
					const { entry } = row;
					return {
						key: entry.id,
						description: entry.description,
						detail: [
							dayLabel(row.day),
							entry.project,
							showClients ? entry.client : null,
							others ? entry.person : null,
						]
							.filter(Boolean)
							.join(" · "),
						times: formatTimeRange(row.start, row.running ? null : row.end, zone),
						duration: hoursAndMinutes(row.minutes * 60),
					};
				}),
				entryCount: rows.length,
				/** Each person's worked time beside the time expected of them and their leave (TS-061). */
				people: lines.map((line) => ({
					id: line.id,
					name: line.name,
					worked: hoursAndMinutes(line.worked),
					expected: formatDuration(line.expectedMinutes * 60),
					leave:
						line.leaveHalfDays === 0
							? "No leave"
							: `${formatDuration(line.leaveMinutes * 60)} leave (${halfDaysLabel(line.leaveHalfDays)})`,
					/** Requests for leave starting in the range made at short notice (TS-090); none says nothing. */
					shortNotice: line.shortNotice === 0 ? null : `Short-notice requests: ${line.shortNotice}`,
				})),
				exportPath: reportExportPath(membership.organisation.slug, `?${search}`),
			},
		},
		{ status: 200 },
	);
}

export default function Reports({ loaderData }: Route.ComponentProps) {
	const { query, report } = loaderData;

	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>
				{loaderData.whose} Each entry counts whole on the day it starts, in your time zone,{" "}
				{loaderData.zone}, even when it runs past midnight. A running entry counts up to now.
			</PageLead>

			<div className="mt-8">
				<ReportChoice {...loaderData} />
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

					<div className="mt-4">
						<Ledger
							heading={`By ${GROUP_LABELS[query.group].toLowerCase()}`}
							note={loaderData.range}
						>
							{report.groups.length > 0 ? (
								<LedgerRows label={`Time by ${GROUP_LABELS[query.group].toLowerCase()}`}>
									{report.groups.map((group) => (
										<LedgerRow
											key={group.key}
											title={<span className="wrap-anywhere">{group.label}</span>}
											value={group.duration}
										/>
									))}
								</LedgerRows>
							) : (
								<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
									Nothing tracked in this range.
								</p>
							)}
							<LedgerTotal label="Total" value={report.total} />
						</Ledger>
						<p className="mt-2">
							<a href={report.exportPath} download className={ACTION_LINK}>
								Export as CSV
							</a>
						</p>
					</div>

					{report.people.length > 0 && (
						<Section
							id="people"
							heading="People"
							lead="Time worked beside the time expected of each person: their working week, less public holidays and approved leave. Leave is never counted as worked. Requests for leave made at short notice are counted by the day the leave starts."
						>
							<Ledger heading="Worked, expected and leave" note={loaderData.range}>
								<LedgerRows label="Worked, expected and leave by person">
									{report.people.map((person) => (
										<LedgerRow
											key={person.id}
											title={<span className="wrap-anywhere">{person.name}</span>}
											detail={
												<>
													{`${person.expected} expected · ${person.leave}`}
													{person.shortNotice && (
														<span className="block">{person.shortNotice}</span>
													)}
												</>
											}
											value={person.worked}
										/>
									))}
								</LedgerRows>
							</Ledger>
						</Section>
					)}

					{report.entryCount > 0 && (
						<Section
							id="entries"
							heading="Entries"
							lead="Each entry on the day it starts, as the export lists them."
						>
							<Ledger heading="Entries" note={report.entryCount}>
								<LedgerRows>
									{report.entries.map((entry) => (
										<LedgerRow
											key={entry.key}
											title={
												entry.description ? (
													<span className="wrap-anywhere">{entry.description}</span>
												) : (
													<span className="text-on-surface-variant">No description</span>
												)
											}
											detail={<span className="wrap-anywhere">{entry.detail}</span>}
											aside={entry.times}
											value={entry.duration}
										/>
									))}
								</LedgerRows>
							</Ledger>
							{report.entryCount > report.entries.length && (
								<p className="mt-4 max-w-160 text-body-medium text-on-surface-variant">
									The first {report.entries.length} of {report.entryCount} are listed here. The
									export holds every one.
								</p>
							)}
						</Section>
					)}
				</>
			)}
		</>
	);
}

type ChoiceProps = Pick<
	Route.ComponentProps["loaderData"],
	"query" | "groupings" | "choices" | "everyone" | "range" | "problem"
>;

/**
 * The fields that choose a report, sent in the address, so a report is a
 * link. Range, Group by and Person apply as soon as they change; the days of a
 * custom range apply once both hold a whole date, or on Enter (TS-091, W15 and
 * W28).
 */
function ReportChoice(props: ChoiceProps) {
	return (
		<FilterBar name="Choose a report">
			<ReportFields {...props} />
		</FilterBar>
	);
}

/**
 * Each field of the choice grows to share its row, so every row of fields runs
 * the width of the column and their edges line up (audit W21, W22).
 */
const FIELD = "min-w-0 grow basis-44";

function ReportFields({ query, groupings, choices, everyone, range: shown, problem }: ChoiceProps) {
	const apply = useApplyFilters();
	// The hidden select and the inputs hold the new value once React has drawn it.
	const applySoon = () => setTimeout(apply, 0);

	const [range, setRange] = useState<Range>(query.range);
	const [group, setGroup] = useState<Grouping>(query.group);
	const [person, setPerson] = useState(query.person);
	const [from, setFrom] = useState(query.from);
	const [to, setTo] = useState(query.to);
	// The address changed (applied, Back, a step): show what it holds.
	useEffect(() => {
		setRange(query.range);
		setGroup(query.group);
		setPerson(query.person);
		setFrom(query.from);
		setTo(query.to);
	}, [query.range, query.group, query.person, query.from, query.to]);

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
			<div className={FIELD}>
				<Select
					label="Group by"
					name="group"
					options={groupings.map((id) => ({ id, label: GROUP_LABELS[id] }))}
					value={group}
					onChange={(id) => {
						setGroup(GROUPS.find((each) => each === id) ?? group);
						applySoon();
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
			{choices.length > 0 && (
				<div className={FIELD}>
					<Select
						label="Person"
						name="person"
						options={[
							{ id: EVERYONE, label: everyone },
							...choices.map(({ id, name }) => ({ id, label: name })),
						]}
						value={person}
						onChange={(id) => {
							setPerson(id ?? EVERYONE);
							applySoon();
						}}
					/>
				</div>
			)}
		</>
	);
}
