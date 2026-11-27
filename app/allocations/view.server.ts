import { env } from "cloudflare:workers";
import { and, gte, isNull, lte, or } from "drizzle-orm";

import { among, type OrganisationScope, organisationScope } from "~/db";
import { codedName } from "~/lib/codes";
import { filterOf, matchingPeople, type Page, pageNumberOf, pageOf } from "~/lib/paging";
import { isAdministrator } from "~/organisations/access";
import { accessOf } from "~/organisations/access.server";
import type { Membership } from "~/organisations/membership.server";
import { periodAfter, periodContaining } from "~/periods/periods";
import { sumsOf } from "~/reports/sums.server";
import { peopleOf } from "~/teams/people.server";
import { managedTeams, teamsWithMembers } from "~/teams/teams.server";
import { dayParam, periodLabel, WEEK_PARAM } from "~/teams/words";
import { addDays, type Day, dayOf } from "~/time/calendar";
import { zoneOfMember } from "~/time/zones.server";

import { type LoadKind, loadOf, type Share, shareLine } from "./allocations";
import { allocatorOf, plansOf, shareSightOf, sharesOf, total } from "./allocations.server";

// Team › Allocation (TS-116, decision 78): people by week, four weeks at a
// time. Each week of a person shows their schedule, what they have available
// after leave and public holidays, what each of their time shares plans on
// each project, what they tracked, and whether that over- or under-allocates
// them, in words. Owners and admins see everyone; a line manager the people
// in their teams; a delivery manager, or a client's account manager, the
// people with a share of, or on the team of, the projects they lead or
// manage: of another project, they see only that it plans so much ("Other
// projects"), which the flag needs. Fifty people a page, as Team lists them.
// Whatever the number of people, the page reads a fixed number of
// statements: the shares in one, the time in one SQL sum.

/** How many weeks the view shows from the week asked for. */
export const WEEKS_SHOWN = 4;

/** The filters in the address. */
export const TEAM_PARAM = "team";
export const CLIENT_PARAM = "client";
export const PROJECT_PARAM = "project";

export interface AllocationLine {
	/** The project and, where the line is one, its work package: "GLX-001 · Site › WP2". */
	name: string;
	planned: number;
	/** Seconds tracked on it. */
	tracked: number;
}

export interface AllocationWeek {
	startsOn: Day;
	label: string;
	scheduled: number;
	available: number;
	planned: number;
	/** Seconds tracked on the projects the viewer sees of the person. */
	tracked: number;
	load: { kind: LoadKind; words: string };
	lines: AllocationLine[];
	/** What the shares of projects the viewer does not see plan, in minutes; 0 for none. */
	otherPlanned: number;
}

export interface AllocationPerson {
	id: string;
	name: string;
	address: string | null;
	weeks: AllocationWeek[];
}

export interface AllocationView {
	weeks: { startsOn: Day; label: string }[];
	/** The first day of the weeks before, after and the current one, for the stepper. */
	previous: Day;
	next: Day;
	current: Day;
	shownFrom: Day;
	people: AllocationPerson[];
	page: Omit<Page<unknown>, "items">;
	/** How many people the viewer sees before any filter. */
	everyone: number;
	filters: {
		team: string | null;
		client: string | null;
		project: string | null;
		q: string;
		teams: { id: string; label: string }[];
		clients: { id: string; label: string }[];
		projects: { id: string; label: string }[];
	};
	/** Whether the viewer sees Team's other tabs: they manage a team, or are an owner or admin. */
	seesTeam: boolean;
}

/**
 * The view as `membership` is shown it, or null for a viewer with nobody to
 * see: not an owner or admin, managing no team, leading and managing no
 * project.
 */
export async function allocationView(
	membership: Membership,
	url: URL,
	now: number,
): Promise<AllocationView | null> {
	const { organisation } = membership;
	const scope = organisationScope(env.DB, organisation.id);
	const params = url.searchParams;
	const zone = await zoneOfMember(membership);
	const today = dayOf(now, zone);
	const access = await accessOf(membership);
	const allocator = await allocatorOf(
		scope,
		{ userId: membership.user.id, role: membership.role },
		today,
	);
	const sight = await shareSightOf(scope, access, allocator);
	const administrator = isAdministrator(membership.role);
	if (!administrator && access.managed.size === 0 && sight.projects.size === 0) return null;

	const current = periodContaining(today, organisation.weekStartsOn);
	const asked = dayParam(params.get(WEEK_PARAM));
	const shown = asked ? periodContaining(asked, organisation.weekStartsOn) : current;
	const first = shown.startsOn;
	const last = addDays(first, WEEKS_SHOWN * 7 - 1);
	const weeks = Array.from({ length: WEEKS_SHOWN }, (_, n) => {
		const week = periodAfter(shown, n);
		return { startsOn: week.startsOn, endsOn: week.endsOn, label: periodLabel(week) };
	});

	// Who the viewer sees, and the projects they may filter by.
	const [everyone, projects, clients, overseen] = await Promise.all([
		peopleOf(scope, organisation),
		scope.projects.select(),
		scope.clients.select(),
		administrator ? undefined : peopleOnProjects(scope, [...sight.projects], first, last),
	]);
	const seen = administrator
		? everyone
		: everyone.filter((p) => access.managed.has(p.id) || overseen?.has(p.id));
	const visibleProjects = projects.filter(
		(p) =>
			p.archivedAt === null &&
			(administrator || sight.projects.has(p.id) || access.managed.size > 0),
	);

	// The filters, each kept only when it names something the viewer may filter by.
	const teamChoices = await (administrator
		? teamsWithMembers(scope)
		: managedTeams(scope, membership.user.id).then((ids) => teamsWithMembers(scope, ids)));
	const team = teamChoices.find((t) => t.id === params.get(TEAM_PARAM)) ?? null;
	const projectsById = new Map(projects.map((p) => [p.id, p]));
	const clientIds = new Set(visibleProjects.map((p) => p.clientId).filter((id) => id !== null));
	const clientChoices = clients.filter((c) => clientIds.has(c.id));
	const client = clientChoices.find((c) => c.id === params.get(CLIENT_PARAM)) ?? null;
	const project = visibleProjects.find((p) => p.id === params.get(PROJECT_PARAM)) ?? null;
	const narrowedTo: string[] | null = project
		? [project.id]
		: client
			? visibleProjects.filter((p) => p.clientId === client.id).map((p) => p.id)
			: null;

	let listed = seen;
	if (team) {
		const members = new Set(team.members.map((m) => m.userId));
		listed = listed.filter((p) => members.has(p.id));
	}
	if (narrowedTo) {
		const on = await peopleOnProjects(scope, narrowedTo, first, last);
		listed = listed.filter((p) => on.has(p.id));
	}
	const q = filterOf(params);
	const page = pageOf(matchingPeople(listed, q), pageNumberOf(params));
	const ids = page.items.map((p) => p.id);

	const [plans, tracked, packages] = await Promise.all([
		plansOf(scope, ids, first, last, organisation.weekStartsOn),
		ids.length === 0
			? Promise.resolve({ days: [] })
			: sumsOf(
					{ scope, days: { first, last }, people: { everyone: false, people: ids }, now },
					{ byDay: "day-person-and-line" },
				),
		scope.workPackages.select(),
	]);
	const packagesById = new Map(packages.map((w) => [w.id, w]));
	const lineName = (projectId: string, workPackageId: string | null) => {
		const p = projectsById.get(projectId);
		const name = p ? codedName(p.code, p.name) : "A project";
		const wp = workPackageId ? packagesById.get(workPackageId) : undefined;
		return wp ? `${name} › ${wp.code}` : name;
	};
	const inFilter = (projectId: string) => narrowedTo === null || narrowedTo.includes(projectId);

	const people = page.items.map((person) => {
		const plan = plans.get(person.id);
		const full = sight.everyone || sight.people.has(person.id);
		const shows = (projectId: string) =>
			(full || sight.projects.has(projectId)) && inFilter(projectId);
		return {
			id: person.id,
			name: person.name,
			address: person.address,
			weeks: weeks.map((week, n) => {
				// The plan's days run from the first week's first day, seven a week.
				const from = n * 7;
				const span = (minutes: readonly number[]) => total(minutes.slice(from, from + 7));
				const lines = new Map<string, AllocationLine>();
				let planned = 0;
				let otherPlanned = 0;
				for (const { share, planned: byDay } of plan?.shares ?? []) {
					const minutes = span(byDay);
					planned += minutes;
					if (!shows(share.projectId)) {
						otherPlanned += minutes;
						continue;
					}
					const key = shareLine(share);
					const line = lines.get(key) ?? {
						name: lineName(share.projectId, share.workPackageId),
						planned: 0,
						tracked: 0,
					};
					line.planned += minutes;
					lines.set(key, line);
				}
				let seenTracked = 0;
				for (const sum of tracked.days) {
					if (sum.entry.userId !== person.id) continue;
					if (sum.day < week.startsOn || sum.day > week.endsOn) continue;
					if (!shows(sum.entry.projectId)) continue;
					const key = shareLine({
						projectId: sum.entry.projectId,
						workPackageId: sum.entry.workPackageId,
					});
					const line = lines.get(key) ?? {
						name: lineName(sum.entry.projectId, sum.entry.workPackageId),
						planned: 0,
						tracked: 0,
					};
					line.tracked += sum.minutes * 60;
					lines.set(key, line);
					seenTracked += sum.minutes * 60;
				}
				const available = plan ? span(plan.available) : 0;
				return {
					startsOn: week.startsOn,
					label: week.label,
					scheduled: plan ? span(plan.scheduled) : 0,
					available,
					planned,
					tracked: seenTracked,
					load: loadOf(planned, available),
					lines: [...lines.values()].sort((a, b) => a.name.localeCompare(b.name, "en")),
					otherPlanned,
				};
			}),
		};
	});

	const { items: _, ...pageFigures } = page;
	return {
		weeks: weeks.map(({ startsOn, label }) => ({ startsOn, label })),
		previous: periodAfter(shown, -1).startsOn,
		next: periodAfter(shown, 1).startsOn,
		current: current.startsOn,
		shownFrom: first,
		people,
		page: pageFigures,
		everyone: seen.length,
		filters: {
			team: team?.id ?? null,
			client: client?.id ?? null,
			project: project?.id ?? null,
			q,
			teams: teamChoices.map((t) => ({ id: t.id, label: t.name })),
			clients: clientChoices.map((c) => ({ id: c.id, label: c.name })),
			projects: visibleProjects
				.map((p) => ({ id: p.id, label: codedName(p.code, p.name) }))
				.sort((a, b) => a.label.localeCompare(b.label, "en")),
		},
		seesTeam: administrator || membership.managesTeams,
	};
}

/**
 * The people with a time share of, or a stretch on the team of, any of
 * `projectIds` on a day from `first` to `last`: two statements, whatever the
 * number of projects.
 */
async function peopleOnProjects(
	scope: OrganisationScope,
	projectIds: readonly string[],
	first: Day,
	last: Day,
): Promise<Set<string>> {
	if (projectIds.length === 0) return new Set();
	const [shares, stretches] = await Promise.all([
		sharesOf(scope, { projectIds, first, last }),
		scope.projectMembers.select((m) =>
			and(
				among(m.projectId, projectIds),
				lte(m.startsOn, last),
				or(isNull(m.endsOn), gte(m.endsOn, first)),
			),
		),
	]);
	return new Set([...shares.map((s: Share) => s.userId), ...stretches.map((s) => s.userId)]);
}
