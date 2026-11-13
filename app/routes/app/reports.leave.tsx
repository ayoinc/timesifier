import { data } from "react-router";
import { DownloadLink } from "~/components/DownloadLink";
import { FilterBar, useApplyFilters } from "~/components/FilterBar";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { halfDaysLabel } from "~/leave/kinds";
import { membershipContext } from "~/organisations/membership.server";
import { EVERYONE } from "~/reports/choices";
import { leaveYearOf } from "~/reports/leave";
import {
	type LeaveBalanceLine,
	leaveBalances,
	leavePeopleOf,
	leaveTotals,
} from "~/reports/leave.server";
import { ReportTabs } from "~/reports/ReportTabs";
import { reportRequest } from "~/reports/reports.server";
import { SaveReport } from "~/reports/SaveReport";
import { openedFrom, viewAction, viewFrame, viewsFor } from "~/reports/view.server";
import { leaveExportPath } from "~/reports/views";
import { destination } from "~/shell/destinations";
import { ACTION_LINK } from "~/shell/links";
import { PageHeading, PageLead } from "~/shell/PageHeading";

import type { Route } from "./+types/reports.leave";

// The Leave view of Reports (TS-084, B3): for the leave year, each person's
// allowance of each kind of leave, what they have taken, what is booked, what
// waits for a decision and what remains, with its CSV, one row for each
// person and kind. It lists the people whose kind of leave the viewer may see
// (`maySeeLeaveKindOf`): everyone for an owner or admin, a manager's own and
// their teams' people, anyone else their own.

const { label } = destination("reports");

export function meta() {
	return [{ title: `Leave · ${label} · Timesifier` }];
}

export async function action({ request, context }: Route.ActionArgs) {
	return viewAction(request, context.get(membershipContext), "leave");
}

/** Half days in words, or "—" for none at all (no allowance). */
const days = (halfDays: number | null) =>
	halfDays === null ? "—" : halfDays === 0 ? "0 days" : halfDaysLabel(halfDays);

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const url = new URL(request.url);
	const report = await reportRequest(membership, url, Date.now());
	const year = leaveYearOf(url.searchParams.get("year"), report.today);
	if (year === null) throw data("Bad Request", { status: 400 });
	const [lines, opened] = await Promise.all([
		leaveBalances(report, year, report.today),
		openedFrom(membership, url),
	]);
	const thisYear = Number(report.today.slice(0, 4));
	const people = leavePeopleOf(report);
	const exportSearch = new URLSearchParams({ year: String(year) });
	if (report.query.person !== undefined) exportSearch.set("person", report.query.person);
	const totals = leaveTotals(lines);

	// One sheet a person, each kind a row.
	const byPerson = new Map<
		string,
		{ id: string; name: string; address: string | null; kinds: LeaveBalanceLine[] }
	>();
	for (const line of lines) {
		const sheet = byPerson.get(line.personId) ?? {
			id: line.personId,
			name: line.person,
			address: line.address,
			kinds: [],
		};
		sheet.kinds.push(line);
		byPerson.set(line.personId, sheet);
	}

	return {
		...viewFrame(report, { grouped: false }),
		views: viewsFor(membership.role),
		opened,
		slug: membership.organisation.slug,
		year,
		years: [...new Set([thisYear - 1, thisYear, thisYear + 1, year])].sort(),
		person: report.query.person ?? EVERYONE,
		people: people.length > 1 ? people.map(({ id, name }) => ({ id, name })) : [],
		sheets: [...byPerson.values()].map((sheet) => ({
			id: sheet.id,
			name: sheet.name,
			address: sheet.address,
			kinds: sheet.kinds.map((line) => ({
				id: line.kindId,
				kind: line.kind,
				remaining: line.remaining === null ? "No allowance" : `${days(line.remaining)} left`,
				detail: [
					line.allowance === null ? null : `${days(line.allowance)} a year`,
					`${days(line.taken)} taken`,
					`${days(line.booked)} booked`,
					`${days(line.pending)} pending`,
				]
					.filter(Boolean)
					.join(" · "),
			})),
		})),
		totals: `${days(totals.taken)} taken · ${days(totals.booked)} booked · ${days(totals.pending)} pending`,
		exportPath: leaveExportPath(membership.organisation.slug, `?${exportSearch}`),
	};
}

export default function LeaveReport({ loaderData }: Route.ComponentProps) {
	const { sheets, year, years, people, person } = loaderData;

	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>
				Leave for {year}, by person and kind: taken up to today, booked after it, waiting for a
				decision, and what remains of each allowance.
			</PageLead>
			<ReportTabs
				slug={loaderData.slug}
				current="leave"
				views={loaderData.views}
				search={loaderData.tabSearch}
			/>

			<div className="mt-8">
				<FilterBar name="Choose a leave year">
					<LeaveFields
						key={`${year}/${person}`}
						years={years}
						year={year}
						people={people}
						person={person}
					/>
				</FilterBar>
			</div>
			<SaveReport opened={loaderData.opened} />

			<div className="mt-10 flex max-w-200 flex-col gap-6">
				{sheets.length === 0 ? (
					<Ledger heading={String(year)}>
						<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
							No leave to show for {year}.
						</p>
					</Ledger>
				) : (
					sheets.map((sheet) => (
						<Ledger
							key={sheet.id}
							heading={
								<>
									<span className="wrap-anywhere">{sheet.name}</span>
									{sheet.address && (
										<span className="block text-body-medium text-on-surface-variant wrap-anywhere">
											{sheet.address}
										</span>
									)}
								</>
							}
							note={String(year)}
						>
							<LedgerRows label={`Leave of ${sheet.name}`}>
								{sheet.kinds.map((kind) => (
									<LedgerRow
										key={kind.id}
										title={kind.kind}
										detail={kind.detail}
										value={kind.remaining}
									/>
								))}
							</LedgerRows>
						</Ledger>
					))
				)}
				{sheets.length > 0 && (
					<Ledger heading="Everyone shown" note={String(year)}>
						<LedgerTotal label="Total" value={loaderData.totals} />
					</Ledger>
				)}
			</div>
			<p className="mt-4">
				<DownloadLink href={loaderData.exportPath} className={ACTION_LINK}>
					Export as CSV
				</DownloadLink>
			</p>
		</>
	);
}

/** The leave year and the person, each applied as soon as it changes (TS-091's FilterBar). */
function LeaveFields({
	years,
	year,
	people,
	person,
}: {
	years: number[];
	year: number;
	people: { id: string; name: string }[];
	person: string;
}) {
	const apply = useApplyFilters();
	// The select holds the new value once React has drawn it.
	const applySoon = () => setTimeout(apply, 0);
	return (
		<>
			<div className="min-w-0 grow basis-44">
				<Select
					label="Leave year"
					name="year"
					options={years.map((each) => ({ id: String(each), label: String(each) }))}
					defaultValue={String(year)}
					onChange={applySoon}
				/>
			</div>
			{people.length > 0 && (
				<div className="min-w-0 grow basis-44">
					<Select
						label="Person"
						name="person"
						options={[
							{ id: EVERYONE, label: "Everyone" },
							...people.map(({ id, name }) => ({ id, label: name })),
						]}
						defaultValue={person}
						onChange={applySoon}
					/>
				</div>
			)}
		</>
	);
}
