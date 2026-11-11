import { useState } from "react";
import { Form, Link } from "react-router";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { halfDaysLabel } from "~/leave/kinds";
import { minutesLabel } from "~/leave/words";
import { membershipContext } from "~/organisations/membership.server";
import {
	EVERYONE,
	GROUP_LABELS,
	GROUPS,
	RANGE_LABELS,
	RANGES,
	type Range,
} from "~/reports/choices";
import { clockIn, dayLabel, hoursAndMinutes, rangeLabel, stepUnit } from "~/reports/format";
import { reportExportPath } from "~/reports/paths";
import { reportSearch, type Step, steppedRange } from "~/reports/query";
import { byStart, totalsOf } from "~/reports/report";
import { peopleOfReport, piecesOfReport, reportRequest } from "~/reports/reports.server";
import { destination } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";

import type { Route } from "./+types/reports";

// Reports (TS-014a): the time in a range of days, grouped by project, client
// or day, with each entry under it, and its export as CSV (TS-014b). Whose time
// it holds is the viewer's to see: their own, their teams' as a manager,
// everyone's as an owner or admin (app/reports/reports.server.ts). Previous and
// Next beside the range move it by its own length (TS-059).

const { label } = destination("reports");

/** The most entries the page lists. The export holds all of them. */
const ENTRIES_SHOWN = 200;

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const report = await reportRequest(membership, new URL(request.url), Date.now());
	const { query, grouping, days, zone, choices, showClients, seesEveryone } = report;
	const pieces = (await piecesOfReport(report)).sort(byStart);
	const totals = totalsOf(pieces, grouping);
	const lines = await peopleOfReport(report, pieces);
	// Whether the viewer may see anybody's time but their own.
	const others = choices.length > 1;

	// The address of the export: the report as the page reads it, written out
	// in full, so the file holds the rows on this page.
	const kept = { group: grouping, person: query.person };
	const search = reportSearch({ ...kept, range: query.range, days });
	// The ranges before and after, as links that keep the grouping and the person.
	const step = (by: Step) =>
		`?${reportSearch({ ...kept, ...steppedRange(query.range, days, by) })}`;

	const chosen = choices.find(({ id }) => id === query.person);
	return {
		query: {
			range: query.range,
			from: days.first,
			to: days.last,
			group: grouping,
			person: query.person ?? EVERYONE,
		},
		groupings: showClients ? [...GROUPS] : GROUPS.filter((each) => each !== "client"),
		choices: others ? choices : [],
		everyone: seesEveryone ? "Everyone" : "You and your teams",
		whose: chosen
			? `The time of ${chosen.name}.`
			: seesEveryone
				? `Everyone's time in ${membership.organisation.name}.`
				: others
					? "Your time, and that of the people in the teams you manage."
					: "Your time.",
		zone,
		range: rangeLabel(days.first, days.last),
		steps: { unit: stepUnit(query.range, days), previous: step(-1), next: step(1) },
		groups: totals.groups.map((group) => ({
			key: group.key,
			label: grouping === "day" ? dayLabel(group.key) : (group.label ?? "No client"),
			duration: hoursAndMinutes(group.seconds),
		})),
		total: hoursAndMinutes(totals.seconds),
		entries: pieces.slice(0, ENTRIES_SHOWN).map((piece) => {
			const { entry } = piece;
			return {
				key: `${entry.id}/${piece.day}`,
				description: entry.description,
				detail: [
					dayLabel(piece.day),
					entry.project,
					showClients ? entry.client : null,
					others ? entry.person : null,
				]
					.filter(Boolean)
					.join(" · "),
				times: `${clockIn(piece.start, zone)}–${piece.running ? "now" : clockIn(piece.end, zone)}`,
				duration: hoursAndMinutes(piece.seconds),
			};
		}),
		entryCount: pieces.length,
		/** Each person's worked time beside the time expected of them and their leave (TS-061). */
		people: lines.map((line) => ({
			id: line.id,
			name: line.name,
			worked: hoursAndMinutes(line.worked),
			expected: minutesLabel(line.expectedMinutes),
			leave:
				line.leaveHalfDays === 0
					? "No leave"
					: `${minutesLabel(line.leaveMinutes)} leave (${halfDaysLabel(line.leaveHalfDays)})`,
		})),
		exportPath: reportExportPath(membership.organisation.slug, `?${search}`),
	};
}

export default function Reports({ loaderData }: Route.ComponentProps) {
	const { query, groups, entries, entryCount, exportPath, steps } = loaderData;

	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>
				{loaderData.whose} Days run midnight to midnight in {loaderData.zone}, the organisation's
				time zone; an entry that crosses midnight counts on both days, and a running one up to now.
			</PageLead>

			{/* Keyed by the report, so a new report starts its fields at what it shows. */}
			<ReportChoice key={exportPath} {...loaderData} />

			{/* The range, and the ones before and after it by its own length. */}
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
				<Ledger heading={`By ${GROUP_LABELS[query.group].toLowerCase()}`} note={loaderData.range}>
					{groups.length > 0 ? (
						<LedgerRows label={`Time by ${GROUP_LABELS[query.group].toLowerCase()}`}>
							{groups.map((group) => (
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
					<LedgerTotal label="Total" value={loaderData.total} />
				</Ledger>
				<p className="mt-4">
					<a href={exportPath} download className={TEXT_LINK}>
						Export as CSV
					</a>
				</p>
			</div>

			{loaderData.people.length > 0 && (
				<Section
					id="people"
					heading="People"
					lead="Time worked beside the time expected of each person: their working week, less public holidays and approved leave. Leave is never counted as worked."
				>
					<div className="max-w-200">
						<Ledger heading="Worked, expected and leave" note={loaderData.range}>
							<LedgerRows label="Worked, expected and leave by person">
								{loaderData.people.map((person) => (
									<LedgerRow
										key={person.id}
										title={<span className="wrap-anywhere">{person.name}</span>}
										detail={`${person.expected} expected · ${person.leave}`}
										value={person.worked}
									/>
								))}
							</LedgerRows>
						</Ledger>
					</div>
				</Section>
			)}

			{entryCount > 0 && (
				<Section
					id="entries"
					heading="Entries"
					lead="Each entry on each day it has time in, as the export lists them."
				>
					<div className="max-w-200">
						<Ledger heading="Entries" note={entryCount}>
							<LedgerRows>
								{entries.map((entry) => (
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
						{entryCount > entries.length && (
							<p className="mt-4 max-w-160 text-body-medium text-on-surface-variant">
								The first {entries.length} of {entryCount} are listed here. The export holds every
								one.
							</p>
						)}
					</div>
				</Section>
			)}
		</>
	);
}

/** The fields that choose a report. They are sent in the address, so a report is a link. */
function ReportChoice({
	query,
	groupings,
	choices,
	everyone,
	range: shown,
}: Pick<
	Route.ComponentProps["loaderData"],
	"query" | "groupings" | "choices" | "everyone" | "range"
>) {
	const [range, setRange] = useState<Range>(query.range);
	// A week or a month Previous and Next stepped to is offered while it is shown, by its days.
	const stepped = (id: Range) => id === "week" || id === "month";
	const ranges = RANGES.filter((id) => !stepped(id) || id === query.range);

	return (
		<Form method="get" aria-label="Choose a report" className="mt-8 max-w-200">
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
					options={groupings.map((id) => ({ id, label: GROUP_LABELS[id] }))}
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
