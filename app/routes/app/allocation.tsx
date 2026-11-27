import { useEffect, useState } from "react";
import { Link } from "react-router";

import { CLIENT_PARAM, PROJECT_PARAM, planLine, TEAM_PARAM } from "~/allocations/allocations";
import { allocationView } from "~/allocations/view.server";
import { cx } from "~/components/cx";
import { FilterBar, FilterField, useApplyFilters } from "~/components/FilterBar";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Pager } from "~/components/Pager";
import { PeriodStepper } from "~/components/PeriodStepper";
import { Select } from "~/components/Select";
import { FILTER_PARAM, PAGE_PARAM, PAGE_SIZE, queryOf } from "~/lib/paging";
import { membershipContext, notFound } from "~/organisations/membership.server";
import { destination } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { EmptySheet, PageHeading, PageLead } from "~/shell/PageHeading";
import { TeamTabs } from "~/teams/TeamTabs";
import { WEEK_PARAM } from "~/teams/words";
import { formatDuration } from "~/time/format";

import type { Route } from "./+types/allocation";
import { useOrganisation } from "./useOrganisation";

// Team › Allocation (TS-116, decision 78): people by week, four weeks from the
// week asked for. Each week of a person says their schedule, what leave and
// public holidays leave of it, what their time shares plan on each project
// beside what they tracked, and, in words, whether that over- or
// under-allocates them. Filtered by team, client and project, and by name;
// fifty people a page, as Team lists them. `app/allocations/view.server.ts`
// decides who sees whom.

const { label } = destination("team");

export function meta() {
	return [{ title: `Allocation · ${label} · Timesifier` }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const view = await allocationView(
		context.get(membershipContext),
		new URL(request.url),
		Date.now(),
	);
	if (!view) throw notFound();
	return view;
}

/** Minutes as hours and minutes: 450 is "7:30". */
function hours(minutes: number): string {
	return formatDuration(minutes * 60);
}

export default function Allocation({ loaderData }: Route.ComponentProps) {
	const organisation = useOrganisation();
	const { weeks, people, page, everyone, filters, seesTeam } = loaderData;
	/** The rest of the address to keep, as `&q=…`, without the week. */
	const kept = {
		[TEAM_PARAM]: filters.team,
		[CLIENT_PARAM]: filters.client,
		[PROJECT_PARAM]: filters.project,
		[FILTER_PARAM]: filters.q,
	};
	const at = (week: string, number = 1) =>
		queryOf({ [WEEK_PARAM]: week, ...kept, [PAGE_PARAM]: number > 1 ? number : null });
	const first = weeks[0];
	const last = weeks.at(-1);
	const range = first && last ? `${first.label} to ${last.label}` : "";
	const narrowed = filters.team || filters.client || filters.project || filters.q;
	return (
		<>
			<PageHeading>{seesTeam ? label : "Allocation"}</PageHeading>
			<PageLead>
				Each person's schedule by week, what their time shares plan on each project, and what they
				tracked.
			</PageLead>
			{seesTeam && <TeamTabs slug={organisation.slug} current="allocation" />}
			<div className="mt-6 max-w-200">
				<PeriodStepper
					label="Weeks"
					period={range}
					previous={{ to: at(loaderData.previous), label: "Previous week" }}
					next={{ to: at(loaderData.next), label: "Next week" }}
					current={
						loaderData.shownFrom === loaderData.current
							? undefined
							: { to: at(loaderData.current), label: "This week" }
					}
				/>
			</div>
			<div className="mt-6 max-w-200">
				<FilterBar name="Filter people" keep={{ [WEEK_PARAM]: loaderData.shownFrom }}>
					<FilterField label="Search people" param={FILTER_PARAM} />
					{filters.teams.length > 0 && (
						<ChoiceField
							label="Team"
							param={TEAM_PARAM}
							all="Every team"
							options={filters.teams}
							chosen={filters.team}
						/>
					)}
					{filters.clients.length > 0 && (
						<ChoiceField
							label="Client"
							param={CLIENT_PARAM}
							all="Every client"
							options={filters.clients}
							chosen={filters.client}
						/>
					)}
					{filters.projects.length > 0 && (
						<ChoiceField
							label="Project"
							param={PROJECT_PARAM}
							all="Every project"
							options={filters.projects}
							chosen={filters.project}
						/>
					)}
				</FilterBar>
			</div>
			{people.length === 0 ? (
				<EmptySheet heading={range}>
					{everyone === 0
						? "Nobody is yours to see here yet. People with a time share of a project you lead, or in a team you manage, are listed here."
						: "Nobody matches these filters."}{" "}
					{narrowed && everyone > 0 && (
						<Link to={`?${WEEK_PARAM}=${loaderData.shownFrom}`} className={TEXT_LINK}>
							Show everyone
						</Link>
					)}
				</EmptySheet>
			) : (
				<div className="mt-6">
					<Ledger
						heading={range}
						note={
							narrowed
								? `${page.total} of ${everyone}`
								: `${everyone} ${everyone === 1 ? "person" : "people"}`
						}
					>
						<LedgerRows label="People by week">
							{people.map((person) => (
								<LedgerRow
									key={person.id}
									title={<span className="wrap-anywhere">{person.name}</span>}
									detail={person.address}
								>
									<ol
										aria-label={`${person.name}'s weeks`}
										className="mt-3 grid gap-3 @lg:grid-cols-2 @5xl:grid-cols-4"
									>
										{person.weeks.map((week) => (
											<li
												key={week.startsOn}
												className="rounded-medium bg-surface-container-low px-4 py-3"
											>
												<p className="text-label-large">{week.label}</p>
												<p
													className={cx(
														"mt-1 text-title-small",
														week.load.kind === "over" && "text-error",
														week.load.kind === "under" && "text-on-surface-variant",
													)}
													data-load={week.load.kind}
												>
													{week.load.words}
												</p>
												<p className="mt-1 text-body-medium tabular-nums">
													Schedule {hours(week.scheduled)}
													{week.available < week.scheduled
														? ` · ${hours(week.available)} after leave and holidays`
														: ""}
												</p>
												<p className="text-body-medium tabular-nums">
													Planned {hours(week.planned)} · Tracked {formatDuration(week.tracked)}
												</p>
												{(week.lines.length > 0 || week.otherPlanned > 0) && (
													<ul className="mt-2 space-y-1 text-body-small text-on-surface-variant tabular-nums">
														{week.lines.map((line) => (
															<li key={line.name} className="wrap-anywhere">
																{planLine(line.name, line.planned, line.tracked)}
															</li>
														))}
														{week.otherPlanned > 0 && (
															<li>Other projects: {hours(week.otherPlanned)} planned</li>
														)}
													</ul>
												)}
											</li>
										))}
									</ol>
								</LedgerRow>
							))}
						</LedgerRows>
					</Ledger>
					{page.pages > 1 && (
						<div className="mt-4">
							<Pager
								label="Pages of people"
								first={page.first}
								shown={people.length}
								total={page.total}
								size={PAGE_SIZE}
								previous={page.number > 1 ? at(loaderData.shownFrom, page.number - 1) : null}
								next={page.number < page.pages ? at(loaderData.shownFrom, page.number + 1) : null}
							/>
						</div>
					)}
				</div>
			)}
		</>
	);
}

/**
 * One filter of the bar, applied as soon as it is chosen, as Team's order is
 * (TS-125): its value goes into the address, which "every" leaves out.
 */
function ChoiceField({
	label: fieldLabel,
	param,
	all,
	options,
	chosen,
}: {
	label: string;
	param: string;
	all: string;
	options: { id: string; label: string }[];
	chosen: string | null;
}) {
	const apply = useApplyFilters();
	const [value, setValue] = useState(chosen ?? "");
	// The address changed (applied, Back, a link): show what it holds.
	useEffect(() => setValue(chosen ?? ""), [chosen]);
	return (
		<div className="min-w-0 grow basis-44">
			<Select
				label={fieldLabel}
				options={[{ id: "", label: all }, ...options]}
				value={value}
				onChange={(id) => {
					setValue(id ?? "");
					// The hidden field holds the new value once React has drawn it.
					setTimeout(apply, 0);
				}}
			/>
			<input type="hidden" name={param} value={value} />
		</div>
	);
}
