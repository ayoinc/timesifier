import { env } from "cloudflare:workers";
import { useEffect, useState } from "react";
import { data, Link, useLocation, useNavigate } from "react-router";

import { alertBudgetsAfter } from "~/budgets/alerts.server";
import { cx } from "~/components/cx";
import { organisationScope } from "~/db";
import { membershipContext } from "~/organisations/membership.server";
import { DoneMark } from "~/routes/auth/AuthPage";
import { destination, invitationsPath, WELCOME_PARAM } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading } from "~/shell/PageHeading";
import { finishRunningTransition } from "~/shell/transitions";
import { TrackChoicesContext } from "~/tasks/track";
import { trackChoices } from "~/tasks/track.server";
import { timesheetAction } from "~/timesheet/actions.server";
import { CalendarView } from "~/timesheet/CalendarView";
import { DayView } from "~/timesheet/DayView";
import { markCookie, readMarks } from "~/timesheet/getting-started.server";
import { HistoryView } from "~/timesheet/HistoryView";
import { timesheetData } from "~/timesheet/timesheet.server";
import { VIEW_LABELS, VIEWS, viewPath } from "~/timesheet/views";
import { chosenView } from "~/timesheet/views.server";
import { WeekView } from "~/timesheet/WeekView";

import type { Route } from "./+types/timesheet";
import { useOrganisation } from "./useOrganisation";

// Timesheet, under Track: the person's own time (docs/navigation.md). Its Day
// view is "Track time", the period's days and the day's entries; its Week view
// the grid of projects by days; its Calendar the week on an hour axis or the
// month of days (TS-062); and History the person's periods. Day, Week and the
// week calendar share one header row, with "Submit week" at its right end
// (`timesheet/Submission.tsx`), and each shows the limits of its days (TS-090).
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
 *
 * The first time a person opens the Week view, their browser keeps a mark of
 * it, which ticks "Open the week" in getting started (TS-056).
 */
export async function loader({ request, url, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const chosen = chosenView(url.searchParams, membership.organisation.weekStartsOn);
	const cookie = request.headers.get("Cookie");
	const marks = readMarks(cookie, membership.user.id);
	const sheet = await timesheetData(membership, chosen, Date.now(), marks);
	const shown = "entries" in sheet ? sheet.entries.map((e) => e.id) : [];
	const page = {
		welcome: url.searchParams.has(WELCOME_PARAM) && membership.role === "owner",
		data: sheet,
		// The tasks, tags and budget warnings Track time and an entry's sheet offer (TS-066, TS-085, TS-069).
		track: await trackChoices(
			organisationScope(env.DB, membership.organisation.id),
			membership,
			shown,
			Date.now(),
		),
	};
	if (chosen.view !== "week" || marks.week) return page;
	return data(page, {
		headers: { "Set-Cookie": markCookie(cookie, membership.user.id, "week") },
	});
}

/** Track time, the timer's Stop, entries by hand, a cell of the grid, a week's submission and getting started (`timesheet/actions.server.ts`). */
export async function action({ request, context }: Route.ActionArgs) {
	const membership = context.get(membershipContext);
	const since = Date.now();
	const outcome = await timesheetAction(request, membership);
	// A change that takes a project past its budget alert tells those who look after it (TS-069).
	await alertBudgetsAfter(membership, since, new URL(request.url).origin);
	return outcome;
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

			{/* The views, as links: each is an address of its own. A group, not a
			    landmark: the shell has one navigation landmark, the main one. */}
			<fieldset className="mt-6 flex max-w-200 border-b border-outline-variant">
				<legend className="sr-only">Timesheet views</legend>
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
			</fieldset>

			<TrackChoicesContext value={loaderData.track}>
				{data.view === "day" && <DayView data={data} slug={organisation.slug} />}
				{data.view === "week" && <WeekView data={data} slug={organisation.slug} />}
				{data.view === "calendar" && <CalendarView data={data} slug={organisation.slug} />}
				{data.view === "history" && <HistoryView data={data} slug={organisation.slug} />}
			</TrackChoicesContext>
		</>
	);
}
