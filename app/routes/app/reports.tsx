import { data } from "react-router";
import { DownloadLink } from "~/components/DownloadLink";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { halfDaysLabel } from "~/leave/kinds";
import { membershipContext } from "~/organisations/membership.server";
import { billableSplitOf } from "~/reports/amounts.server";
import { BillableSplit } from "~/reports/BillableSplit";
import { GROUP_LABELS, GROUPS } from "~/reports/choices";
import { dayLabel, hoursAndMinutes } from "~/reports/format";
import { reportExportPath } from "~/reports/paths";
import { reportSearch } from "~/reports/query";
import { Headline, RangeSteps } from "~/reports/RangeSteps";
import { ReportChoice } from "~/reports/ReportChoice";
import { ReportTabs } from "~/reports/ReportTabs";
import { byStart, totalsOf } from "~/reports/report";
import { peopleOfReport, reportRequest, rowsOfReport } from "~/reports/reports.server";
import { SaveReport } from "~/reports/SaveReport";
import { timetableOf } from "~/reports/timetable";
import { openedFrom, viewAction, viewFrame, viewsFor } from "~/reports/view.server";
import { WeekTimetable as Timetable } from "~/reports/WeekTimetable";
import { destination } from "~/shell/destinations";
import { ACTION_LINK } from "~/shell/links";
import { negotiateLocale } from "~/shell/locale";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { tagOptions } from "~/tags/tags.server";
import { daysFrom, isoWeekday } from "~/time/calendar";
import { formatDuration, formatTimeRange } from "~/time/format";

import type { Route } from "./+types/reports";

// Reports (TS-014a): the time in a range of days, grouped by project, client
// or day, with each entry under it, and its export as CSV (TS-014b). Whose time
// it holds is the viewer's to see: their own, their teams' as a manager,
// everyone's as an owner or admin (app/reports/reports.server.ts). An entry
// counts whole on the day it starts in the viewer's zone, as on the Timesheet
// (docs/decisions.md entry 26). The filters apply as they change; the stepper
// moves the range by its own length (TS-059, TS-091). The range's total is the
// largest figure, and a week is drawn as a timetable of projects by days
// (harvest-taste item 10). It is the Time view; the others are pages beside it
// (app/reports/views.ts), and any can be saved (TS-080).

const { label } = destination("reports");

/** The most entries the page lists. The export holds all of them. */
const ENTRIES_SHOWN = 200;

/**
 * Time split into regular and overtime (TS-095), "6:00 regular · 1:30
 * overtime", or null when none of it is overtime: a line with no overtime says
 * nothing more.
 */
function overtimeLabel(minutes: number, overtimeMinutes: number): string | null {
	if (overtimeMinutes <= 0) return null;
	return `${hoursAndMinutes((minutes - overtimeMinutes) * 60)} regular · ${hoursAndMinutes(overtimeMinutes * 60)} overtime`;
}

const WEEKDAYS = [
	["Mon", "Monday"],
	["Tue", "Tuesday"],
	["Wed", "Wednesday"],
	["Thu", "Thursday"],
	["Fri", "Friday"],
	["Sat", "Saturday"],
	["Sun", "Sunday"],
] as const;

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export async function action({ request, context }: Route.ActionArgs) {
	return viewAction(request, context.get(membershipContext), "time");
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const url = new URL(request.url);
	const report = await reportRequest(membership, url, Date.now());
	const { query, grouping, zone, choices, showClients, seesEveryone } = report;
	// Whether the viewer may see anybody's time but their own.
	const others = choices.length > 1;
	const chosen = choices.find(({ id }) => id === query.person);

	const page = {
		...viewFrame(report, { grouped: true, tags: await tagOptions(report.scope) }),
		views: viewsFor(membership.role),
		slug: membership.organisation.slug,
		whose: chosen
			? `The time of ${chosen.name}.`
			: seesEveryone
				? `Everyone's time in ${membership.organisation.name}.`
				: others
					? "Your time, and that of the people in the teams you manage."
					: "Your time.",
		zone,
		groupings: showClients ? [...GROUPS] : GROUPS.filter((each) => each !== "client"),
	};

	// A custom range that makes no report: the form again, holding what was
	// typed, with the reason under its field (TS-091, W05).
	if ("problem" in report) {
		return data({ ...page, opened: null, report: null }, { status: 400 });
	}

	const { days, today } = report;
	const rows = (await rowsOfReport(report)).sort(byStart);
	const totals = totalsOf(rows, grouping);
	const [lines, opened] = await Promise.all([
		peopleOfReport(report, rows),
		openedFrom(membership, url),
	]);
	// The address of the export: the report as the page reads it, written out
	// in full, so the file holds the rows on this page.
	const search = reportSearch({
		group: grouping,
		person: query.person,
		tag: query.tag,
		range: query.range,
		days,
	});
	// A week is drawn as a timetable of projects by days.
	const isWeek = ["this-week", "last-week", "week"].includes(query.range);
	const week = isWeek ? timetableOf(rows, daysFrom(days.first, days.last)) : null;
	const expected = lines.reduce((sum, line) => sum + line.expectedMinutes, 0);

	return data(
		{
			...page,
			opened,
			report: {
				groups: totals.groups.map((group) => ({
					key: group.key,
					label: grouping === "day" ? dayLabel(group.key) : (group.label ?? "No client"),
					duration: hoursAndMinutes(group.minutes * 60),
					/** Of its time, the overtime (TS-095); none says nothing. */
					overtime: overtimeLabel(group.minutes, group.overtimeMinutes),
				})),
				total: hoursAndMinutes(totals.minutes * 60),
				expected:
					[
						lines.length > 0 ? `of ${formatDuration(expected * 60)} expected` : null,
						totals.overtimeMinutes > 0
							? `${hoursAndMinutes(totals.overtimeMinutes * 60)} of it overtime`
							: null,
					]
						.filter(Boolean)
						.join(" · ") || undefined,
				week: week && {
					days: week.days.map((day) => {
						const [short, name] = WEEKDAYS[isoWeekday(day) - 1] ?? ["", ""];
						return { day, short, name: `${name} ${dayLabel(day)}`, isToday: day === today };
					}),
					rows: week.rows.map((row) => ({
						key: row.key,
						label: row.label,
						cells: row.cells.map(hoursAndMinutes),
						empty: row.cells.map((seconds) => seconds === 0),
						total: hoursAndMinutes(row.total),
					})),
					dayTotals: week.dayTotals.map(hoursAndMinutes),
					total: hoursAndMinutes(week.total),
				},
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
						overtime: entry.overtime,
					};
				}),
				entryCount: rows.length,
				/** Each person's worked time beside the time expected of them and their leave (TS-061). */
				people: lines.map((line) => ({
					id: line.id,
					name: line.name,
					address: line.address,
					worked: hoursAndMinutes(line.worked),
					overtime: overtimeLabel(line.worked / 60, line.overtime / 60),
					expected: formatDuration(line.expectedMinutes * 60),
					leave:
						line.leaveHalfDays === 0
							? "No leave"
							: `${formatDuration(line.leaveMinutes * 60)} leave (${halfDaysLabel(line.leaveHalfDays)})`,
					/** Requests for leave starting in the range made at short notice (TS-090); none says nothing. */
					shortNotice: line.shortNotice === 0 ? null : `Short-notice requests: ${line.shortNotice}`,
				})),
				exportPath: reportExportPath(membership.organisation.slug, `?${search}`),
				/** Billable and non-billable time, and for those who see rates its amount (TS-066, TS-067). */
				split: await billableSplitOf(
					report,
					rows,
					membership,
					negotiateLocale(request.headers.get("Accept-Language")),
				),
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
			<PageLead>{loaderData.whose}</PageLead>

			<ReportTabs
				slug={loaderData.slug}
				current="time"
				views={loaderData.views}
				search={loaderData.tabSearch}
			/>
			<ReportChoice {...loaderData} />
			<RangeSteps range={loaderData.range} steps={loaderData.steps} />

			{report && (
				<>
					<Headline label="Total" value={report.total} beside={report.expected} />
					<SaveReport opened={loaderData.opened} />

					{report.week && (
						<div className="mt-10 max-w-200">
							<Timetable
								caption="The week in hours and minutes, by project and day."
								{...report.week}
							/>
						</div>
					)}

					<div className="mt-10 max-w-200">
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
											detail={group.overtime ?? undefined}
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

						<BillableSplit split={report.split} range={loaderData.range} />
						<p className="mt-2">
							<DownloadLink href={report.exportPath} className={ACTION_LINK}>
								Export as CSV
							</DownloadLink>
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
													{person.address && (
														<span className="block wrap-anywhere">{person.address}</span>
													)}
													{`${person.expected} expected · ${person.leave}`}
													{person.overtime && <span className="block">{person.overtime}</span>}
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
							lead={`Each entry whole on the day it starts in ${loaderData.zone}, even past midnight, a running one up to now, as the export lists them.`}
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
											detail={
												<span className="wrap-anywhere">
													{entry.detail}
													{entry.overtime && " · Overtime"}
												</span>
											}
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
