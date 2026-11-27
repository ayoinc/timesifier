import { data } from "react-router";

import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { membershipContext } from "~/organisations/membership.server";
import { hoursAndMinutes } from "~/reports/format";
import { type PlanFigures, planDifference, plannedReport } from "~/reports/planned.server";
import { Headline, RangeSteps } from "~/reports/RangeSteps";
import { ReportChoice } from "~/reports/ReportChoice";
import { ReportTabs } from "~/reports/ReportTabs";
import { reportRequest } from "~/reports/reports.server";
import { viewFrame, viewsFor } from "~/reports/view.server";
import { destination } from "~/shell/destinations";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { inTerms } from "~/workspace/work-model";

import type { Route } from "./+types/reports.planned";
import { useTerms } from "./useOrganisation";

// The Planned view of Reports (TS-116, docs/decisions.md entry 78): for a
// range, what each person's time shares plan against what they tracked, by
// person and by project, and in all (`plannedReport`). Whose time it holds is
// the viewer's to see, as for time (`timeScopeOf`); of those people's shares,
// only the ones the viewer sees (`ShareSight`). It shows no money, so it is
// shown to everyone Utilisation is.

const { label } = destination("reports");

export function meta() {
	return [{ title: `Planned · ${label} · Timesifier` }];
}

/** The figures of a line in words: "22:30", "18:00", "4:30 under plan". */
function shown(figures: PlanFigures) {
	return {
		planned: hoursAndMinutes(figures.plannedMinutes * 60),
		tracked: hoursAndMinutes(figures.trackedMinutes * 60),
		difference: planDifference(figures),
	};
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const report = await reportRequest(membership, new URL(request.url), Date.now());
	const around = {
		...viewFrame(report, { grouped: false }),
		views: viewsFor(membership.role),
		slug: membership.organisation.slug,
	};
	// A custom range that makes no report: the fields again, with the reason (TS-091, W05).
	if ("problem" in report) return data({ ...around, view: null }, { status: 400 });
	const planned = await plannedReport(report);
	const view = {
		people: planned.people.map((p) => ({
			id: p.id,
			name: p.name,
			address: p.address,
			...shown(p),
		})),
		work: planned.work.map((w) => ({ key: w.key, label: w.label, shared: w.shared, ...shown(w) })),
		total: shown(planned.total),
	};
	return data({ ...around, view }, { status: 200 });
}

export default function Planned({ loaderData }: Route.ComponentProps) {
	const { view } = loaderData;
	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>Each person's time share against what they tracked, over the range.</PageLead>
			<ReportTabs
				slug={loaderData.slug}
				current="planned"
				views={loaderData.views}
				search={loaderData.tabSearch}
			/>
			<ReportChoice {...loaderData} />
			<RangeSteps range={loaderData.range} steps={loaderData.steps} />
			{view && <Figures {...view} range={loaderData.range} />}
		</>
	);
}

type Shown = NonNullable<Route.ComponentProps["loaderData"]["view"]>;

/** A line's planned and tracked time: "22:30 planned, 18:00 tracked". */
function plannedAndTracked(line: { planned: string; tracked: string }): string {
	return `${line.planned} planned, ${line.tracked} tracked`;
}

/** The total under a sheet: what it adds up, with its planned and tracked time under the words. */
function TotalLabel({
	words,
	line,
}: {
	words: string;
	line: { planned: string; tracked: string };
}) {
	return (
		<>
			{words}
			<span className="block text-body-medium text-on-surface-variant">
				{plannedAndTracked(line)}
			</span>
		</>
	);
}

function Figures({ people, work, total, range }: Shown & { range: string }) {
	const terms = useTerms();
	return (
		<>
			<Headline
				label="Tracked against planned"
				value={total.tracked}
				beside={`of ${total.planned} planned · ${total.difference}`}
			/>

			<div className="mt-10 max-w-200">
				<Ledger heading="By person" note={range}>
					{people.length > 0 ? (
						<LedgerRows label="Planned against tracked by person">
							{people.map((p) => (
								<LedgerRow
									key={p.id}
									title={<span className="wrap-anywhere">{p.name}</span>}
									detail={
										<>
											{p.address && <span className="block wrap-anywhere">{p.address}</span>}
											{plannedAndTracked(p)}
										</>
									}
									value={p.difference}
								/>
							))}
						</LedgerRows>
					) : (
						<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
							No time shares and no tracked time in this range.
						</p>
					)}
					<LedgerTotal
						label={<TotalLabel words="Everyone shown" line={total} />}
						value={total.difference}
					/>
				</Ledger>
			</div>

			{work.length > 0 && (
				<Section
					id="projects"
					heading={terms.Projects}
					lead={inTerms(
						"Each project, and each work package a time share names, planned against tracked. Time tracked without a share counts against its project.",
						terms,
					)}
				>
					<div className="max-w-200">
						<Ledger heading={`By ${terms.project}`} note={range}>
							<LedgerRows label={`Planned against tracked by ${terms.project}`}>
								{work.map((w) => (
									<LedgerRow
										key={w.key}
										title={<span className="wrap-anywhere">{w.label}</span>}
										detail={`${plannedAndTracked(w)}${w.shared ? "" : " · no time share"}`}
										value={w.difference}
									/>
								))}
							</LedgerRows>
							<LedgerTotal
								label={<TotalLabel words={`All ${terms.projects}`} line={total} />}
								value={total.difference}
							/>
						</Ledger>
					</div>
				</Section>
			)}
		</>
	);
}
