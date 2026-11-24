import { use } from "react";

import { projectAndPackage } from "~/projects/work-packages";
import { TrackChoicesContext } from "~/tasks/track";

import type { ProjectName } from "./timesheet.server";

/**
 * How the Timesheet's views name an entry's project and work package (TS-115b):
 * "ACME-001 · Website rebuild › WP2 Build", or the project alone. The work
 * packages are Track time's choices, which name every one, closed and archived
 * too; an entry whose work package is not among them is named by its project.
 */
export function useEntryName(
	projects: readonly ProjectName[],
): (projectId: string, workPackageId?: string | null) => string {
	const choices = use(TrackChoicesContext);
	return (projectId, workPackageId = null) => {
		const project = projects.find((p) => p.id === projectId);
		if (!project) return "";
		const wp =
			workPackageId === null
				? null
				: ((choices?.workPackages[projectId] ?? []).find((each) => each.id === workPackageId) ??
					null);
		return projectAndPackage(project, wp);
	};
}

/** Whether `workPackageId` of `projectId` is closed or archived, so takes no new time. */
export function useClosedPackage(): (projectId: string, workPackageId: string | null) => boolean {
	const choices = use(TrackChoicesContext);
	return (projectId, workPackageId) =>
		workPackageId !== null &&
		(choices?.workPackages[projectId] ?? []).some((wp) => wp.id === workPackageId && !wp.open);
}
