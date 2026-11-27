import { shareLine } from "~/allocations/allocations";
import {
	allocatorOf,
	plansOf,
	sees,
	shareSightOf,
	sharesOf,
	total,
} from "~/allocations/allocations.server";
import { among } from "~/db";
import { codedName } from "~/lib/codes";
import { projectAndPackage } from "~/projects/work-packages";
import { formatDuration } from "~/time/format";

import type { ReportRequest } from "./reports.server";
import { sumsOf } from "./sums.server";

/**
 * The Planned view of Reports (TS-116, docs/decisions.md entry 78): over a
 * range, what each person's time shares plan against what they tracked, by
 * person and by project. A person's plan is read from their work schedule
 * less public holidays and approved leave (`plansOf`), in whole minutes a
 * day; what they tracked is the report's sums (`sumsOf`), one statement
 * whatever the number of people. The report holds the people it covers and,
 * of their shares, only those the viewer sees (`ShareSight`), so the time of
 * a person it does not cover never shows. Every minute planned or tracked
 * counts on one person's line and on one project's line, so each grouping
 * adds up to the same total.
 *
 * Tracked time counts against the line of the person's own share: a project's
 * work package where their share names it, else the project. Time tracked
 * where the person has no share counts against its project, with nothing
 * planned, so the report shows work done off the plan as well as on it.
 */

/** What a line planned and what was tracked against it, in whole minutes. */
export interface PlanFigures {
	plannedMinutes: number;
	trackedMinutes: number;
}

/** One person's plan against their time. */
export interface PersonPlanLine extends PlanFigures {
	id: string;
	name: string;
	/** Their address, shown under the name when they have given none. */
	address: string | null;
}

/** One project's plan against its time, or one of its work packages' where a share names it. */
export interface WorkPlanLine extends PlanFigures {
	/** The project's id, or the project's and work package's (`shareLine`). */
	key: string;
	/** "ACME-001 · Website", or "ACME-001 · Website › WP2 Build". */
	label: string;
	/** Whether any share shown plans this line; a line of time alone has none. */
	shared: boolean;
}

export interface PlannedReport {
	people: PersonPlanLine[];
	work: WorkPlanLine[];
	total: PlanFigures;
}

/** What `tracked` minutes come to against `planned`: "3:00 over plan", "2:30 under plan" or "On plan". */
export function planDifference({ plannedMinutes, trackedMinutes }: PlanFigures): string {
	const difference = trackedMinutes - plannedMinutes;
	if (difference === 0) return "On plan";
	return `${formatDuration(Math.abs(difference) * 60)} ${difference > 0 ? "over" : "under"} plan`;
}

const NOTHING: PlanFigures = { plannedMinutes: 0, trackedMinutes: 0 };

export async function plannedReport(request: ReportRequest): Promise<PlannedReport> {
	const { scope, access, people, choices, days, today, weekStartsOn } = request;
	const covered = people.everyone ? choices : choices.filter((c) => people.people.includes(c.id));
	if (covered.length === 0) return { people: [], work: [], total: { ...NOTHING } };
	const ids = covered.map((person) => person.id);

	const [{ sums }, read, sight] = await Promise.all([
		sumsOf(request),
		sharesOf(scope, { userIds: ids, first: days.first, last: days.last }),
		allocatorOf(scope, { userId: access.userId, role: access.role }, today).then((allocator) =>
			shareSightOf(scope, access, allocator),
		),
	]);
	const shares = read.filter((share) => sees(sight, share));
	const projectIds = [...new Set(shares.map((share) => share.projectId))];
	const packageIds = [
		...new Set(shares.flatMap((share) => (share.workPackageId ? [share.workPackageId] : []))),
	];
	const [plans, projects, packages] = await Promise.all([
		plansOf(scope, ids, days.first, days.last, weekStartsOn, shares),
		projectIds.length > 0 ? scope.projects.select((p) => among(p.id, projectIds)) : [],
		packageIds.length > 0 ? scope.workPackages.select((wp) => among(wp.id, packageIds)) : [],
	]);
	const projectsById = new Map(projects.map((p) => [p.id, p]));
	const packagesById = new Map(packages.map((wp) => [wp.id, wp]));

	const byPerson = new Map<string, PlanFigures & { shared: boolean }>();
	const byLine = new Map<string, WorkPlanLine>();
	const personOf = (userId: string) => {
		const figures = byPerson.get(userId) ?? { ...NOTHING, shared: false };
		byPerson.set(userId, figures);
		return figures;
	};
	const lineOf = (key: string, label: () => string) => {
		const line = byLine.get(key) ?? { key, label: label(), ...NOTHING, shared: false };
		byLine.set(key, line);
		return line;
	};

	// What each share plans, on the person's line and on the share's.
	const planned = new Set<string>();
	for (const plan of plans.values()) {
		for (const { share, planned: minutes } of plan.shares) {
			const key = shareLine(share);
			planned.add(`${share.userId} ${key}`);
			const sum = total(minutes);
			const person = personOf(share.userId);
			person.plannedMinutes += sum;
			person.shared = true;
			const line = lineOf(key, () => {
				const project = projectsById.get(share.projectId);
				const wp = share.workPackageId ? packagesById.get(share.workPackageId) : undefined;
				return projectAndPackage(
					{ code: project?.code, name: project?.name ?? "" },
					wp ? { code: wp.code, name: wp.name } : null,
				);
			});
			line.plannedMinutes += sum;
			line.shared = true;
		}
	}

	// What each person tracked, against their share's line where they have one.
	const shown = new Set(ids);
	for (const { entry, minutes } of sums) {
		if (!shown.has(entry.userId) || minutes === 0) continue;
		personOf(entry.userId).trackedMinutes += minutes;
		const ownPackage =
			entry.workPackageId !== null &&
			planned.has(`${entry.userId} ${shareLine(entry)}`) &&
			entry.workPackageId;
		const key = ownPackage ? shareLine(entry) : entry.projectId;
		const line = lineOf(key, () =>
			ownPackage
				? projectAndPackage(
						{ code: entry.projectCode, name: entry.project },
						{ code: entry.workPackageCode ?? "", name: entry.workPackage ?? "" },
					)
				: codedName(entry.projectCode, entry.project),
		);
		line.trackedMinutes += minutes;
	}

	const lines = covered.flatMap((person) => {
		const figures = byPerson.get(person.id);
		if (!figures || (!figures.shared && figures.trackedMinutes === 0)) return [];
		return [
			{
				id: person.id,
				name: person.name,
				address: person.address,
				plannedMinutes: figures.plannedMinutes,
				trackedMinutes: figures.trackedMinutes,
			},
		];
	});
	return {
		people: lines,
		work: [...byLine.values()].sort(
			(a, b) => a.label.localeCompare(b.label, "en") || (a.key < b.key ? -1 : 1),
		),
		total: {
			plannedMinutes: lines.reduce((sum, line) => sum + line.plannedMinutes, 0),
			trackedMinutes: lines.reduce((sum, line) => sum + line.trackedMinutes, 0),
		},
	};
}
