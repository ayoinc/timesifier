import { data } from "react-router";

import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { membershipContext } from "~/organisations/membership.server";
import { hoursAndMinutes } from "~/reports/format";
import { Headline, RangeSteps } from "~/reports/RangeSteps";
import { ReportChoice } from "~/reports/ReportChoice";
import { ReportTabs } from "~/reports/ReportTabs";
import { reportRequest, rowsOfReport } from "~/reports/reports.server";
import { SaveReport } from "~/reports/SaveReport";
import { percentLabel, shareOfCapacity, type UtilisationFigures } from "~/reports/utilisation";
import { utilisationReport } from "~/reports/utilisation.server";
import { openedFrom, viewAction, viewFrame, viewsFor } from "~/reports/view.server";
import { destination } from "~/shell/destinations";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { formatDuration } from "~/time/format";

import type { Route } from "./+types/reports.utilisation";

// The Utilisation view of Reports (TS-068, B8): for a range, each person's
// capacity (their working week less public holidays and approved leave),
// what they tracked and what of it bills, as utilisation and billable
// utilisation; then each team's and everyone's. Whose figures it holds is
// the viewer's to see, as for time (`timeScopeOf`). Nobody is stopped from
// tracking beyond capacity; a person with none shows "—".

const { label } = destination("reports");

export function meta() {
	return [{ title: `Utilisation · ${label} · Timesifier` }];
}

export async function action({ request, context }: Route.ActionArgs) {
	return viewAction(request, context.get(membershipContext), "utilisation");
}

/** The figures of a line, in words. */
interface ShownFigures {
	capacity: string;
	logged: string;
	billable: string;
	utilisation: string;
	billableUtilisation: string;
}

/** The figures of a line as the page shows them. */
function shown(figures: UtilisationFigures): ShownFigures {
	return {
		capacity: formatDuration(figures.capacityMinutes * 60),
		logged: hoursAndMinutes(figures.loggedSeconds),
		billable: hoursAndMinutes(figures.billableSeconds),
		utilisation: percentLabel(shareOfCapacity(figures.loggedSeconds, figures.capacityMinutes)),
		billableUtilisation: percentLabel(
			shareOfCapacity(figures.billableSeconds, figures.capacityMinutes),
		),
	};
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const url = new URL(request.url);
	const report = await reportRequest(membership, url, Date.now());
	const around = {
		...viewFrame(report, { grouped: false }),
		views: viewsFor(membership.role),
		slug: membership.organisation.slug,
	};
	// A custom range that makes no report: the fields again, with the reason (TS-091, W05).
	if ("problem" in report) return data({ ...around, opened: null, view: null }, { status: 400 });
	const rows = await rowsOfReport(report);
	const [utilisation, opened] = await Promise.all([
		utilisationReport(report, rows),
		openedFrom(membership, url),
	]);
	const view = {
		people: utilisation.people.map((p) => ({
			id: p.id,
			name: p.name,
			address: p.address,
			leave: p.leaveMinutes > 0 ? `${formatDuration(p.leaveMinutes * 60)} leave` : null,
			...shown(p),
		})),
		teams: utilisation.teams.map((t) => ({
			id: t.id,
			name: t.name,
			people: t.people,
			...shown(t),
		})),
		total: shown(utilisation.total),
	};
	return data({ ...around, opened, view }, { status: 200 });
}

export default function Utilisation({ loaderData }: Route.ComponentProps) {
	const { view } = loaderData;
	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>
				Time tracked against capacity: each person's working week, less public holidays and approved
				leave.
			</PageLead>
			<ReportTabs
				slug={loaderData.slug}
				current="utilisation"
				views={loaderData.views}
				search={loaderData.tabSearch}
			/>
			<ReportChoice {...loaderData} />
			<RangeSteps range={loaderData.range} steps={loaderData.steps} />
			{view && <Figures {...view} range={loaderData.range} opened={loaderData.opened} />}
		</>
	);
}

type Shown = NonNullable<Route.ComponentProps["loaderData"]["view"]>;

function Figures({
	people,
	teams,
	total,
	range,
	opened,
}: Shown & Pick<Route.ComponentProps["loaderData"], "range" | "opened">) {
	const detail = (line: ShownFigures) =>
		`${line.logged} of ${line.capacity} capacity · ${line.billable} billable, ${line.billableUtilisation}`;

	return (
		<>
			<Headline
				label="Utilisation"
				value={total.utilisation}
				beside={`${total.logged} of ${total.capacity} · billable ${total.billableUtilisation}`}
			/>
			<SaveReport opened={opened} />

			<div className="mt-10 max-w-200">
				<Ledger heading="By person" note={range}>
					{people.length > 0 ? (
						<LedgerRows label="Utilisation by person">
							{people.map((p) => (
								<LedgerRow
									key={p.id}
									title={<span className="wrap-anywhere">{p.name}</span>}
									detail={
										<>
											{p.address && <span className="block wrap-anywhere">{p.address}</span>}
											{detail(p)}
											{p.leave && <span className="block">{p.leave}</span>}
										</>
									}
									value={p.utilisation}
								/>
							))}
						</LedgerRows>
					) : (
						<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
							Nobody to show in this range.
						</p>
					)}
					<LedgerTotal label="Everyone shown" value={total.utilisation} />
				</Ledger>
			</div>

			{teams.length > 0 && (
				<Section
					id="teams"
					heading="Teams"
					lead="Each team's members added together: their capacity, what they tracked and what bills."
				>
					<div className="max-w-200">
						<Ledger heading="By team" note={range}>
							<LedgerRows label="Utilisation by team">
								{teams.map((t) => (
									<LedgerRow
										key={t.id}
										title={<span className="wrap-anywhere">{t.name}</span>}
										detail={`${t.people} ${t.people === 1 ? "person" : "people"} · ${detail(t)}`}
										value={t.utilisation}
									/>
								))}
							</LedgerRows>
						</Ledger>
					</div>
				</Section>
			)}
		</>
	);
}
