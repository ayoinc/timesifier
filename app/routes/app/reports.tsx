import { data } from "react-router";
import { DownloadLink } from "~/components/DownloadLink";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { maySeeRates } from "~/organisations/access";
import { membershipContext } from "~/organisations/membership.server";
import { organisationMoney, pricingOf } from "~/projects/money.server";
import { billableSplitOf } from "~/reports/amounts.server";
import { BillableSplit } from "~/reports/BillableSplit";
import { GROUP_LABELS, GROUPS } from "~/reports/choices";
import { dayLabel, hoursAndMinutes, overtimeLabel } from "~/reports/format";
import { reportExportPath, reportPeoplePath } from "~/reports/paths";
import { groupPeopleOf, PEOPLE_SHOWN, personView } from "~/reports/people.server";
import { reportSearch } from "~/reports/query";
import { Headline, RangeSteps } from "~/reports/RangeSteps";
import { ReportChoice } from "~/reports/ReportChoice";
import { GroupRow, PeopleRows } from "~/reports/ReportPeople";
import { ReportTabs } from "~/reports/ReportTabs";
import { totalsOf } from "~/reports/report";
import { firstRowsOf, peopleOfReport, reportRequest } from "~/reports/reports.server";
import { SaveReport } from "~/reports/SaveReport";
import { pricedBy, sumsOf } from "~/reports/sums.server";
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
	// A week is drawn as a timetable of projects by days.
	const isWeek = ["this-week", "last-week", "week"].includes(query.range);
	const pricing = maySeeRates(membership.role)
		? await organisationMoney(membership.organisation.id).then(({ currency }) =>
				pricingOf(report.scope, currency),
			)
		: null;
	// The time added up in SQL (decision 57): by person, project and how it
	// bills, priced by span of rates for those who see them, and by day for a
	// week's timetable or the day grouping. The page lists its first entries.
	const [sums, listed] = await Promise.all([
		sumsOf(report, {
			money: pricing ? pricedBy(pricing) : undefined,
			byDay: isWeek ? "day-and-project" : grouping === "day" ? "day" : undefined,
		}),
		firstRowsOf(report, ENTRIES_SHOWN),
	]);
	const totals = totalsOf(grouping === "day" ? sums.days : sums.sums, grouping);
	// The page draws its groups; a group's people, or the People section of a
	// report of many people, are read when opened (TS-113, D8). Without
	// script, opening one asks for the page again with `show` in the address.
	const show = url.searchParams.get("show");
	const shownGroup =
		show !== null && totals.groups.some((group) => group.key === show) ? show : null;
	const [lines, opened, groupPeople] = await Promise.all([
		peopleOfReport(report, sums.sums),
		openedFrom(membership, url),
		shownGroup === null ? null : groupPeopleOf(report, grouping, shownGroup),
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
	const week = isWeek ? timetableOf(sums.days, daysFrom(days.first, days.last)) : null;
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
					/** Who tracked it, when the address opens it; otherwise read when it is opened. */
					people: group.key === shownGroup ? groupPeople : null,
				})),
				/** Where a group's people, and the People section, are read when opened. */
				peoplePath: reportPeoplePath(membership.organisation.slug, `?${search}`),
				/** The page asked for again with `show`: how a group opens without script. */
				showSearch: search.toString(),
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
				entries: listed.map((row) => {
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
				entryCount: sums.entries,
				/**
				 * Each person's worked time beside the time expected of them and
				 * their leave (TS-061); past `PEOPLE_SHOWN` people, null until the
				 * section is opened.
				 */
				people: lines.length <= PEOPLE_SHOWN || show === "people" ? lines.map(personView) : null,
				peopleCount: lines.length,
				exportPath: reportExportPath(membership.organisation.slug, `?${search}`),
				/** Billable and non-billable time, and for those who see rates its amount (TS-066, TS-067). */
				split: billableSplitOf(
					sums.sums,
					pricing,
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
										<GroupRow
											key={group.key}
											group={group}
											peoplePath={report.peoplePath}
											showSearch={report.showSearch}
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

					{report.peopleCount > 0 && (
						<Section
							id="people"
							heading="People"
							lead="Time worked beside the time expected of each person: their working week, less public holidays and approved leave. Leave is never counted as worked. Requests for leave made at short notice are counted by the day the leave starts."
						>
							<Ledger heading="Worked, expected and leave" note={loaderData.range}>
								<PeopleRows
									people={report.people}
									count={report.peopleCount}
									peoplePath={report.peoplePath}
									showSearch={report.showSearch}
								/>
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
