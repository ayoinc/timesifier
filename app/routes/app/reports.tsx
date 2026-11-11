import { useState } from "react";
import { Form } from "react-router";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { membershipContext } from "~/organisations/membership.server";
import {
	EVERYONE,
	GROUP_LABELS,
	GROUPS,
	RANGE_LABELS,
	RANGES,
	type Range,
} from "~/reports/choices";
import { clockIn, dayLabel, hoursAndMinutes, rangeLabel } from "~/reports/format";
import { reportExportPath } from "~/reports/paths";
import { byStart, totalsOf } from "~/reports/report";
import { piecesOfReport, reportRequest } from "~/reports/reports.server";
import { destination } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";

import type { Route } from "./+types/reports";

// Reports (TS-014a): the time in a range of days, grouped by project, client
// or day, with each entry under it, and its export as CSV (TS-014b). Whose time
// it holds is the viewer's to see: their own, their teams' as a manager,
// everyone's as an owner or admin (app/reports/reports.server.ts).

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
	// Whether the viewer may see anybody's time but their own.
	const others = choices.length > 1;

	// The address of the export: the report as the page reads it, written out
	// in full, so the file holds the rows on this page.
	const search = new URLSearchParams({ range: query.range });
	if (query.range === "custom") {
		search.set("from", days.first);
		search.set("to", days.last);
	}
	search.set("group", grouping);
	if (query.person !== undefined) search.set("person", query.person);

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
		exportPath: reportExportPath(membership.organisation.slug, `?${search}`),
	};
}

export default function Reports({ loaderData }: Route.ComponentProps) {
	const { query, groups, entries, entryCount, exportPath } = loaderData;

	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>
				{loaderData.whose} Days run midnight to midnight in {loaderData.zone}, the organisation's
				time zone; an entry that crosses midnight counts on both days, and a running one up to now.
			</PageLead>

			{/* Keyed by the report, so a new report starts its fields at what it shows. */}
			<ReportChoice key={exportPath} {...loaderData} />

			<div className="mt-10 max-w-200">
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
}: Pick<Route.ComponentProps["loaderData"], "query" | "groupings" | "choices" | "everyone">) {
	const [range, setRange] = useState<Range>(query.range);

	return (
		<Form method="get" aria-label="Choose a report" className="mt-8 max-w-200">
			<div className="grid gap-6 medium:grid-cols-2">
				<Select
					label="Range"
					name="range"
					options={RANGES.map((id) => ({ id, label: RANGE_LABELS[id] }))}
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
