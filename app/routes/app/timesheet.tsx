import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";

import { cx } from "~/components/cx";
import { membershipContext } from "~/organisations/membership.server";
import { DoneMark } from "~/routes/auth/AuthPage";
import { destination, invitationsPath, WELCOME_PARAM } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading } from "~/shell/PageHeading";
import { finishRunningTransition } from "~/shell/transitions";
import { timesheetAction } from "~/timesheet/actions.server";
import { DayView } from "~/timesheet/DayView";
import { HistoryView } from "~/timesheet/HistoryView";
import { timesheetData } from "~/timesheet/timesheet.server";
import { VIEW_LABELS, VIEWS, viewPath } from "~/timesheet/views";
import { chosenView } from "~/timesheet/views.server";
import { WeekView } from "~/timesheet/WeekView";

import type { Route } from "./+types/timesheet";
import { useOrganisation } from "./useOrganisation";

// Timesheet, under Track: the person's own time (docs/navigation.md). Its Day
// view is the timer and the day's entries, its Week view the grid of projects
// by days with "Submit week" at its foot, and History the person's periods.
// Each view is this destination's address with a query (`timesheet/views.ts`),
// and each shows the caller's own time alone, whatever their role.

const { label } = destination("timesheet");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

/**
 * The view the address asks for, read at the time of the request. Whether the
 * person has just created this organisation, their first: the page that
 * creates it sends them here with a mark on the address. Only its owner is
 * welcomed to it.
 */
export async function loader({ url, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const chosen = chosenView(url.searchParams, membership.organisation.weekStartsOn);
	return {
		welcome: url.searchParams.has(WELCOME_PARAM) && membership.role === "owner",
		data: await timesheetData(membership, chosen, Date.now()),
	};
}

/** The timer, entries by hand, a cell of the grid and a week's submission (`timesheet/actions.server.ts`). */
export async function action({ request, context }: Route.ActionArgs) {
	return timesheetAction(request, context.get(membershipContext));
}

export default function Timesheet({ loaderData }: Route.ComponentProps) {
	const { data } = loaderData;
	const organisation = useOrganisation();
	// The moment is marked once. The mark comes off the address at once, so that
	// reloading the page or coming back to it does not mark it again, and the
	// welcome stays until the person leaves the page.
	const [welcome] = useState(loaderData.welcome);
	const navigate = useNavigate();
	const { pathname } = useLocation();
	useEffect(() => {
		if (loaderData.welcome) navigate(pathname, { replace: true, preventScrollReset: true });
	}, [loaderData.welcome, navigate, pathname]);

	return (
		<>
			<PageHeading>{label}</PageHeading>
			{welcome && (
				<div className="mt-10 flex max-w-160 items-start gap-4">
					<DoneMark />
					<div>
						<p className="text-title-medium">{organisation.name} is ready</p>
						<p className="mt-1 text-body-large text-on-surface-variant">
							You are its owner. When you want company,{" "}
							<Link to={invitationsPath(organisation.slug)} className={TEXT_LINK}>
								invite the people you work with
							</Link>
							.
						</p>
					</div>
				</div>
			)}

			{/* The views, as links: each is an address of its own. */}
			<nav
				aria-label="Timesheet views"
				className="mt-6 flex max-w-200 border-b border-outline-variant"
			>
				{VIEWS.map((view) => {
					const isCurrent = data.view === view;
					return (
						<Link
							key={view}
							to={viewPath(organisation.slug, view)}
							onClick={finishRunningTransition}
							aria-current={isCurrent ? "page" : undefined}
							className={cx(
								"relative flex h-12 flex-1 items-center justify-center px-4 text-title-small outline-none state-layer transition-control hover:state-hover focus-visible:focus-indicator-inner",
								isCurrent ? "text-primary" : "text-on-surface-variant hover:text-on-surface",
							)}
						>
							{VIEW_LABELS[view]}
							{isCurrent && (
								<span
									aria-hidden="true"
									className="absolute inset-x-4 bottom-0 h-0.75 rounded-t-full bg-primary"
								/>
							)}
						</Link>
					);
				})}
			</nav>

			{data.view === "day" && <DayView data={data} slug={organisation.slug} />}
			{data.view === "week" && <WeekView data={data} slug={organisation.slug} />}
			{data.view === "history" && <HistoryView data={data} slug={organisation.slug} />}
		</>
	);
}
